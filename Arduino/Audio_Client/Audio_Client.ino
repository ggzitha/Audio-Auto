/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║     Audio-Auto Client  —  ESP32 Classic (WROOM / WROVER)                 ║
 * ║     Library: ESP8266Audio by earlephilhower                               ║
 * ║                                                                           ║
 * ║  NOTE: ESP32-audioI2S v3.x requires PSRAM. This board has none.          ║
 * ║  ESP8266Audio was written for ESP8266 (80KB heap) — works perfectly       ║
 * ║  on ESP32 classic without PSRAM, and is proven to work on C3/C6 too.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  WIRING — PCM5102A  →  ESP32 Classic (WROOM / WROVER)                   │
 * ├──────────────┬────────────┬─────────────────────────────────────────────┤
 * │  PCM5102A    │  ESP32     │  Notes                                       │
 * ├──────────────┼────────────┼─────────────────────────────────────────────┤
 * │  VCC         │  3.3V      │  Module also works on 5V                     │
 * │  GND         │  GND       │                                              │
 * │  BCK         │  GPIO 26   │  Bit Clock (BCLK)                           │
 * │  LCK / LRCK  │  GPIO 25   │  Word Select (Left-Right Clock)             │
 * │  DIN         │  GPIO 22   │  Serial Data                                │
 * │  SCK / MCLK  │  GND       │  Tie to GND — no master clock needed        │
 * │  FMT         │  GND       │  I2S standard format                        │
 * │  XMT / XSMT  │  3.3V      │  Un-mute — MUST be HIGH or no sound!        │
 * ├──────────────┴────────────┴─────────────────────────────────────────────┤
 * │  AUDIO OUTPUT                                                            │
 * │  PCM5102A OUTL → AUX Left  (3.5mm Tip)                                 │
 * │  PCM5102A OUTR → AUX Right (3.5mm Ring)                                 │
 * │  PCM5102A GND  → AUX GND   (3.5mm Sleeve)                              │
 * └─────────────────────────────────────────────────────────────────────────┘
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
 * │  Board     : "ESP32 Dev Module" (or your specific module)                │
 * │  CPU Freq  : 240 MHz                                                     │
 * │  PSRAM     : Disabled                                                    │
 * └─────────────────────────────────────────────────────────────────────────┘
 */

// ── Compile-time guard ───────────────────────────────────────────────────────
// This file is for ESP32 classic dual-core. C3/C6 → use Audio_Client_C3C6.
#if defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6)
  #error "Wrong firmware! ESP32-C3/C6 → use the Audio_Client_C3C6 folder instead."
#endif

// ESP8266Audio headers
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

// Unique name per device.
// Format: ESP32-RoomCode-Number  (no spaces)
// Examples: ESP32-Lobby-001, ESP32-Ruang-A001
const char* DEVICE_NAME = "ESP32-Ruang-A001";

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

// I2S GPIO pins for PCM5102A (see wiring table above)
#define I2S_BCLK  26   // Bit Clock
#define I2S_LRC   25   // Word Select (LRCK)
#define I2S_DOUT  22   // Data Out

// ═══════════════════════════════════════════════════════════════════════════

WiFiMulti    wifiMulti;
WiFiClient   netClient;
PubSubClient mqtt(netClient);

// ESP8266Audio objects (heap-allocated — recreated on each new track)
AudioOutputI2S*            i2sOut = nullptr;
AudioFileSourceHTTPStream* http   = nullptr;
AudioFileSourceBuffer*     source = nullptr;
AudioGeneratorMP3*         mp3    = nullptr;

// Playback state machine
enum AudioState { IDLE, WAITING_SYNC, PLAYING };
AudioState   state           = IDLE;
String       pendingUrl      = "";
double       syncStartTime   = 0;
float        pendingPosition = 0.0f;
int          pendingBitrateKbps = 128;
int          currentVolume   = 80;   // 0–100 %

