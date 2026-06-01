# Audio-Auto — Complete Walkthrough & Bug Fix Guide

## What Was Fixed in This Update

### 🔴 Critical Bug: SPA Navigation Resets Audio
**Problem:** Navigating between pages (Dashboard → Scheduler → Dashboard) restarted the song from the beginning.  
**Root Cause:** `<audio id="localAudio">` was duplicated twice in `base.html` (lines 98 & 145). WaveSurfer was also being re-created on every page navigation.  
**Fix:** Removed the duplicate audio element. WaveSurfer is now a true singleton — created once and reused across all SPA page changes. The `globalWaveformContainer` div is physically moved into the current page's waveform slot.

---

### 🔴 Critical Bug: No Cross-Client Synchronization
**Problem:** Opening the web app on a phone while playing on a laptop started from 0:00. Play/pause/volume/seek didn't sync between clients.  
**Root Cause:** Server stored `position = 0` when play started and never advanced it. New WebSocket clients received stale position=0.  
**Fix:**
1. Server now stores `last_updated` (Unix timestamp when position was set).
2. `/api/state` returns `current_position = position + (now - last_updated) * speed`.
3. WebSocket on connect immediately sends full state to new clients.
4. Client computes `actualPosition = state.position + (state.server_time - state.last_updated) * speed`.

---

### 🔴 Critical Bug: Scheduler POST to Wrong URL
**Problem:** `spa.js` posted to `/api/schedule` but backend only had `/api/schedules`.  
**Fix:** Added `/api/schedule` as alias route + fixed SPA to POST JSON to `/api/schedules`.

---

### 🔴 Critical Bug: ESP32 Internal DAC "No Sound"
**Problem:** Wrong understanding of the Internal DAC vs PCM5102A wiring.

**Correct wiring for Internal DAC:**
```
AUX Tip   (Left)  → GPIO 25  (DAC1)
AUX Ring  (Right) → GPIO 26  (DAC2)
AUX Sleeve (GND)  → GND
```

The `audio.setPinout(26, 25, 22)` call is ONLY for external I2S (PCM5102A). For Internal DAC, the IDF handles the GPIO mapping internally. The library detects DAC mode differently.

> **⚠️ Recommended:** Use PCM5102A — it gives 32-bit stereo vs 8-bit mono-ish from the internal DAC.

---

### 🔴 Bug: Docker Build Failure
**Root Cause:** `libmariadb-dev` was installed for a C-extension `mariadb` driver not in `requirements.txt`.  
**Fix:** Removed from Dockerfile. `pymysql` is pure Python, no C build needed.

---

### 🟡 Bug: WaveSurfer loaded AFTER spa.js
**Fix:** Moved WaveSurfer CDN script to `<head>` so it's loaded before `spa.js`.

---

### 🟡 Bug: Single NTP Server
**Fix:** Now uses 3 servers: `pool.ntp.org`, `time.google.com`, `time.cloudflare.com`.

---

## Project Architecture

```
┌─────────────────────────────────────────────┐
│       Web Server (192.168.88.8:9876)         │
│   FastAPI + MariaDB + APScheduler            │
│  ┌─────────────┐  ┌──────────────────────┐  │
│  │  Scheduler  │  │  WebSocket /ws       │  │
│  │ (APSched)   │  │  (real-time sync)    │  │
│  └─────┬───────┘  └──────────┬───────────┘  │
│        │  Global Playback State              │
│        │  {audio_id, position, last_updated} │
└────────┼────────────────────────────────────┘
         │ MQTT (port 1883)
┌────────▼───────────────┐
│  MQTT Broker Mosquitto │
│  192.168.88.8:1883     │
└────┬──────────────┬────┘
     │              │
┌────▼──────┐  ┌────▼──────┐
│ ESP32-A   │  │ ESP32c3-B │
│ Int. DAC  │  │ PCM5102A  │
│ GPIO25/26 │  │ GPIO5/4/6 │
└───────────┘  └───────────┘
```

---

## Wiring Guide

### ESP32 Classic — Internal DAC

| AUX Plug | ESP32 GPIO | Function |
|----------|-----------|----------|
| Tip (Left) | GPIO **25** | DAC Channel 1 |
| Ring (Right) | GPIO **26** | DAC Channel 2 |
| Sleeve (GND) | GND | Ground |

Set `USE_INTERNAL_DAC = true` in the `.ino`.

### ESP32 Classic — PCM5102A I2S (Recommended)

