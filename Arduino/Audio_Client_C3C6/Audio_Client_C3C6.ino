/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║     Audio-Auto Client  —  ESP32-C3 / ESP32-C6   v4.0                    ║
 * ║     Library: ESP8266Audio by earlephilhower                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * v4.0  — Non-blocking state machine
 * ────────────────────────────────────────────────────────────────────────────
 *  Problem (v3.x)              │  Fix (v4.0)
 * ─────────────────────────────┼──────────────────────────────────────────────
 *  Commands dropped during     │  mqttCallback() only writes pendingCmd;
 *  stream start                │  loop() processes it every iteration
 * ─────────────────────────────┼──────────────────────────────────────────────
 *  1 s blocking delay()        │  PREFILLING state — timer checked each
 *  freezes WiFi/MQTT           │  loop() call; no delay() in audio path
 * ─────────────────────────────┼──────────────────────────────────────────────
 *  Seek byte-offset hardcoded  │  bitrate_kbps from MQTT payload;
 *  at 128 kbps                 │  byteOff = seekSec × (kbps×1000/8)
 * ─────────────────────────────┼──────────────────────────────────────────────
 *  I2S re-created on every     │  i2sOut kept alive; only created once
 *  song (audible pop/silence)  │  (or when it was never made)
 * ─────────────────────────────┼──────────────────────────────────────────────
 *  Sync → play gap visible     │  HTTP opens + buffer fills during
 *  as silence                  │  PREFILLING state (warm by fire time)
 * ─────────────────────────────┼──────────────────────────────────────────────
 *  50-second drift on next     │  adjPos = pendingPos + (now - syncFireTime)
 *  song / late MQTT delivery   │  applied at fire time before openStream()
 * ────────────────────────────────────────────────────────────────────────────
 *
 * State machine:
 *   IDLE ──play cmd──► WAITING_SYNC ──fire──► PREFILLING ──timer──► PLAYING
 *        ◄──stop────────────────────────────────────────────────────────────
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  WIRING — PCM5102A  →  ESP32-C3                                         │
 * ├──────────────┬────────────┬─────────────────────────────────────────────┤
 * │  PCM5102A    │  ESP32-C3  │  Notes                                       │
 * ├──────────────┼────────────┼─────────────────────────────────────────────┤
 * │  VCC         │  3.3V      │                                              │
 * │  GND         │  GND       │                                              │
 * │  BCK         │  GPIO 5    │  Bit Clock (BCLK)                           │
 * │  LCK / LRCK  │  GPIO 4    │  Word Select (Left-Right Clock)             │
 * │  DIN         │  GPIO 6    │  Serial Data                                │
 * │  SCK / MCLK  │  GND       │  Tie to GND — no master clock needed        │
 * │  FMT         │  GND       │  I2S standard format                        │
 * │  XMT / XSMT  │  3.3V      │  Un-mute — MUST be HIGH or no sound!        │
 * └──────────────┴────────────┴─────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  WIRING — PCM5102A  →  ESP32-C6                                         │
 * ├──────────────┬────────────┬─────────────────────────────────────────────┤
 * │  PCM5102A    │  ESP32-C6  │  Notes                                       │
 * ├──────────────┼────────────┼─────────────────────────────────────────────┤
 * │  VCC         │  3.3V      │                                              │
 * │  GND         │  GND       │                                              │
 * │  BCK         │  GPIO 19   │  Bit Clock (BCLK)                           │
 * │  LCK / LRCK  │  GPIO 18   │  Word Select                                │
 * │  DIN         │  GPIO 20   │  Serial Data                                │
 * │  SCK / MCLK  │  GND       │  Tie to GND                                 │
 * │  FMT         │  GND       │  I2S standard format                        │
 * │  XMT / XSMT  │  3.3V      │  Un-mute — MUST be HIGH!                    │
 * └──────────────┴────────────┴─────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  REQUIRED LIBRARIES (Arduino Library Manager)                            │
 * │  • ESP8266Audio  by earlephilhower  (search "ESP8266Audio")              │
 * │  • PubSubClient  by Nick O'Leary                                         │
 * │  • ArduinoJson   by Benoit Blanchon (v6 or v7)                           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  BOARD SETTINGS (Arduino IDE → Tools)                                    │
 * │  ESP32-C3: Board = "ESP32C3 Dev Module"                                  │
 * │  ESP32-C6: Board = "ESP32C6 Dev Module"                                  │
 * │  CPU Freq : 160 MHz (recommended for audio decode)                       │
 * │  USB CDC On Boot = "Enabled" (for Serial Monitor)                        │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ── Compile-time chip selection ──────────────────────────────────────────────