unsigned long lastTelemetry = 0;
unsigned long lastWifiCheck = 0;
unsigned long ntpFallbackMs = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

void logMsg(const String& msg) {
    Serial.println(msg);
    if (mqtt.connected())
        mqtt.publish(("audioauto/log/" + String(DEVICE_NAME)).c_str(), msg.c_str());
}

// ── Audio control ────────────────────────────────────────────────────────────

void stopAudio() {
    if (mp3 && mp3->isRunning()) mp3->stop();
    delete mp3;    mp3    = nullptr;
    delete source; source = nullptr;
    delete http;   http   = nullptr;
    state = IDLE;
}

/**
 * Stream MP3 from HTTP URL.
 * seekSec — approximate position in seconds (byte-offset via Range header).
 * volPct  — 0–100.
 */
void startStream(const String& url, float seekSec, int volPct, int bitrateKbps) {
    stopAudio();
    Serial.printf("[Stream] %s  pos=%.1fs  vol=%d%%\n",
                  url.c_str(), seekSec, volPct);

    // Create I2S output once; reuse across tracks
    if (!i2sOut) {
        // AudioOutputI2S(port=0, mode=EXTERNAL_I2S)
        i2sOut = new AudioOutputI2S(0, AudioOutputI2S::EXTERNAL_I2S);
        i2sOut->SetPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
    }
    i2sOut->SetGain(volPct / 100.0f);   // 0.0–1.0

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

    // Open HTTP stream
    http = new AudioFileSourceHTTPStream(finalUrl.c_str());
    if (!http->isOpen()) {
        logMsg("ERROR: HTTP open failed: " + finalUrl);
        delete http; http = nullptr;
        state = IDLE;
        return;
    }

    // 8 KB buffer — pre-fetches HTTP data so the decoder never sees TCP starvation
    source = new AudioFileSourceBuffer(http, 8192);

    mp3 = new AudioGeneratorMP3();
    if (!mp3->begin(source, i2sOut)) {
        logMsg("ERROR: MP3 decoder failed");
        stopAudio();
        return;
    }

    state = PLAYING;
    logMsg("Playing: " + url);
}

// ── NTP ─────────────────────────────────────────────────────────────────────

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

double getUnixTime() {
    struct timeval tv;
    gettimeofday(&tv, nullptr);
    return (double)tv.tv_sec + (double)tv.tv_usec / 1e6;
}

// ── MQTT ─────────────────────────────────────────────────────────────────────

void registerDevice() {
    StaticJsonDocument<128> doc;
    doc["name"] = DEVICE_NAME;
    doc["ip"]   = WiFi.localIP().toString();
    char buf[128]; serializeJson(doc, buf);
    mqtt.publish("audioauto/register", buf, true);   // retained
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
    doc["audio_state"] = (state == PLAYING) ? "playing" :
                         (state == WAITING_SYNC) ? "buffering" : "idle";
    float t = (float)temperatureRead();
    doc["temperature"] = (t > 0 && t < 125) ? t : 0.0f;
    char buf[256]; serializeJson(doc, buf);
    mqtt.publish(("audioauto/telemetry/" + String(DEVICE_NAME)).c_str(), buf);
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
    String msg; msg.reserve(len);
    for (unsigned int i = 0; i < len; i++) msg += (char)payload[i];
    Serial.printf("MQTT [%s]: %s\n", topic, msg.c_str());

    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, msg)) { Serial.println("JSON err"); return; }

    String action = doc["action"] | "";

    // ── play ─────────────────────────────────────────────────────────────────
    if (action == "play") {
        pendingUrl      = doc["url"] | "";
        syncStartTime   = doc["start_time"].as<double>();
        pendingPosition = doc["position"] | 0.0f;
        pendingBitrateKbps = doc["bitrate_kbps"] | 128;
        currentVolume   = constrain((int)(doc["volume"] | 80), 0, 100);
        stopAudio();
        state = WAITING_SYNC;
        logMsg("CMD play → t=" + String(syncStartTime, 3)
               + "  pos=" + String(pendingPosition, 2));
    }
    // ── stop / pause ─────────────────────────────────────────────────────────
    else if (action == "stop" || action == "pause") {
        stopAudio();
        logMsg("CMD " + action);
    }
    // ── seek ─────────────────────────────────────────────────────────────────
    else if (action == "seek") {
        double st  = doc["start_time"] | 0.0;
        float  pos = doc["position"]   | 0.0f;
        if (st > 0) {
            syncStartTime   = st;
            pendingPosition = pos;
            stopAudio();
            state = WAITING_SYNC;
        } else {
            if (pendingUrl.length() > 0) startStream(pendingUrl, pos, currentVolume, doc["bitrate_kbps"] | 128);
        }
        logMsg("CMD seek → " + String(pos, 2));
    }
    // ── volume ────────────────────────────────────────────────────────────────
    else if (action == "volume") {
        currentVolume = constrain((int)(doc["volume"] | 80), 0, 100);
        if (i2sOut) i2sOut->SetGain(currentVolume / 100.0f);
        logMsg("CMD volume → " + String(currentVolume) + "%");
    }
    // ── speed — not supported ─────────────────────────────────────────────────
    else if (action == "speed") {
        logMsg("CMD speed: not supported on ESP8266Audio");
    }
    // ── sync_time ─────────────────────────────────────────────────────────────
    else if (action == "sync_time") {
        syncNTP();
        logMsg("NTP re-synced");
    }
}

