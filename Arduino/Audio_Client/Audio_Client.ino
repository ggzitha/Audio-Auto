/**
 * Audio-Auto Client Firmware
 * Compatible with: ESP32, ESP32-C3, ESP32-C6
 * 
 * HARDWARE SETUP:
 * ─────────────────────────────────────────────────────────────────────────────
 * ESP32 (Classic) - Internal DAC (GPIO25=Right, GPIO26=Left to AUX):
 *   - AUX Left    → GPIO 25  (DAC1)
 *   - AUX Right   → GPIO 26  (DAC2)  [same signal, mono output]
 *   - AUX Ground  → GND
 *   NOTE: USE_INTERNAL_DAC=true only works on classic ESP32 (WROOM/WROVER).
 *         The internal DAC is 8-bit, mono-only quality. For stereo, use PCM5102A.
 *
 * ESP32 (Classic) - External PCM5102A I2S (Stereo 32-bit):
 *   USE_INTERNAL_DAC = false
 *   PCM5102A VCC  → 3.3V or 5V
 *   PCM5102A GND  → GND
 *   PCM5102A BCK  → GPIO 26  (BCLK = Bit Clock)
 *   PCM5102A LCK  → GPIO 25  (LRCK = Word Select / Left-Right Clock)
 *   PCM5102A DIN  → GPIO 22  (DATA)
 *   PCM5102A SCK  → GND (or MCLK pin if available)
 *   PCM5102A FMT  → GND (I2S format)
 *   PCM5102A XMT  → 3.3V (unmute)
 *   PCM5102A AUX L/R/GND → External Speaker or Amplifier
 *
 * ESP32-C3 - External PCM5102A I2S (Required, no DAC):
 *   PCM5102A BCK  → GPIO 5
 *   PCM5102A LCK  → GPIO 4
 *   PCM5102A DIN  → GPIO 6
 *
 * ESP32-C6 - External PCM5102A I2S (Required, no DAC):
 *   PCM5102A BCK  → GPIO 19
 *   PCM5102A LCK  → GPIO 18
 *   PCM5102A DIN  → GPIO 20
 *
 * Optional RTC (DS3231 or DS1307):
 *   SDA → GPIO 21 (ESP32) / GPIO 8 (C3/C6)
 *   SCL → GPIO 22 (ESP32) / GPIO 9 (C3/C6)  [NOTE: conflicts with I2S DATA on ESP32!]
 *   If using PCM5102A on ESP32, move I2S DATA to a different GPIO (e.g. GPIO 18).
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Required Libraries (install via Library Manager or .zip):
 *   - ESP32-audioI2S by Schreibfaul1  → place in src/ESP32-audioI2S/
 *   - PubSubClient by Nick O'Leary    → Library Manager
 *   - ArduinoJson by Benoit Blanchon  → Library Manager
 *
 * DEVICE_NAME naming convention:
 *   ESP32-Ruang-A001, ESP32c3-Ruang-B002, ESP32c6-Ruang-C001...
 *   This name is used to auto-register the device in the web app via MQTT.
 */

#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <time.h>
#include <ArduinoJson.h>

// ESP32-audioI2S Library by Schreibfaul1
// #include "src/ESP32-audioI2S/src/Audio.h"

#include "Audio.h"
// ─── Device Configuration ──────────────────────────────────────────────────
// IMPORTANT: Change DEVICE_NAME for each individual ESP32 device.
// Format: ESP32-RoomName-Number  or  ESP32c3-RoomName-Number
// This name auto-registers in the web dashboard.
const char* DEVICE_NAME = "ESP32-Ruang-A001";

// ─── WiFi Configuration ────────────────────────────────────────────────────
// Connects to whichever has the strongest signal automatically.
const char* WIFI_SSID1 = "DCLXVI";
const char* WIFI_PASS1 = "1029384756";
const char* WIFI_SSID2 = "BBWV_Oprasional";
const char* WIFI_PASS2 = "Balai5-OPRA123!";
const char* WIFI_SSID3 = "BMKG-JAYAPURA";
const char* WIFI_PASS3 = "bmkg@123";