#if defined(CONFIG_IDF_TARGET_ESP32C3)
  #define CHIP_NAME "ESP32-C3"
  #define I2S_BCLK  5
  #define I2S_LRC   4
  #define I2S_DOUT  6
#elif defined(CONFIG_IDF_TARGET_ESP32C6)
  #define CHIP_NAME "ESP32-C6"
  #define I2S_BCLK  19
  #define I2S_LRC   18
  #define I2S_DOUT  20
#else
  #define CHIP_NAME "ESP32-Generic"
  #define I2S_BCLK  26
  #define I2S_LRC   25
  #define I2S_DOUT  22
  #warning "Audio_Client_C3C6 is intended for ESP32-C3/C6."
#endif

// ESP8266Audio
#include <AudioGeneratorMP3.h>
#include <AudioFileSourceHTTPStream.h>
#include <AudioFileSourceBuffer.h>
#include <AudioOutputI2S.h>

#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <time.h>

// ═══════════════════════════════════════════════════════════════════════════
//  ▶  USER CONFIGURATION — edit these for every device
// ═══════════════════════════════════════════════════════════════════════════

const char* DEVICE_NAME = "ESP32c6-Ruang-C001";

// WiFi — up to 3 networks, picks strongest automatically
const char* WIFI_SSID1 = "DCLXVI";          const char* WIFI_PASS1 = "1029384756";
const char* WIFI_SSID2 = "BBWV_Oprasional";  const char* WIFI_PASS2 = "Balai5-OPRA123!";
const char* WIFI_SSID3 = "BMKG-JAYAPURA";   const char* WIFI_PASS3 = "bmkg@123";

// MQTT broker
const char* MQTT_BROKER = "192.168.88.8";
const int   MQTT_PORT   = 1883;
const char* MQTT_USER   = "inskal";
const char* MQTT_PASS   = "admin_inskal_mqtt";

// NTP — UTC+9 (Asia/Jayapura / WIT), no DST
const char* NTP1 = "pool.ntp.org";
const char* NTP2 = "time.google.com";
const char* NTP3 = "time.cloudflare.com";
const long  TZ_OFFSET_SEC = 9 * 3600;
const int   DST_OFFSET    = 0;

// How long (ms) to let the HTTP buffer fill before starting the decoder.
// Increase if you still hear glitches at the start; 600 ms works on LAN.
static const uint32_t PREFILL_MS = 600;

// ═══════════════════════════════════════════════════════════════════════════

WiFiMulti    wifiMulti;
WiFiClient   netClient;
PubSubClient mqtt(netClient);

// ── Audio state machine ────────────────────────────────────────────────────
//
//  IDLE ──play──► WAITING_SYNC ──fire──► PREFILLING ──timer──► PLAYING
//       ◄──stop────────────────────────────────────────────────
//
enum AudioState { IDLE, WAITING_SYNC, PREFILLING, PLAYING };
AudioState audioState = IDLE;

// ── Command queue ─────────────────────────────────────────────────────────
// mqttCallback() only writes here; loop() reads and acts.
// This prevents commands from being dropped or from causing re-entrancy
// issues while the audio stack is mid-operation.
struct PendingCmd {
    String  action;       // "play" | "stop" | "seek" | "volume" | "sync_time"
    String  url;
    double  startTime;    // Unix timestamp to begin playback
    float   position;     // seconds from track start at startTime
    int     volume;       // 0–100
    int     bitrateKbps;  // used for accurate byte-offset seek
    bool    pending;      // true = unprocessed command waiting in loop()
};
PendingCmd pendingCmd = {"", "", 0, 0.0f, 80, 128, false};

