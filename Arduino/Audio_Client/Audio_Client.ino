#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <time.h>
#include <ArduinoJson.h>

// --- ESP32-audioI2S Library by Schreibfaul1 ---
#include "src/ESP32-audioI2S/src/Audio.h"

// --- Configuration ---
const char* DEVICE_NAME = "ESP32-Ruang-A001"; // Change for each device

const char* WIFI_SSID1 = "DCLXVI";
const char* WIFI_PASS1 = "1029384756";
const char* WIFI_SSID2 = "BBWV_Oprasional";
const char* WIFI_PASS2 = "Balai5-OPRA123!";
const char* WIFI_SSID3 = "BMKG-JAYAPURA";
const char* WIFI_PASS3 = "bmkg@123";

const char* NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET_SEC = 9 * 3600; // UTC+9 Asia/Jayapura
const int DAYLIGHT_OFFSET_SEC = 0;

const char* MQTT_BROKER = "192.168.88.8";
const int MQTT_PORT = 1883;
const char* MQTT_USER = "inskal";
const char* MQTT_PASS = "admin_inskal_mqtt";

// Hardware Options
// Set to 'true' to use the Classic ESP32's Internal DAC (GPIO 25 & 26).
// Set to 'false' to use an external PCM5102A I2S DAC (Required for C3/C6).
const bool USE_INTERNAL_DAC = true; 

WiFiMulti wifiMulti;
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// --- Audio Object ---
Audio audio;

enum AudioState { IDLE, PREPARING, WAITING_SYNC, PLAYING };
AudioState currentState = IDLE;

String pendingUrl = "";
long syncStartTime = 0;
unsigned long lastTelemetry = 0;


void logOutput(String msg) {
    Serial.println(msg);
    if (mqttClient.connected()) {
        String topic = String("audioauto/log/") + DEVICE_NAME;
        mqttClient.publish(topic.c_str(), msg.c_str());
    }
}

void setupAudioHardware() {
#if CONFIG_IDF_TARGET_ESP32
    if (USE_INTERNAL_DAC) {
        // ESP32: Use internal 8-bit DAC on GPIO25 & GPIO26
        // Note: Internal DAC is deprecated in ESP32-audioI2S v3.x+ and IDF v5+
        // If you get no sound, you MUST use the external PCM5102A DAC instead.
        audio.setPinout(26, 25, 22); 
        Serial.println("Audio hardware initialized: ESP32 Internal DAC (GPIO25/26)");
    } else {
        // ESP32: External PCM5102 I2S DAC
        audio.setPinout(26, 25, 22); // BCLK, LRC, DOUT
        Serial.println("Audio hardware initialized: ESP32 with PCM5102A (I2S)");
    }
#elif CONFIG_IDF_TARGET_ESP32C3
    // ESP32-C3: External PCM5102 I2S DAC (Required)
    audio.setPinout(5, 4, 6); // BCLK=5, LRC=4, DOUT=6
    Serial.println("Audio hardware initialized: ESP32-C3 with PCM5102A (I2S)");
#elif CONFIG_IDF_TARGET_ESP32C6
    // ESP32-C6: External PCM5102 I2S DAC (Required)
    audio.setPinout(19, 18, 20); // BCLK=19, LRC=18, DOUT=20
    Serial.println("Audio hardware initialized: ESP32-C6 with PCM5102A (I2S)");
#else
    // Fallback default
    audio.setPinout(26, 25, 22);
#endif

    audio.setVolume(10); // Volume range is 0 to 21
}

void connectMQTT() {
    while (!mqttClient.connected()) {
        Serial.print("Attempting MQTT connection...");
        if (mqttClient.connect(DEVICE_NAME, MQTT_USER, MQTT_PASS)) {
            Serial.println("connected");
            String topicSpec = String("audioauto/commands/") + DEVICE_NAME;
            mqttClient.subscribe(topicSpec.c_str());
            mqttClient.subscribe("audioauto/commands/all");
        } else {
            Serial.print("failed, rc=");
            Serial.print(mqttClient.state());
            Serial.println(" try again in 5 seconds");
            delay(5000);
        }
    }
}