// ─── NTP Configuration ────────────────────────────────────────────────────
// Multiple NTP servers for redundancy (will try in order)
const char* NTP_SERVER1 = "pool.ntp.org";
const char* NTP_SERVER2 = "time.google.com";
const char* NTP_SERVER3 = "time.cloudflare.com";
const long  GMT_OFFSET_SEC        = 9 * 3600;  // UTC+9 (Asia/Jayapura / WIT)
const int   DAYLIGHT_OFFSET_SEC   = 0;          // No DST in Jayapura

// ─── MQTT Configuration ───────────────────────────────────────────────────
const char* MQTT_BROKER = "192.168.88.8";
const int   MQTT_PORT   = 1883;
const char* MQTT_USER   = "inskal";
const char* MQTT_PASS   = "admin_inskal_mqtt";

// ─── Audio Hardware Selection ─────────────────────────────────────────────
// Set to 1 → Use ESP32 Classic Internal DAC (GPIO 25 & 26). 8-bit quality.
//   Wiring: GPIO 25 → 10kΩ → AUX Tip (Left)
//           GPIO 26 → 10kΩ → AUX Ring (Right)
//           GND        →      AUX Sleeve
//
// Set to 0 → Use external PCM5102A I2S DAC. 32-bit stereo. Recommended!
//   See wiring table at top of file for GPIO assignments per chip.
//
// MUST be #define (not const bool) so that #if USE_INTERNAL_DAC works
// in the preprocessor when selecting the Audio constructor below.
#define USE_INTERNAL_DAC 0

// ─── Globals ──────────────────────────────────────────────────────────────
WiFiMulti     wifiMulti;
WiFiClient    espClient;
PubSubClient  mqttClient(espClient);

// CRITICAL: Internal DAC is enabled via the Audio CONSTRUCTOR parameter,
// NOT via setPinout(). The constructor signature is:
//   Audio(bool internalDAC, uint8_t channelEnabled, uint8_t i2sPort)
//   channelEnabled: 1=right(GPIO25), 2=left(GPIO26), 3=both
//
// If USE_INTERNAL_DAC=true:  Audio audio(true, 3)  → routes I2S0 to DAC
// If USE_INTERNAL_DAC=false: Audio audio(false, 3) → normal I2S (external DAC)
#if CONFIG_IDF_TARGET_ESP32
  #if USE_INTERNAL_DAC
    Audio audio(true, 3);   // Internal DAC, both channels (GPIO25=R, GPIO26=L)
  #else
    Audio audio(false, 3);  // External I2S (PCM5102A)
  #endif
#else
  Audio audio(false, 3);    // C3/C6: no internal DAC, always external I2S
#endif

enum AudioState { IDLE, WAITING_SYNC, PLAYING };
AudioState currentState = IDLE;

String        pendingUrl      = "";
double        syncStartTime   = 0;  // double to handle float timestamps from server
float         pendingPosition = 0.0;
unsigned long lastTelemetry   = 0;
unsigned long lastWifiCheck   = 0;
unsigned long pendingSeekAfter = 0; // millis() when to execute deferred seek
float         pendingSeekAfterPos = 0.0;
unsigned long ntpFallbackTarget = 0; // millis()-based target when NTP not synced

// ─── Logging ──────────────────────────────────────────────────────────────
void logOutput(const String& msg) {
    Serial.println(msg);
    if (mqttClient.connected()) {
        String topic = String("audioauto/log/") + DEVICE_NAME;
        mqttClient.publish(topic.c_str(), msg.c_str());
    }
}