// ═══════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(800);
    Serial.println("\n╔══════════════════════════════════╗");
    Serial.println("║  Audio-Auto  ESP32  v3.0         ║");
    Serial.println("║  Library: ESP8266Audio            ║");
    Serial.println("╚══════════════════════════════════╝");
    Serial.println(DEVICE_NAME);

    // WiFi
    wifiMulti.addAP(WIFI_SSID1, WIFI_PASS1);
    wifiMulti.addAP(WIFI_SSID2, WIFI_PASS2);
    wifiMulti.addAP(WIFI_SSID3, WIFI_PASS3);
    Serial.print("WiFi");
    while (wifiMulti.run() != WL_CONNECTED) { delay(500); Serial.print('.'); }
    Serial.printf(" OK → %s  IP %s  RSSI %d dBm\n",
        WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());
    Serial.printf("FreeHeap: %d bytes\n", ESP.getFreeHeap());

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
    // Feed the MP3 decoder — must run every loop iteration without blocking
    if (mp3 && mp3->isRunning()) {
        if (!mp3->loop()) {
            logMsg("Playback finished");
            stopAudio();
        }
    }

    // WiFi watchdog (every 5 s)
    if (millis() - lastWifiCheck > 5000) {
        lastWifiCheck = millis();
        if (wifiMulti.run() != WL_CONNECTED) {
            Serial.println("[WiFi] lost, reconnecting...");
            return;
        }
    }

    // MQTT watchdog
    if (!mqtt.connected()) connectMQTT();
    mqtt.loop();

    // Telemetry every 15 s
    if (millis() - lastTelemetry > 15000) {
        lastTelemetry = millis();
        publishTelemetry();
    }

    // ── Synchronized playback state machine ──────────────────────────────────
    if (state == WAITING_SYNC) {
        bool fire = false;

        if (ntpFallbackMs > 0) {
            if (millis() >= ntpFallbackMs) { fire = true; ntpFallbackMs = 0; }
        } else {
            double now = getUnixTime();
            if (now < 1577836800.0) {
                ntpFallbackMs = millis() + 300;
                logMsg("WARN: NTP not synced — using millis fallback");
            } else if (now >= syncStartTime) {
                fire = true;
            }
        }

        if (fire) {
            syncStartTime = 0;
            if (pendingUrl.length() > 0)
                startStream(pendingUrl, pendingPosition, currentVolume, pendingBitrateKbps);
            pendingPosition = 0.0f;
        }
    }
}