// ── Playback parameters ───────────────────────────────────────────────────
String   currentUrl         = "";
int      currentVolume      = 80;
int      currentBitrateKbps = 128;

// Preserved at command-receive time; used to compute drift at fire time
double   syncFireTime    = 0;
float    pendingPosition = 0.0f;

// PREFILLING timer — duration adapts to buffer size / bitrate
uint32_t prefillStart = 0;
uint32_t prefillMs    = 600;   // set by openStream() per track

// Misc timers
unsigned long lastTelemetry = 0;
unsigned long lastWifiCheck = 0;
unsigned long ntpFallbackMs = 0;

// ── ESP8266Audio objects ──────────────────────────────────────────────────
// i2sOut is kept alive across tracks (created once, reused).
// http / buf / mp3 are heap-allocated per track and deleted on stop.
AudioOutputI2S*            i2sOut = nullptr;
AudioFileSourceHTTPStream* http   = nullptr;
AudioFileSourceBuffer*     buf    = nullptr;
AudioGeneratorMP3*         mp3    = nullptr;

// ── Helpers ──────────────────────────────────────────────────────────────

void logMsg(const String& msg) {
    Serial.println(msg);
    if (mqtt.connected())
        mqtt.publish(("audioauto/log/" + String(DEVICE_NAME)).c_str(), msg.c_str());
}

double getUnixTime() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return (double)tv.tv_sec + (double)tv.tv_usec / 1e6;
}

// ── Audio control ─────────────────────────────────────────────────────────

/**
 * Stop and free the decoder + stream, but keep i2sOut alive to avoid
 * I2S re-init overhead and the audible pop it produces.
 */
void closeStream() {
    if (mp3 && mp3->isRunning()) mp3->stop();
    delete mp3; mp3 = nullptr;
    delete buf; buf = nullptr;
    delete http; http = nullptr;
    // i2sOut intentionally NOT deleted — reuse across tracks
    audioState = IDLE;
}

/**
 * Open the HTTP stream and allocate the buffer.
 * Called at sync-fire time so the buffer can pre-fill during PREFILLING
 * state — by the time beginDecoder() is called, there is already data.
 *
 * seekSec      : position in seconds (already drift-corrected)
 * bitrateKbps  : actual file bitrate for accurate byte-offset calculation
 */
bool openStream(const String& url, float seekSec, int bitrateKbps) {
    closeStream();

    // Create I2S output once; reuse on subsequent tracks
    if (!i2sOut) {
        i2sOut = new AudioOutputI2S(0, AudioOutputI2S::EXTERNAL_I2S);
        i2sOut->SetPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
        Serial.printf("[I2S] created — BCLK=%d LRC=%d DOUT=%d\n",
                      I2S_BCLK, I2S_LRC, I2S_DOUT);
    }
    i2sOut->SetGain(currentVolume / 100.0f);

    // Accurate Frame-Sync Seek: instead of guessing byte offsets which causes
    // static noise, we pass the time offset to the server. The server instantly
    // slices the MP3 using FFmpeg and returns a clean stream.
    String finalUrl = url;
    if (seekSec > 0.1f) {
        if (finalUrl.indexOf("?") == -1) {
            finalUrl += "?seek_sec=" + String(seekSec, 2);
        } else {
            finalUrl += "&seek_sec=" + String(seekSec, 2);
        }
        Serial.printf("[Seek] Requesting exact time offset: %.2fs\n", seekSec);
    }

    // Open HTTP with the new offset URL
    http = new AudioFileSourceHTTPStream(finalUrl.c_str());
    Serial.printf("[HTTP] isOpen=%d\n", http->isOpen() ? 1 : 0);
    if (!http->isOpen()) {
        logMsg("ERROR: HTTP open failed: " + finalUrl);
        delete http; http = nullptr;
        return false;
    }

    // Adaptive buffer: scale with bitrate so high-bitrate files (>160 kbps)
    // don't drain the buffer between TCP reads on single-core C6.
    //   ≤ 160 kbps → 16 kB  (comfortable for CBR 128/160 MP3)
    //   ≤ 256 kbps → 24 kB  (covers 192/256 kbps)
    //   ≤ 320 kbps → 32 kB  (covers 256/320 kbps CBR)
    //   > 320 kbps → 40 kB  (high-quality originals, lossless-like)
    uint32_t bufSize;
    if      (bitrateKbps <= 160) bufSize = 16384;
    else if (bitrateKbps <= 256) bufSize = 24576;
    else if (bitrateKbps <= 320) bufSize = 32768;
    else                         bufSize = 40960;

    buf = new AudioFileSourceBuffer(http, bufSize);

    // Adaptive prefill time: enough to fill ~75% of the buffer at the given
    // bitrate. t_fill = (bufSize * 0.75 * 8) / (bitrateKbps * 1000)  seconds.
    // Clamped 600–1500 ms so it's never too short or too long.
    uint32_t fillMs = (uint32_t)((bufSize * 0.75f * 8.0f)
                                 / ((float)bitrateKbps * 1000.0f) * 1000.0f);
    prefillMs = constrain(fillMs, 600, 1500);

    Serial.printf("[Buffer] %u kB allocated for %d kbps — prefill %u ms\n",
                  bufSize / 1024, bitrateKbps, prefillMs);
    return true;
}