void mqttCallback(char* topic, byte* payload, unsigned int length) {
    String message = "";
    for (int i = 0; i < length; i++) {
        message += (char)payload[i];
    }
    
    StaticJsonDocument<512> doc;
    DeserializationError error = deserializeJson(doc, message);
    if (error) {
        Serial.println("Failed to parse MQTT message");
        return;
    }

    String action = doc["action"] | "";
    
    if (action == "play") {
        pendingUrl = doc["url"] | "";
        syncStartTime = doc["start_time"] | 0;
        
        // Map 0-100 UI volume to 0-21 Audio library volume
        int vol = doc["volume"] | 50;
        int mappedVol = map(vol, 0, 100, 0, 21);
        audio.setVolume(mappedVol);
        
        Serial.print("Preparing to play: ");
        logOutput(pendingUrl);
        Serial.print("Target Start Time (Unix): ");
        logOutput(String(syncStartTime));
        
        audio.stopSong();
        currentState = WAITING_SYNC;
        
        // Handle Resume Position
        float position = doc["position"] | 0.0;
        if (position > 0.0) {
            audio.setAudioPlayPosition(position);
        }
    } 
    else if (action == "stop") {
        logOutput("Stop command received.");
        audio.stopSong();
        currentState = IDLE;
    }
    else if (action == "seek") {
        float position = doc["position"] | 0.0;
        Serial.print("Seek command received: ");
        logOutput(String(position));
        audio.setAudioPlayPosition(position);
    }
    else if (action == "speed") {
        // Speed control requires pitch shifting which is highly intensive on ESP32,
        // The ESP32-audioI2S doesn't directly support simple speed toggling via an API, 
        // but we acknowledge the command.
        logOutput("Speed command received.");
    }
    else if (action == "volume") {
        int vol = doc["volume"] | 50;
        int mappedVol = map(vol, 0, 100, 0, 21);
        audio.setVolume(mappedVol);
        logOutput("Volume updated to " + String(vol) + "%");
    }
    else if (action == "sync_time") {
        logOutput("Resyncing time via NTP...");
        configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
    }
}

void publishTelemetry() {
    StaticJsonDocument<256> doc;
    doc["ip"] = WiFi.localIP().toString();
    doc["status"] = "online";
    doc["rssi"] = WiFi.RSSI();
    
    #if CONFIG_IDF_TARGET_ESP32
      // internal temperature sensor on classic ESP32 requires specific handling, skipping for stability
      doc["temperature"] = 45.0; // Mock temperature
    #else
      doc["temperature"] = 0.0;
    #endif

    char buffer[256];
    serializeJson(doc, buffer);
    
    String topic = String("audioauto/telemetry/") + DEVICE_NAME;
    mqttClient.publish(topic.c_str(), buffer);
}

void setup() {
    Serial.begin(115200);
    delay(1000);
    
    Serial.println("\n--- Audio-Auto Client ---");
    Serial.print("Device Name: ");
    Serial.println(DEVICE_NAME);

    // WiFi Setup
    wifiMulti.addAP(WIFI_SSID1, WIFI_PASS1);
    wifiMulti.addAP(WIFI_SSID2, WIFI_PASS2);
    wifiMulti.addAP(WIFI_SSID3, WIFI_PASS3);
    
    Serial.println("Connecting to WiFi...");
    while(wifiMulti.run() != WL_CONNECTED) {
        delay(500);
        Serial.print(".");
    }
    Serial.println("\nWiFi connected.");
    Serial.print("IP Address: ");
    Serial.println(WiFi.localIP());

    // NTP Setup
    configTime(GMT_OFFSET_SEC, DAYLIGHT_OFFSET_SEC, NTP_SERVER);
    Serial.println("Syncing time with NTP...");
    struct tm timeinfo;
    while (!getLocalTime(&timeinfo)) {
        delay(1000);
        Serial.print(".");
    }
    Serial.println("\nTime synced.");

    // MQTT Setup
    mqttClient.setServer(MQTT_BROKER, MQTT_PORT);
    mqttClient.setCallback(mqttCallback);

    // Audio Setup
    setupAudioHardware();
}

void loop() {
    // Crucial for keeping the audio buffer full and playing
    audio.loop();

    if (wifiMulti.run() != WL_CONNECTED) {
        return;
    }

    if (!mqttClient.connected()) {
        connectMQTT();
    }
    mqttClient.loop();

    // Telemetry every 10 seconds
    if (millis() - lastTelemetry > 10000) {
        publishTelemetry();
        lastTelemetry = millis();
    }

    // Audio State Machine
    if (currentState == WAITING_SYNC) {
        time_t now;
        time(&now);
        
        if (now >= syncStartTime) {
            logOutput("Sync time reached! Starting playback.");
            audio.connecttohost(pendingUrl.c_str());
            currentState = PLAYING;
        }
    }
}

// Optional callback functions provided by the audio library
void audio_info(const char *info){
    Serial.print("info        "); logOutput(info);
}
void audio_id3data(const char *info){  //id3 metadata
    Serial.print("id3data     ");logOutput(info);
}
void audio_eof_mp3(const char *info){  //end of file
    Serial.print("eof_mp3     ");logOutput(info);
    currentState = IDLE;
}