// ─── Audio Hardware Setup ─────────────────────────────────────────────────
void setupAudioHardware() {
#if CONFIG_IDF_TARGET_ESP32
    if (USE_INTERNAL_DAC) {
        // Internal DAC is enabled via Audio(true, 3) constructor.
        // I2S0 is internally routed to GPIO25 (DAC1=Right) and GPIO26 (DAC2=Left).
        // DO NOT call setPinout() — it overrides the DAC routing with external pins.
        //
        // IMPORTANT: forceMono(true) prevents silent output.
        // The internal DAC outputs 8-bit samples. When stereo MP3 data arrives,
        // the library interleaves L+R samples. forceMono() combines them to a
        // single channel so both GPIO25 and GPIO26 carry the full mixed signal.
        audio.forceMono(true);
        //
        // ── AUX 3.5mm Wiring ──────────────────────────────────────────────
        // CRITICAL: 10kΩ resistors will KILL the signal!
        // With 32Ω headphones: Vout = 3.3V × 32/(10000+32) = 10mV ≈ silence.
        //
        // CORRECT wiring (two options):
        //
        // Option A — Direct (for amplified speakers / line-in):
        //   GPIO 25  ──────────── AUX Tip   (Left)
        //   GPIO 26  ──────────── AUX Ring  (Right)
        //   GND      ──────────── AUX Sleeve
        //
        // Option B — With DC-blocking (for headphones / direct speaker use):
        //   GPIO 25  ── 100µF cap (+) ── AUX Tip   (Left)
        //   GPIO 26  ── 100µF cap (+) ── AUX Ring  (Right)
        //   GND      ─────────────────── AUX Sleeve
        //   The capacitor blocks the 1.65V DC bias inherent to the DAC.
        //   Use electrolytic cap, + side toward GPIO.
        //
        // Optional: add a 100Ω resistor in series AFTER the cap (not before)
        // for current limiting — this only attenuates by 100/(100+load) which
        // is negligible with a 10kΩ line-in.
        Serial.println("[Audio] Mode: ESP32 Internal DAC (GPIO25=R, GPIO26=L) + forceMono");
    } else {
        // External PCM5102A I2S on classic ESP32: BCLK=26, LRC=25, DATA=22
        audio.setPinout(26, 25, 22);
        Serial.println("[Audio] Mode: PCM5102A I2S (BCLK=26, LRC=25, DATA=22)");
    }
#elif CONFIG_IDF_TARGET_ESP32C3
    // ESP32-C3: No internal DAC. PCM5102A required.
    audio.setPinout(5, 4, 6);
    Serial.println("[Audio] Mode: PCM5102A I2S on C3 (BCLK=5, LRC=4, DATA=6)");
#elif CONFIG_IDF_TARGET_ESP32C6
    // ESP32-C6: No internal DAC. PCM5102A required.
    audio.setPinout(19, 18, 20);
    Serial.println("[Audio] Mode: PCM5102A I2S on C6 (BCLK=19, LRC=18, DATA=20)");
#else
    audio.setPinout(26, 25, 22);
    Serial.println("[Audio] Mode: Generic fallback I2S");
#endif

    audio.setVolume(18);  // Start at 18/21 — internal DAC has lower perceived volume
}


// ─── MQTT Connection ──────────────────────────────────────────────────────
void connectMQTT() {
    int attempts = 0;
    while (!mqttClient.connected() && attempts < 5) {
        Serial.print("MQTT connecting...");
        if (mqttClient.connect(DEVICE_NAME, MQTT_USER, MQTT_PASS)) {
            Serial.println(" OK");
            // Subscribe to device-specific and broadcast topics
            String topicSpec = String("audioauto/commands/") + DEVICE_NAME;
            mqttClient.subscribe(topicSpec.c_str(), 1);
            mqttClient.subscribe("audioauto/commands/all", 1);
            logOutput(String("Device online: ") + DEVICE_NAME);
        } else {
            Serial.print(" failed rc=");
            Serial.println(mqttClient.state());
            delay(3000);
            attempts++;
        }
    }
}

// ─── MQTT Message Handler ─────────────────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int length) {
    String message = "";
    for (unsigned int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    Serial.print("MQTT [");
    Serial.print(topic);
    Serial.print("]: ");
    Serial.println(message);

    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, message);
    if (error) {
        Serial.println("JSON parse error");
        return;
    }

    String action = doc["action"] | "";

    if (action == "play") {
        pendingUrl      = (const char*)doc["url"];
        // start_time is a double (float with ms precision from Python time.time())
        syncStartTime   = doc["start_time"].as<double>();
        pendingPosition = doc["position"]   | 0.0;

        // Map 0-100 UI volume to 0-21 audio library volume
        int vol       = doc["volume"] | 70;
        int mappedVol = map(constrain(vol, 0, 100), 0, 100, 0, 21);
        audio.setVolume(mappedVol);

        audio.stopSong();
        currentState = WAITING_SYNC;

        logOutput(String("CMD play: ") + pendingUrl + " @ t=" + syncStartTime + " pos=" + pendingPosition);
    }
    else if (action == "stop") {
        audio.stopSong();
        currentState = IDLE;
        logOutput("CMD stop");
    }
    else if (action == "seek") {
        // start_time is now a float (ms precision) from the server
        double startTime  = doc["start_time"] | 0.0;
        float  position   = doc["position"]   | 0.0;
        if (startTime > 0) {
            syncStartTime   = startTime;
            pendingPosition = position;
            pendingUrl = "";  // empty = seek-only, no reload
            currentState = WAITING_SYNC;
        } else {
            audio.setAudioPlayPosition((uint32_t)position);
        }
        logOutput(String("CMD seek: ") + position);
    }
    else if (action == "volume") {
        int vol       = doc["volume"] | 70;
        int mappedVol = map(constrain(vol, 0, 100), 0, 100, 0, 21);
        audio.setVolume(mappedVol);
        logOutput(String("CMD volume: ") + vol + "%");
    }
    else if (action == "speed") {
        // ESP32-audioI2S does not support speed/pitch shift natively.
        // Acknowledged but not applied.
        logOutput("CMD speed: not supported on ESP32 hardware");
    }
    else if (action == "sync_time") {
        configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC,
                   NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);
        logOutput("NTP re-sync triggered");
    }
}