/**
 * Attach the MP3 decoder to the warm buffer and start playback.
 * Called after PREFILL_MS has elapsed so the buffer already has data.
 */
void beginDecoder() {
    mp3 = new AudioGeneratorMP3();
    if (!mp3->begin(buf, i2sOut)) {
        logMsg("ERROR: MP3 decoder failed to start");
        closeStream();
        return;
    }
    Serial.println("[MP3] begin() OK — isRunning=" + String(mp3->isRunning()));
    audioState = PLAYING;
    logMsg("Playing: " + currentUrl);
}

// ── NTP ──────────────────────────────────────────────────────────────────

bool syncNTP() {
    configTime(TZ_OFFSET_SEC, DST_OFFSET, NTP1, NTP2, NTP3);
    Serial.print("NTP sync");
    struct tm t;
    for (int i = 0; i < 40; i++) {
        if (getLocalTime(&t)) {
            Serial.printf(" OK → %02d:%02d:%02d\n", t.tm_hour, t.tm_min, t.tm_sec);
            return true;
        }
        delay(500); Serial.print('.');
    }
    Serial.println(" FAILED");
    return false;
}

// ── MQTT ─────────────────────────────────────────────────────────────────

void registerDevice() {
    StaticJsonDocument<128> doc;
    doc["name"] = DEVICE_NAME;
    doc["ip"]   = WiFi.localIP().toString();
    char buf[128]; serializeJson(doc, buf);
    mqtt.publish("audioauto/register", buf, true);
}

void connectMQTT() {
    int tries = 0;
    while (!mqtt.connected() && tries < 5) {
        Serial.print("MQTT...");
        if (mqtt.connect(DEVICE_NAME, MQTT_USER, MQTT_PASS)) {
            Serial.println("OK");
            mqtt.subscribe(("audioauto/commands/" + String(DEVICE_NAME)).c_str(), 1);
            mqtt.subscribe("audioauto/commands/all", 1);
            registerDevice();
            
            // Ask server for current playing state so we jump in if late
            String syncReqTopic = "audioauto/sync_request/" + String(DEVICE_NAME);
            mqtt.publish(syncReqTopic.c_str(), "boot");
            
            logMsg("Device online: " + String(DEVICE_NAME));
        } else {
            Serial.printf("fail(%d) retry\n", mqtt.state());
            delay(3000); tries++;
        }
    }
}

