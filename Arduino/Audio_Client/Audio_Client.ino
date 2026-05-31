#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <time.h>
#include <ArduinoJson.h>

// --- ESP8266Audio Library ---
#include "AudioFileSourceHTTPStream.h"
#include "AudioFileSourceBuffer.h"
#include "AudioGeneratorMP3.h"
#include "AudioGeneratorWAV.h"
#include "AudioGeneratorFLAC.h"
#include "AudioOutputI2S.h"

// --- Configuration ---
const char* DEVICE_NAME = "ESP32-Ruang-A001"; // Change for each device

const char* WIFI_SSID1 = "DCLXVI";
const char* WIFI_PASS1 = "1029384756";
const char* WIFI_SSID2 = "BBWV_Oprasional";
const char* WIFI_PASS2 = "Balai5-OPRA123!";
const char* WIFI_SSID3 = "BMKG-JAYAPURA";
const char* WIFI_PASS3 = "bmkg@123";

const char* NTP_SERVER = "pool.ntp.org";
const long GMT_OFFSET_SEC = 9 * 3600; // UTC+9
const int DAYLIGHT_OFFSET_SEC = 0;

const char* MQTT_BROKER = "192.168.88.8";
const int MQTT_PORT = 1883;
const char* MQTT_USER = "inskal";
const char* MQTT_PASS = "admin_inskal_mqtt";

WiFiMulti wifiMulti;
WiFiClient espClient;
PubSubClient mqttClient(espClient);

// --- Audio Objects ---
AudioGeneratorMP3 *mp3;
AudioGeneratorWAV *wav;
AudioGeneratorFLAC *flac;
AudioFileSourceHTTPStream *file;
AudioFileSourceBuffer *buff;
AudioOutputI2S *out;

enum AudioState { IDLE, PREPARING, WAITING_SYNC, PLAYING };
AudioState currentState = IDLE;

String pendingUrl = "";
long syncStartTime = 0;
int currentVolume = 50;
String currentFormat = "";

unsigned long lastTelemetry = 0;

void setupAudioHardware() {
#if CONFIG_IDF_TARGET_ESP32
    // ESP32: Use internal 8-bit DAC on GPIO25 & GPIO26
    out = new AudioOutputI2S(0, 1); 
    out->SetGain((float)currentVolume / 100.0);
    Serial.println("Audio hardware initialized: ESP32 Internal DAC");
#elif CONFIG_IDF_TARGET_ESP32C3 || CONFIG_IDF_TARGET_ESP32C6
    // ESP32-C3 / C6: Use external PCM5102 I2S module
    out = new AudioOutputI2S();
    // Configure pins based on typical setup, user may need to adjust
    // Default I2S pins for C3: BCLK=4, WS=5, DOUT=6
    #if CONFIG_IDF_TARGET_ESP32C3
      out->SetPinout(4, 5, 6); 
    #else // C6
      out->SetPinout(4, 5, 6); 
    #endif
    out->SetGain((float)currentVolume / 100.0);
    Serial.println("Audio hardware initialized: I2S PCM5102");
#else
    out = new AudioOutputI2S();
#endif
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
    audioLogger = &Serial;
    setupAudioHardware();
    mp3 = new AudioGeneratorMP3();
    wav = new AudioGeneratorWAV();
    flac = new AudioGeneratorFLAC();
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

void stopAudio() {
    if (mp3 && mp3->isRunning()) mp3->stop();
    if (wav && wav->isRunning()) wav->stop();
    if (flac && flac->isRunning()) flac->stop();
    if (buff) { buff->close(); delete buff; buff = NULL; }
    if (file) { file->close(); delete file; file = NULL; }
    currentState = IDLE;
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
        int vol = doc["volume"] | 50;
        
        currentVolume = vol;
        out->SetGain((float)currentVolume / 100.0);
        
        pendingUrl.toLowerCase();
        if (pendingUrl.endsWith(".wav")) currentFormat = "wav";
        else if (pendingUrl.endsWith(".flac")) currentFormat = "flac";
        else currentFormat = "mp3"; // Default
        
        Serial.print("Preparing to play: ");
        Serial.println(pendingUrl);
        Serial.print("Target Start Time (Unix): ");
        Serial.println(syncStartTime);
        
        stopAudio();
        currentState = PREPARING;
    } 
    else if (action == "stop") {
        Serial.println("Stop command received.");
        stopAudio();
    }
    else if (action == "seek") {
        // ESP8266Audio seeking support is limited, especially over HTTP streaming.
        // We handle this by stopping and ignoring for now, or you'd pass a Range header to HTTP stream.
        Serial.println("Seek command received - unsupported on ESP32 HTTP Stream without full restart.");
    }
}

void publishTelemetry() {
    StaticJsonDocument<256> doc;
    doc["ip"] = WiFi.localIP().toString();
    doc["status"] = "online";
    doc["rssi"] = WiFi.RSSI();
    
    // Internal temperature sensor is available on ESP32
    #ifdef __cplusplus
      extern "C" {
    #endif
    uint8_t temprature_sens_read();
    #ifdef __cplusplus
      }
    #endif
    
    #if CONFIG_IDF_TARGET_ESP32
      float temp = (temprature_sens_read() - 32) / 1.8;
      doc["temperature"] = temp;
    #else
      doc["temperature"] = 0.0; // Mock or read differently for C3/C6
    #endif

    char buffer[256];
    serializeJson(doc, buffer);
    
    String topic = String("audioauto/telemetry/") + DEVICE_NAME;
    mqttClient.publish(topic.c_str(), buffer);
}

void loop() {
    if (wifiMulti.run() != WL_CONNECTED) {
        Serial.println("WiFi connection lost!");
        delay(1000);
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
    if (currentState == PREPARING) {
        file = new AudioFileSourceHTTPStream(pendingUrl.c_str());
        buff = new AudioFileSourceBuffer(file, 8192); // 8KB buffer
        currentState = WAITING_SYNC;
        Serial.println("Audio buffered. Waiting for sync time...");
    }
    else if (currentState == WAITING_SYNC) {
        time_t now;
        time(&now);
        
        if (now >= syncStartTime) {
            Serial.println("Sync time reached! Starting playback.");
            if (currentFormat == "wav") {
                wav->begin(buff, out);
            } else if (currentFormat == "flac") {
                flac->begin(buff, out);
            } else {
                mp3->begin(buff, out);
            }
            currentState = PLAYING;
        }
    }
    else if (currentState == PLAYING) {
        bool running = false;
        if (currentFormat == "wav" && wav->isRunning()) {
            if (!wav->loop()) wav->stop();
            running = true;
        } else if (currentFormat == "flac" && flac->isRunning()) {
            if (!flac->loop()) flac->stop();
            running = true;
        } else if (currentFormat == "mp3" && mp3->isRunning()) {
            if (!mp3->loop()) mp3->stop();
            running = true;
        }

        if (!running) {
            Serial.println("Playback finished.");
            stopAudio();
        }
    }
}