// ─── Telemetry ────────────────────────────────────────────────────────────
float readChipTemperature() {
    // temperatureRead() is a plain C++ function declared in esp32-hal-misc.h
    // It is available in Arduino ESP32 core 2.x (IDF4) and 3.x (IDF5).
    // Do NOT wrap with extern "C" — that linkage spec is only valid at file scope.
    //
    // Returns chip junction temperature in Celsius.
    // On classic ESP32 the internal sensor reads ~20-30°C above ambient.
    // On C3/C6 the sensor is also available via the same function in Arduino core 3.x.
    //
    // If your board package does not expose temperatureRead(), use the fallback below.
#if defined(CONFIG_IDF_TARGET_ESP32) || defined(CONFIG_IDF_TARGET_ESP32C3) || defined(CONFIG_IDF_TARGET_ESP32C6)
    float t = (float)temperatureRead();
    // Sanity check: sensor returns nonsense on some boards when WiFi radio is active
    if (t > 0 && t < 125) return t;
    return 0.0;
#else
    return 0.0;
#endif
}

void publishTelemetry() {
    StaticJsonDocument<256> doc;
    doc["ip"]     = WiFi.localIP().toString();
    doc["status"] = "online";
    doc["rssi"]   = WiFi.RSSI();
    doc["ssid"]   = WiFi.SSID();

    float temp = readChipTemperature();
    doc["temperature"] = (temp > 0 && temp < 120) ? temp : 0.0;

    // Current audio state
    doc["audio_state"] = (currentState == PLAYING) ? "playing" :
                         (currentState == WAITING_SYNC) ? "buffering" : "idle";

    char buffer[256];
    serializeJson(doc, buffer);

    String topic = String("audioauto/telemetry/") + DEVICE_NAME;
    mqttClient.publish(topic.c_str(), buffer);
}

// ─── NTP Sync ─────────────────────────────────────────────────────────────
bool syncNTP() {
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC,
               NTP_SERVER1, NTP_SERVER2, NTP_SERVER3);
    Serial.print("Syncing NTP time");
    struct tm timeinfo;
    for (int i = 0; i < 40; i++) {
        if (getLocalTime(&timeinfo)) {
            Serial.printf("\nTime synced: %02d:%02d:%02d\n",
                          timeinfo.tm_hour, timeinfo.tm_min, timeinfo.tm_sec);
            return true;
        }
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nNTP sync failed! Will retry...");
    return false;
}

// ─── Setup ────────────────────────────────────────────────────────────────
void setup() {
    Serial.begin(115200);
    delay(1000);

    Serial.println("\n╔═══════════════════════════════╗");
    Serial.println("║    Audio-Auto Client v2.0     ║");
    Serial.println("╚═══════════════════════════════╝");
    Serial.print("Device: ");
    Serial.println(DEVICE_NAME);

    // ── WiFi Setup ────────────────────────────────────────────────────────
    wifiMulti.addAP(WIFI_SSID1, WIFI_PASS1);
    wifiMulti.addAP(WIFI_SSID2, WIFI_PASS2);
    wifiMulti.addAP(WIFI_SSID3, WIFI_PASS3);

    Serial.print("Connecting WiFi");
    while (wifiMulti.run() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.printf("\nConnected: %s (RSSI: %d dBm)\n",
                  WiFi.SSID().c_str(), WiFi.RSSI());
    Serial.print("IP: ");
    Serial.println(WiFi.localIP());

    // ── NTP Time Sync ─────────────────────────────────────────────────────
    syncNTP();

    // ── MQTT Setup ────────────────────────────────────────────────────────
    // Increase buffer for larger JSON payloads (MP3 URLs can be long)
    mqttClient.setBufferSize(512);
    mqttClient.setKeepAlive(30);
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);

    // ── Audio Hardware ────────────────────────────────────────────────────
    setupAudioHardware();

    Serial.println("Setup complete. Connecting to MQTT...");
    connectMQTT();
    Serial.println("Ready!");
}