void publishTelemetry() {
    StaticJsonDocument<256> doc;
    doc["ip"]          = WiFi.localIP().toString();
    doc["rssi"]        = WiFi.RSSI();
    doc["ssid"]        = WiFi.SSID();
    doc["audio_state"] = (audioState == PLAYING)    ? "playing"   :
                         (audioState == PREFILLING)  ? "buffering" :
                         (audioState == WAITING_SYNC)? "waiting"   : "idle";
    char buf[256]; serializeJson(doc, buf);
    mqtt.publish(("audioauto/telemetry/" + String(DEVICE_NAME)).c_str(), buf);
}

/**
 * MQTT callback — ONLY writes to pendingCmd.
 * Never calls closeStream(), openStream(), or beginDecoder() here.
 * Calling audio functions from a callback is unsafe because the callback
 * can fire mid-loop() while the audio stack is in an intermediate state,
 * causing crashes or dropped frames.
 */
void mqttCallback(char* topic, byte* payload, unsigned int len) {
    String msg; msg.reserve(len);
    for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
    Serial.printf("MQTT [%s]: %s\n", topic, msg.c_str());

    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, msg)) { Serial.println("JSON err"); return; }

    pendingCmd.action      = doc["action"] | "";
    pendingCmd.url         = doc["url"]    | "";      // empty = reuse currentUrl
    pendingCmd.startTime   = doc["start_time"].as<double>();
    pendingCmd.position    = doc["position"]   | 0.0f;
    pendingCmd.volume      = constrain((int)(doc["volume"] | currentVolume), 0, 100);
    pendingCmd.bitrateKbps = doc["bitrate_kbps"] | 128;
    pendingCmd.pending     = true;

    Serial.printf("[Queue] action=%s  t=%.3f  pos=%.2f  kbps=%d\n",
                  pendingCmd.action.c_str(), pendingCmd.startTime,
                  pendingCmd.position, pendingCmd.bitrateKbps);
}

// ═══════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(800);
    Serial.printf("\n╔══════════════════════════════════╗\n"
                  "║  Audio-Auto  %-10s v4.0   ║\n"
                  "╚══════════════════════════════════╝\n", CHIP_NAME);
    Serial.println(DEVICE_NAME);

    // WiFi
    wifiMulti.addAP(WIFI_SSID1, WIFI_PASS1);
    wifiMulti.addAP(WIFI_SSID2, WIFI_PASS2);
    wifiMulti.addAP(WIFI_SSID3, WIFI_PASS3);
    Serial.print("WiFi");
    while (wifiMulti.run() != WL_CONNECTED) { delay(500); Serial.print('.'); }
    Serial.printf(" OK → %s  IP %s  RSSI %d dBm\n",
        WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());

    // NTP
    syncNTP();

    // MQTT
    mqtt.setServer(MQTT_BROKER, MQTT_PORT);
    mqtt.setCallback(mqttCallback);
    mqtt.setBufferSize(512);
    mqtt.setKeepAlive(30);
    connectMQTT();

    Serial.println("Ready!\n");
    logMsg("Device Booted and Ready!");
}