| PCM5102A Pin | ESP32 GPIO | Notes |
|-------------|-----------|-------|
| BCK | GPIO **26** | Bit Clock |
| LCK / LRC | GPIO **25** | Word Clock |
| DIN | GPIO **22** | Serial Data |
| VCC | 3.3V or 5V | Power |
| GND | GND | Ground |
| SCK | GND | (MCLK not needed) |
| FMT | GND | I2S mode |
| XMT | 3.3V | Unmute |
| LOUT | AUX Tip | Left Channel |
| ROUT | AUX Ring | Right Channel |
| AGND | AUX Sleeve | Audio GND |

Set `USE_INTERNAL_DAC = false` in the `.ino`.

### ESP32-C3 — PCM5102A

| PCM5102A | GPIO |
|---------|------|
| BCK | **5** |
| LCK | **4** |
| DIN | **6** |

### ESP32-C6 — PCM5102A

| PCM5102A | GPIO |
|---------|------|
| BCK | **19** |
| LCK | **18** |
| DIN | **20** |

### Optional RTC (DS3231/DS1307)

| RTC | ESP32 | C3/C6 |
|----|-------|-------|
| SDA | GPIO 21 | GPIO 8 |
| SCL | GPIO 22* | GPIO 9 |

> ⚠️ On classic ESP32 with PCM5102A, GPIO 22 = I2S DATA. Move DIN to GPIO 18 and update `setPinout(26, 25, 18)` if using both.

---

## Arduino IDE Setup

### 1. Board Support
- File → Preferences → Additional URLs:
  ```
  https://raw.githubusercontent.com/espressif/arduino-esp32/gh-pages/package_esp32_index.json
  ```
- Tools → Board Manager → install **esp32 by Espressif Systems**

### 2. Libraries (Library Manager)
- PubSubClient by Nick O'Leary
- ArduinoJson by Benoit Blanchon

### 3. ESP32-audioI2S Library
Download from: https://github.com/schreibfaul1/ESP32-audioI2S  
Place as: `Arduino/Audio_Client/src/ESP32-audioI2S/`

### 4. Board Settings

| Chip | Board Name | Partition |
|------|-----------|-----------|
| ESP32 | ESP32 Dev Module | Huge APP (3MB No OTA) |
| ESP32-C3 | ESP32C3 Dev Module | Huge APP |
| ESP32-C6 | ESP32C6 Dev Module | Huge APP |

### 5. Flash Each Device
1. Open `Arduino/Audio_Client/Audio_Client.ino`
2. Set unique `DEVICE_NAME` (e.g. `ESP32-Ruang-A001`)
3. Set `USE_INTERNAL_DAC` appropriately
4. Upload!

Devices auto-register in the web dashboard on first MQTT connection.

---

## Docker Deployment

```bash
cd Web-Apps
docker compose up -d --build
```

Check logs:
```bash
docker compose logs -f web
docker compose logs -f db
```

Access: `http://192.168.88.8:9876`  
Login: `admin` / `admin123` (set via `ADMIN_PASS` in docker-compose.yml)

---

## Synchronization Design

All devices use **Unix timestamp coordination** for zero-delay sync:

1. Server issues `start_time = now + 2` when play is triggered
2. Broadcast to all ESP32s (MQTT) and browsers (WebSocket)
3. Each device waits until its clock hits `start_time`, then plays simultaneously
4. NTP sync ensures all clocks are identical

**Late-joiner position calculation:**
```
position_snapshot  = 120s  (stored when play started)
last_updated       = T0    (server time when play started)
new client joins   = T0 + 30s

actual_position = 120 + (T0+30 - T0) * 1.0 = 150s  ✓
```

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| No sound from Internal DAC | Verify GPIO25→AUX Tip, GPIO26→AUX Ring; try USE_INTERNAL_DAC=false + PCM5102A |
| Audio resets on page change | Hard refresh (Ctrl+Shift+R) to clear old spa.js cache |
| ESP32 not in Devices page | Open Serial Monitor — check MQTT connection log |
| Docker build fails | Ensure no `mariadb` package in requirements.txt |
| Scheduler doesn't fire | Verify `TZ=Asia/Jayapura` in docker-compose.yml |
| Phones out of sync | Check ESP32 NTP sync via Serial Monitor at startup |
| PCM5102A no sound | Check XMT=3.3V (unmute pin), FMT=GND, SCK=GND |

---

## MQTT Topic Reference

| Topic | Direction | Description |
|-------|-----------|-------------|
| `audioauto/commands/all` | Server → All ESP32 | Broadcast play/stop/seek |
| `audioauto/commands/{name}` | Server → One ESP32 | Targeted command |
| `audioauto/telemetry/{name}` | ESP32 → Server | IP, RSSI, temperature, state |
| `audioauto/log/{name}` | ESP32 → Server | Debug log text |
