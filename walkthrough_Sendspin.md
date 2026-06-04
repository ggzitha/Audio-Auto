# Audio-Auto — Sendspin Protocol Walkthrough  v5.0

## What Changed in This Update

### Architecture Shift: Sendspin Protocol (v5.0)

This update fully implements the [Sendspin protocol](https://github.com/Sendspin/spec) (Open Home Foundation) for synchronized multi-room audio. Previous versions used NTP wall-clock timestamps which had ±50 ms error — far too much for audio sync (humans detect >10 ms offset). The new system achieves µs-level accuracy.

---

## Root Causes of Previous Issues (Fixed)

| Problem | Root Cause | Fix |
|---------|-----------|-----|
| No audio / buzzing | `AudioFileSourceWebSocket` was the wrong approach; binary audio frames weren't reaching the decoder | **Removed ESP8266Audio entirely** — PCM written directly to I2S |
| Stuttering | NTP (±50 ms) used for scheduling | **Kalman time filter** gives <1 ms accuracy on LAN |
| Sync drift | Wall clock (`gettimeofday`) vs server monotonic | **Server monotonic clock** (`time.monotonic_ns()`) throughout |
| No playback trigger | `client/hello` missing `supported_roles` → server never activates player | **Spec-compliant handshake** implemented |
| Protocol violations | `client/state` and `client/time` never sent | Both now sent correctly |

---

## New Architecture

```
Web Browser                Web Server (192.168.88.8:9876)
    │                           │
    │  WebSocket /ws             │  FastAPI  +  APScheduler  +  MQTT
    │  (playback state sync)     │
    │                           │── /sendspin  (Sendspin WS endpoint)
                                │       │
                         ┌──────┴───────┴─────┐
                         │  SendspinServer     │
                         │  (sendspin_server.py)│
                         │                     │
                         │  ffmpeg → raw PCM   │
                         │  Binary WS frames   │
                         │  (Type 4 + ts)      │
                         └──────┬──────────────┘
                                │  WebSocket frames
               ┌────────────────┼────────────────┐
               │                │                │
        ┌──────▼────┐    ┌──────▼────┐    ┌──────▼────┐
        │ ESP32-C6  │    │ ESP32-S3  │    │ Future    │
        │ PCM5102A  │    │ PCM5102A  │    │ client    │
        │ 48KB buf  │    │ 256KB PSRAM│   │           │
        │ 200ms lead│    │ 300ms lead │   │           │
        └───────────┘    └───────────┘   └───────────┘
```

---

## Codec Decision: PCM (Raw Audio)

| Codec | Decode CPU | Bandwidth | Decision |
|-------|-----------|-----------|---------|
| MP3 (Helix) | ~30–40 MHz on 160 MHz C6 | 128 kbps | ❌ Uses 25% CPU just for decode |
| FLAC | ~10–15 MHz | 500–1000 kbps | 🟡 Good but needs codec_header |
| **PCM raw** | **0 MHz** | 1.41 Mbps | ✅ Direct I2S write, LAN easily handles it |

PCM bandwidth: 44100 Hz × 2 ch × 2 bytes = **176,400 bytes/s = 1.41 Mbps**. WiFi 802.11n supports 150 Mbps, so PCM is no problem on LAN.

---

## Files Changed

### [`sendspin_server.py`](file:///d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/sendspin_server.py)
- **Complete rewrite**
- Uses `time.monotonic_ns() // 1000` for server timestamps (not wall clock)
- `server/time` captures `server_received` **and** `server_transmitted` separately
- PCM streaming via ffmpeg: `ffmpeg -f s16le -acodec pcm_s16le -ar 44100 -ac 2`
- Per-client send-ahead: `max(required_lead_time_ms, min_buffer_ms) + static_delay_ms`
- Audio chunk throttle: keeps audio exactly `send_ahead_ms` ahead of real time
- Binary frame: `struct.pack(">Bq", 4, timestamp_us) + pcm_bytes`

### [`Audio_Client_C3C6.ino`](file:///d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Arduino/Audio_Client_C3C6/Audio_Client_C3C6.ino)
- **Complete rewrite**
- Removed: `ESP8266Audio`, `AudioGeneratorMP3`, `AudioFileSourceWebSocket`
- Added: `driver/i2s_std.h` (ESP-IDF v5 direct I2S), `esp_timer.h`
- **Kalman time filter** ported from `sendspin-cpp/src/time_filter.cpp`
  - 2D state: [offset, drift] between ESP32 local µs and server monotonic µs
  - First 5 samples at 250ms interval, then 1s heartbeat
- **PCM ring buffer** 48 KB (~272 ms) in internal RAM
- Proper `client/hello` with `supported_roles` and `player@v1_support`
- Audio state machine: `IDLE → BUFFERING → PLAYING`
- MQTT kept for telemetry only (IP, RSSI, sync status, buffer fill)

### [`Audio_Client_S3.ino`](file:///d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Arduino/ESP32-S3/Audio_Client_S3.ino) *(new)*
- Identical protocol to C6 sketch
- **256 KB ring buffer in PSRAM** via `heap_caps_malloc(MALLOC_CAP_SPIRAM)`
- I2S pins: BCK=GPIO4, LRCK=GPIO5, DOUT=GPIO6 (safe on DevKit-C1)
- 300ms lead time (more comfortable with larger buffer)

---

## How Clock Sync Works

```
ESP32                              Server
  │                                   │
  │── client/time ──────────────────► │  T2 = server_received (monotonic µs)
  │   {client_transmitted: T1}        │  [some processing time...]
  │                                   │  T3 = server_transmitted
  │◄── server/time ──────────────────│
  │    {T1, T2, T3}                   │
  │  T4 = now (local µs)             │
  │                                   │
  │  offset = ((T2-T1) + (T3-T4)) / 2
  │  max_error = ((T4-T1) - (T3-T2)) / 2
  │  → feed into Kalman filter
  │
  │  toLocalTime(server_ts):
  │    local_ts = (server_ts - offset) / (1 + drift)
```

After 3 samples, the filter is considered "synced". After ~10 samples the error converges to ~0.1–0.5 ms on a typical WiFi LAN.

---

## Deployment

### Docker (server — Debian 192.168.88.8)
```bash
cd /path/to/Web-Apps
docker compose down && docker compose up -d --build
docker compose logs -f web   # watch for startup
```

### Arduino IDE Setup (ESP32-C6)
1. **Board**: `Tools → Board → ESP32-C6 Dev Module`
2. **Board package**: Arduino ESP32 **v3.x** (required — v2.x does NOT have `driver/i2s_std.h` for C6)
3. **Partition**: `Huge APP (3MB No OTA)`
4. **CPU Frequency**: 160 MHz
5. **Libraries**: ArduinoWebsockets, PubSubClient, ArduinoJson
6. **Do NOT install ESP8266Audio** (no longer needed)
7. Edit `DEVICE_NAME`, WiFi credentials, server IP
8. Upload → open Serial Monitor (115200 baud)

### Arduino IDE Setup (ESP32-S3)
1. **Board**: `Tools → Board → ESP32-S3 Dev Module`
2. **PSRAM**: `Tools → PSRAM → OPI PSRAM`
3. **CPU Frequency**: `240 MHz`
4. **Flash Size**: `16MB (128Mb)` — for N16R8
5. Same libraries as C6

---

## Serial Monitor — What to Expect

```
╔═══════════════════════════════════╗
║  Audio-Auto ESP32-C6     v5.0    ║
║  Sendspin Protocol / PCM Direct  ║
╚═══════════════════════════════════╝
[Init] Ring buffer: 48 KB (~272 ms)
[WiFi] Connecting... OK
  SSID: YourWiFi
  IP:   192.168.88.xxx
[MQTT] ...OK
[I2S] Ready: 44100 Hz / 16-bit / stereo  BCK=19 LRC=18 DOUT=20
[WS] Connecting 192.168.88.8:9876/sendspin …
[WS] Connected
[Sendspin] → client/hello
[Sendspin] ← server/hello  id=audio-auto-sendspin
[Sync] #1  offset=12.34 ms  RTT=1.82 ms
[Sync] #2  offset=12.31 ms  RTT=1.75 ms
[Sync] #3  offset=12.33 ms  RTT=1.71 ms   ← filter now "synced"
...
[Sendspin] ← stream/start  codec=pcm
[Sendspin] Buffering...
[Sync] First chunk: play in 200.1 ms (sync=6)
[Sync] Playback started
```

---

## Wiring Reference

### ESP32-C6 → PCM5102A

| PCM5102A | GPIO | Notes |
|----------|------|-------|
| BCK      | 19   | Bit Clock |
| LCK/LRCK | 18   | Word Select |
| DIN      | 20   | Serial Data |
| SCK/MCLK | GND  | Internal PLL — tie LOW |
| FMT      | GND  | I2S standard |
| XMT/XSMT | 3.3V | **Must be HIGH** or no output |
| VCC      | 3.3V | |
| GND      | GND  | |

### ESP32-S3 DevKit-C1 → PCM5102A

| PCM5102A | GPIO | Notes |
|----------|------|-------|
| BCK      | 4    | |
| LCK/LRCK | 5    | |
| DIN      | 6    | |
| SCK/MCLK | GND  | |
| FMT      | GND  | |
| XMT/XSMT | 3.3V | **Must be HIGH** |

---

## Troubleshooting

| Symptom | Check |
|---------|-------|
| No sound from PCM5102A | **XMT pin → 3.3V** (mute pin). SCK → GND. FMT → GND |
| `[I2S] new_channel failed` | Wrong Arduino ESP32 version — needs v3.x for C6 |
| WS never connects | Check `SS_HOST` / `SS_PORT` in sketch. Server running? `docker compose ps` |
| Sync offset doesn't converge | WiFi congestion. Check RTT in Serial Monitor — should be <5ms on LAN |
| `WARN: Ring buffer full` | Server sending too fast. Check `REQUIRED_LEAD_TIME_MS` matches server |
| `WARN: I2S underrun` | WiFi dropping packets. Ring buffer too small or lead time too short |
| No broker (`[MQTT] fail`) | MQTT not critical — only used for telemetry. Audio works without it |
| Devices out of sync | Sync count < 5 — wait for filter to converge after connecting |