// ─── Main Loop ────────────────────────────────────────────────────────────
void loop() {
    // CRITICAL: audio.loop() must be called as frequently as possible.
    // Any delay here causes audio stuttering/dropouts.
    audio.loop();

    // ── WiFi Watchdog ─────────────────────────────────────────────────────
    if (millis() - lastWifiCheck > 5000) {
        lastWifiCheck = millis();
        if (wifiMulti.run() != WL_CONNECTED) {
            Serial.println("WiFi lost! Reconnecting...");
            return;  // Skip rest of loop while reconnecting
        }
    }

    // ── MQTT Watchdog ─────────────────────────────────────────────────────
    if (!mqttClient.connected()) {
        connectMQTT();
    }
    mqttClient.loop();

    // ── Telemetry (every 10s) ─────────────────────────────────────────────
    if (millis() - lastTelemetry > 10000) {
        lastTelemetry = millis();
        publishTelemetry();
    }

    // ── Synchronized Playback State Machine ───────────────────────────────
    if (currentState == WAITING_SYNC) {
        bool shouldFire = false;

        if (ntpFallbackTarget > 0) {
            // NTP not synced: using millis()-based fallback target
            if (millis() >= ntpFallbackTarget) {
                shouldFire = true;
                ntpFallbackTarget = 0;
            }
        } else {
            time_t now;
            time(&now);
            // Real NTP time: any valid Unix stamp is > Jan 1 2020 (1577836800)
            // If 'now' is smaller, NTP has not synced yet -> fall back to millis
            const time_t MIN_VALID_EPOCH = 1577836800;
            if (now < MIN_VALID_EPOCH) {
                ntpFallbackTarget = millis() + 400;
                logOutput("WARN: NTP not synced, using millis fallback");
            } else if ((double)now >= syncStartTime) {
                shouldFire = true;
            }
        }

        if (shouldFire) {
            if (pendingUrl.length() > 0) {
                logOutput(String("Sync! Starting: ") + pendingUrl);
                audio.connecttohost(pendingUrl.c_str());
                currentState = PLAYING;
                if (pendingPosition > 1.0) {
                    pendingSeekAfterPos = pendingPosition;
                    pendingSeekAfter    = millis() + 400; // non-blocking deferred seek
                }
                pendingPosition = 0.0;
            } else {
                logOutput(String("Sync seek to: ") + pendingPosition);
                audio.setAudioPlayPosition((uint32_t)pendingPosition);
                currentState    = PLAYING;
                pendingPosition = 0.0;
            }
            syncStartTime = 0;
        }
    }

    // Non-blocking deferred seek after stream starts buffering
    if (pendingSeekAfter > 0 && millis() >= pendingSeekAfter) {
        audio.setAudioPlayPosition((uint32_t)pendingSeekAfterPos);
        pendingSeekAfter    = 0;
        pendingSeekAfterPos = 0.0;
    }
}

// ─── ESP32-audioI2S Library Callbacks ─────────────────────────────────────
void audio_info(const char* info) {
    Serial.printf("[audio_info] %s\n", info);
}

void audio_id3data(const char* info) {
    Serial.printf("[id3] %s\n", info);
}

void audio_eof_mp3(const char* info) {
    Serial.printf("[EOF] %s\n", info);
    currentState = IDLE;
    logOutput("Playback finished");
}

void audio_error_mp3(const char* info) {
    Serial.printf("[ERROR] %s\n", info);
    logOutput(String("Audio error: ") + info);
    currentState = IDLE;
}

void audio_bitrate(const char* info) {
    Serial.printf("[bitrate] %s\n", info);
}
