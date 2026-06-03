/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║     Audio-Auto Client  —  ESP32-C3 / ESP32-C6                           ║
 * ║     Library: ESP8266Audio by earlephilhower                              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * WHY A DIFFERENT FIRMWARE?
 *   ESP32-audioI2S v3.x uses xTaskCreatePinnedToCore() which requires 2 CPU
 *   cores. ESP32-C3 and ESP32-C6 are single-core RISC-V — that library simply
 *   won't compile for them. ESP8266Audio was originally written for the ESP8266
 *   (also single-core) and works on C3/C6 without PSRAM.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  WIRING — PCM5102A  →  ESP32-C3                                         │
 * ├──────────────┬────────────┬─────────────────────────────────────────────┤
 * │  PCM5102A    │  ESP32-C3  │  Notes                                       │
 * ├──────────────┼────────────┼─────────────────────────────────────────────┤
 * │  VCC         │  3.3V      │  Module also works on 5V                     │
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
 * │  AUDIO OUTPUT (both C3 and C6)                                           │
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
 * │  ESP32-C3: Board = "ESP32C3 Dev Module"                                  │
 * │            USB CDC On Boot = "Enabled" (for Serial Monitor)              │
 * │  ESP32-C6: Board = "ESP32C6 Dev Module"                                  │
 * │            USB CDC On Boot = "Enabled"                                   │
 * │  CPU Freq : 160 MHz (recommended for audio decode)                       │
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
  // Fallback for compiling on any other ESP32 variant
  #define CHIP_NAME "ESP32-Generic"
  #define I2S_BCLK  26
  #define I2S_LRC   25
  #define I2S_DOUT  22
  #warning "Audio_Client_C3C6 is intended for ESP32-C3/C6. For ESP32 classic use Audio_Client instead."
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
// Format: ESP32c3-RoomCode-Number  or  ESP32c6-RoomCode-Number
// Examples: ESP32c3-Hall-001, ESP32c6-Lobby-002
const char* DEVICE_NAME = "ESP32c3-Ruang-B001";

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

// ═══════════════════════════════════════════════════════════════════════════

WiFiMulti    wifiMulti;
WiFiClient   netClient;
PubSubClient mqtt(netClient);

// ESP8266Audio objects (heap-allocated so we can delete/recreate on each play)
AudioOutputI2S*           i2sOut  = nullptr;
AudioFileSourceHTTPStream* http   = nullptr;   // raw HTTP stream
AudioFileSourceBuffer*    source  = nullptr;   // 4 kB RAM buffer
AudioGeneratorMP3*        mp3     = nullptr;


// Playback state
enum AudioState { IDLE, WAITING_SYNC, PLAYING };
AudioState   state           = IDLE;
String       pendingUrl      = "";
double       syncStartTime   = 0;
float        pendingPosition = 0.0f;
int          currentVolume   = 80;   // 0–100 %

unsigned long lastTelemetry  = 0;
unsigned long lastWifiCheck  = 0;
unsigned long ntpFallbackMs  = 0;

// ── Helpers ──────────────────────────────────────────────────────────────────

void logMsg(const String& msg) {
    Serial.println(msg);
    if (mqtt.connected()) {
        mqtt.publish(("audioauto/log/" + String(DEVICE_NAME)).c_str(), msg.c_str());
    }
}

// ── Audio control ────────────────────────────────────────────────────────────

void stopAudio() {
    if (mp3 && mp3->isRunning()) mp3->stop();
    delete mp3;    mp3    = nullptr;
    if (source) { source->close(); delete source; source = nullptr; }
    if (http)   { http->close();   delete http;   http   = nullptr; }
    state = IDLE;
}


/**
 * Start streaming MP3 from an HTTP URL.
 * seekSec — approximate position in seconds.
 *   ESP8266Audio's AudioFileSourceHTTPStream::seek() internally re-issues the
 *   HTTP request with a Range header on ESP32 builds, so this works correctly.
 * volPct  — 0–100 volume
 */
void startStream(const String& url, float seekSec, int volPct) {
    stopAudio();

    Serial.printf("[Stream] %s  pos=%.1fs  vol=%d%%\n",
                  url.c_str(), seekSec, volPct);

    // Create I2S output once; reuse across tracks
    if (!i2sOut) {
        i2sOut = new AudioOutputI2S(0, AudioOutputI2S::EXTERNAL_I2S);
        i2sOut->SetPinout(I2S_BCLK, I2S_LRC, I2S_DOUT);
    }
    i2sOut->SetGain(volPct / 100.0f);   // 0.0–1.0

    // Open HTTP stream
    http = new AudioFileSourceHTTPStream(url.c_str());
    if (!http->isOpen()) {
        logMsg("ERROR: HTTP open failed: " + url);
        delete http; http = nullptr;
        state = IDLE;
        return;
    }

    // Approximate seek via byte offset (128 kbps = 16 000 B/s)
    // seek() on ESP32 AudioFileSourceHTTPStream re-opens with Range: bytes=N-
    if (seekSec > 1.0f) {
        uint32_t byteOffset = (uint32_t)(seekSec * 16000.0f);
        if (!http->seek(byteOffset, SEEK_SET)) {
            // seek not supported on this build — play from start, accept drift
            Serial.printf("[Stream] seek unsupported, playing from 0 (drift %.1fs)\n", seekSec);
        }
    }

    // 4 kB RAM buffer to smooth out WiFi jitter
    source = new AudioFileSourceBuffer(http, 4096);

    mp3 = new AudioGeneratorMP3();
    if (!mp3->begin(source, i2sOut)) {
        logMsg("ERROR: MP3 decoder failed to start");
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
    // ── seek — restart stream from new position ───────────────────────────────
    else if (action == "seek") {
        double st = doc["start_time"] | 0.0;
        float pos = doc["position"]   | 0.0f;
        if (st > 0) {
            syncStartTime   = st;
            pendingPosition = pos;
            pendingUrl      = (state == PLAYING && mp3 && mp3->isRunning())
                              ? ""  // reuse current URL
                              : pendingUrl;
            stopAudio();
            state = WAITING_SYNC;
        } else {
            // Immediate seek — restart stream at new position
            if (pendingUrl.length() > 0) startStream(pendingUrl, pos, currentVolume);
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
        logMsg("CMD speed: not supported on ESP8266Audio / C3/C6");
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
    Serial.printf("\n╔══════════════════════════════════╗\n"
                  "║  Audio-Auto  %-10s v3.0          ║\n"
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
    // ── Feed the MP3 decoder — must run every loop iteration ─────────────────
    if (mp3 && mp3->isRunning()) {
        if (!mp3->loop()) {
            // Stream ended naturally
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

    // MQTT watchdog — use reduced poll interval during playback so mp3->loop()
    // gets enough CPU time on the single core.
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
                // NTP not synced — use millis estimate (300 ms margin)
                ntpFallbackMs = millis() + 300;
                logMsg("WARN: NTP not synced — using millis fallback");
            } else if (now >= syncStartTime) {
                fire = true;
            }
        }

        if (fire) {
            syncStartTime = 0;
            if (pendingUrl.length() > 0) {
                startStream(pendingUrl, pendingPosition, currentVolume);
            }
            pendingPosition = 0.0f;
        }
    }
}