// ═══════════════════════════════════════════════════════════════════════════
void loop() {

    // ── 1. Process pending MQTT command ──────────────────────────────────────
    // Safe to call audio functions here since we're in the main loop context.
    if (pendingCmd.pending) {
        pendingCmd.pending = false;
        String act = pendingCmd.action;

        if (act == "stop" || act == "pause") {
            closeStream();
            logMsg("CMD " + act);

        } else if (act == "volume") {
            currentVolume = pendingCmd.volume;
            if (i2sOut) i2sOut->SetGain(currentVolume / 100.0f);
            logMsg("CMD volume → " + String(currentVolume) + "%");

        } else if (act == "speed") {
            logMsg("CMD speed: not supported on ESP8266Audio");

        } else if (act == "sync_time") {
            syncNTP();
            logMsg("NTP re-synced");

        } else if (act == "play") {
            closeStream();
            if (pendingCmd.url.length() > 0) currentUrl = pendingCmd.url;
            currentVolume      = pendingCmd.volume;
            currentBitrateKbps = pendingCmd.bitrateKbps;
            syncFireTime       = pendingCmd.startTime;
            pendingPosition    = pendingCmd.position;
            audioState = WAITING_SYNC;
            logMsg("CMD play → t=" + String(syncFireTime, 3)
                   + "  pos=" + String(pendingPosition, 2)
                   + "  kbps=" + String(currentBitrateKbps));

        } else if (act == "seek") {
            // Seek re-opens the stream at a new position.
            // If startTime is in the future, enter WAITING_SYNC.
            // If it has already passed, fire immediately with drift correction.
            closeStream();
            if (pendingCmd.url.length() > 0) currentUrl = pendingCmd.url;
            currentVolume      = pendingCmd.volume;
            currentBitrateKbps = pendingCmd.bitrateKbps;

            double now = getUnixTime();
            if (pendingCmd.startTime > now) {
                // Future fire time — wait
                syncFireTime    = pendingCmd.startTime;
                pendingPosition = pendingCmd.position;
                audioState = WAITING_SYNC;
            } else {
                // Fire immediately with drift correction
                double overrun = max(0.0, now - pendingCmd.startTime);
                float adjPos   = pendingCmd.position + (float)overrun;
                Serial.printf("[Drift] seek overrun=%.3fs → adjPos=%.2fs\n", overrun, adjPos);
                if (openStream(currentUrl, adjPos, currentBitrateKbps)) {
                    prefillStart = millis();
                    audioState = PREFILLING;
                }
            }
            logMsg("CMD seek → " + String(pendingCmd.position, 2));
        }
    }

    // ── 2. Feed MP3 decoder ──────────────────────────────────────────────────
    if (audioState == PLAYING && mp3 && mp3->isRunning()) {
        if (!mp3->loop()) {
            Serial.println("[MP3] stream ended");
            logMsg("Playback finished");
            closeStream();
        }
    }

    // ── 3. WiFi watchdog (every 5 s) ─────────────────────────────────────────
    if (millis() - lastWifiCheck > 5000) {
        lastWifiCheck = millis();
        if (wifiMulti.run() != WL_CONNECTED) {
            Serial.println("[WiFi] lost, reconnecting...");
            return;
        }
    }

    // ── 4. MQTT keepalive ────────────────────────────────────────────────────
    if (!mqtt.connected()) connectMQTT();
    mqtt.loop();

    // ── 5. Telemetry (every 15 s) ────────────────────────────────────────────
    if (millis() - lastTelemetry > 15000) {
        lastTelemetry = millis();
        publishTelemetry();
    }

    // ── 6. Sync state machine ────────────────────────────────────────────────
    if (audioState == WAITING_SYNC) {
        bool fire = false;

        double now = getUnixTime();
        if (now < 1577836800.0) {
            // NTP not yet synced — use a millis-based 300 ms fallback
            if (ntpFallbackMs == 0) {
                ntpFallbackMs = millis() + 300;
                logMsg("WARN: NTP not synced — using millis fallback");
            }
            if (millis() >= ntpFallbackMs) { fire = true; ntpFallbackMs = 0; }
        } else {
            fire = (now >= syncFireTime);
        }

        if (fire) {
            // Drift correction: account for MQTT delivery lag and any
            // time elapsed since the intended fire timestamp.
            double now2   = getUnixTime();
            double overrun = max(0.0, now2 - syncFireTime);
            float adjPos   = pendingPosition + (float)overrun;
            Serial.printf("[Drift] overrun=%.3fs → adjPos=%.2fs (was %.2fs)\n",
                          overrun, adjPos, pendingPosition);

            if (openStream(currentUrl, adjPos, currentBitrateKbps)) {
                prefillStart = millis();
                audioState   = PREFILLING;
            } else {
                audioState = IDLE;
            }
        }
    }

    // ── 7. PREFILLING — non-blocking buffer warm-up ──────────────────────────
    // MQTT and WiFi handlers above keep running every loop iteration.
    // Once prefillMs has elapsed (adaptive per bitrate), the HTTP ring buffer
    // has enough data and we start the decoder glitch-free.
    if (audioState == PREFILLING) {
        if (millis() - prefillStart >= prefillMs) {
            beginDecoder();
        }
    }
}
