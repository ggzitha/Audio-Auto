/**
 * Audio-Auto Client — ESP32-S3 N16R8  v5.0  (Sendspin Protocol)
 * ═══════════════════════════════════════════════════════════════
 *
 * Same Sendspin protocol as the C6 sketch, optimised for S3 N16R8:
 *   • 256 KB ring buffer in PSRAM (8 MB available on N16R8) — ~1.45 s
 *   • 300 ms lead time / 300 ms min buffer — very stable for LAN
 *   • 240 MHz CPU (set in Arduino IDE: Tools → CPU Frequency → 240 MHz)
 *   • I2S_NUM_0 on GPIO 4 / 5 / 6  (same as Seeed XIAO S3, safe pins)
 *
 * ── REQUIREMENTS ─────────────────────────────────────────────────────────────
 *  Board package : Arduino ESP32 v3.x  (ESP-IDF v5)
 *  Board target  : ESP32-S3 Dev Module (Tools → Board)
 *  PSRAM         : OPI PSRAM  (Tools → PSRAM → OPI PSRAM)
 *  CPU Frequency : 240 MHz   (Tools → CPU Frequency → 240 MHz)
 *  Libraries     : ArduinoWebsockets, PubSubClient, ArduinoJson
 *
 * ── WIRING — PCM5102A → ESP32-S3 DevKit-C1 ──────────────────────────────────
 *  PCM5102A  │  GPIO  │  Notes
 *  ──────────┼────────┼──────────────────────────────────────────────────────
 *  BCK       │   4    │  Bit Clock
 *  LCK/LRCK  │   5    │  Word Select
 *  DIN       │   6    │  Serial Data
 *  SCK/MCLK  │  GND   │  Tie LOW — internal PLL
 *  FMT       │  GND   │  I2S standard format
 *  XMT/XSMT  │  3.3V  │  Unmute — MUST be HIGH!
 *  VCC       │  3.3V  │
 *  GND       │  GND   │
 *  LOUT/ROUT → 3.5mm TRS jack (or RCA)
 *
 * ── I2S pin alternatives ─────────────────────────────────────────────────────
 *  Pins 4/5/6 avoid USB JTAG (19/20), strapping (0,45,46), and PSRAM (26-37).
 *  Change I2S_BCLK_PIN / I2S_LRC_PIN / I2S_DOUT_PIN below if needed.
 */

#ifndef CONFIG_IDF_TARGET_ESP32S3
  #warning "This sketch is for ESP32-S3. For ESP32-C6, use Audio_Client_C3C6.ino"
#endif

// ── I2S pin configuration ────────────────────────────────────────────────────
#define I2S_BCLK_PIN  4
#define I2S_LRC_PIN   5
#define I2S_DOUT_PIN  6

// ── Library includes ─────────────────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include "driver/i2s_std.h"     // ESP-IDF v5 I2S API
#include "esp_timer.h"           // monotonic µs clock
#include "esp_heap_caps.h"       // MALLOC_CAP_SPIRAM for PSRAM alloc

using namespace websockets;

// ═════════════════════════════════════════════════════════════════════════════
// ▶  USER CONFIGURATION  (edit these)
// ═════════════════════════════════════════════════════════════════════════════

const char* DEVICE_NAME = "ESP32s3-Ruang-S001";

// WiFi — up to 3 networks, picks strongest automatically
const char* WIFI_SSID1 = "DCLXVI";          const char* WIFI_PASS1 = "1029384756";
const char* WIFI_SSID2 = "BBWV_Oprasional";  const char* WIFI_PASS2 = "Balai5-OPRA123!";
const char* WIFI_SSID3 = "BMKG-JAYAPURA";   const char* WIFI_PASS3 = "bmkg@123";

const char* MQTT_BROKER = "192.168.88.8";
const int   MQTT_PORT   = 1883;
const char* MQTT_USER   = "inskal";
const char* MQTT_PASS   = "admin_inskal_mqtt";

const char* SS_HOST = "192.168.88.8";
const int   SS_PORT = 9876;
const char* SS_PATH = "/sendspin";

// ═════════════════════════════════════════════════════════════════════════════
// ▶  AUDIO TUNING
// ═════════════════════════════════════════════════════════════════════════════

// 256 KB in PSRAM ≈ 1.45 s at 176 400 bytes/s — very comfortable buffer
static const size_t RING_BUF_SIZE         = 256 * 1024;
static const int    REQUIRED_LEAD_TIME_MS = 300;
static const int    MIN_BUFFER_MS         = 300;

static const int    DMA_BUF_COUNT = 8;
static const size_t DMA_BUF_LEN  = 512;
static const int64_t DMA_LATENCY_US =
    (int64_t)DMA_BUF_COUNT * (int64_t)DMA_BUF_LEN * 1000000LL / 176400LL;

static const int PCM_SAMPLE_RATE   = 44100;
static const int PCM_BYTES_FRAME   = 4;
static const int PCM_BYTES_PER_SEC = 176400;

static const int INITIAL_VOLUME = 80;

// ═════════════════════════════════════════════════════════════════════════════

inline int64_t localUs() { return esp_timer_get_time(); }

// ─────────────────────────────────────────────────────────────────────────────
// Kalman Time Filter  (identical implementation to C6 sketch)
// ─────────────────────────────────────────────────────────────────────────────
class KalmanTimeFilter {
public:
    bool  synced = false;
    int   count  = 0;

    void reset() {
        count=0; _offset=0; _drift=0; _offCov=1e18;
        _driftCov=0; _odCov=0; _lastUpd=0; _useDrift=false; synced=false;
    }

    void update(int64_t T1, int64_t T2, int64_t T3, int64_t T4) {
        int64_t measurement = ((T2-T1)+(T3-T4))/2;
        int64_t rtt = (T4-T1)-(T3-T2); if(rtt<0)rtt=-rtt;
        _kalmanUpdate(measurement, rtt/2, T4);
        synced = (count >= 3);
    }

    int64_t toLocalTime(int64_t serverTs) const {
        if (!synced) return serverTs;
        double effDrift = _useDrift ? _drift : 0.0;
        return (int64_t)round(
            ((double)serverTs - _offset + effDrift*(double)_lastUpd) / (1.0+effDrift));
    }

    double offsetMs() const { return _offset / 1000.0; }

private:
    static constexpr double DRIFT_PROC_VAR = 1e-22;
    static constexpr double MAX_ERR_SCALE  = 0.5;
    static constexpr double DRIFT_SIG_SQ   = 4.0;

    double  _offset=0, _drift=0, _offCov=1e18, _driftCov=0, _odCov=0;
    int64_t _lastUpd=0;
    bool    _useDrift=false;

    void _kalmanUpdate(int64_t meas, int64_t maxErr, int64_t t) {
        if (count>0 && t<=_lastUpd) return;
        double mVar = (double)(maxErr*MAX_ERR_SCALE)*(double)(maxErr*MAX_ERR_SCALE);
        if (count==0) { _offset=(double)meas; _offCov=mVar; _lastUpd=t; count++; return; }
        double dt = (double)(t-_lastUpd);
        if (count==1) {
            _drift=((double)meas-_offset)/dt;
            _driftCov=(_offCov+mVar)/(dt*dt);
            _offset=(double)meas; _offCov=mVar; _lastUpd=t; count++; return;
        }
        double pO=_offset+_drift*dt, nDC=_driftCov+dt*DRIFT_PROC_VAR,
               nODC=_odCov+_driftCov*dt, nOC=_offCov+2*_odCov*dt+_driftCov*dt*dt;
        double innov=(double)meas-pO, Si=1.0/(nOC+mVar);
        double kO=nOC*Si, kD=nODC*Si;
        _offset=pO+kO*innov; _drift+=kD*innov;
        _driftCov=nDC-kD*nODC; _odCov=nODC-kD*nOC; _offCov=nOC-kO*nOC;
        _useDrift=(_drift*_drift>DRIFT_SIG_SQ*_driftCov);
        _lastUpd=t; if(count<255)count++;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PCM Ring Buffer  — PSRAM-backed for S3
// ─────────────────────────────────────────────────────────────────────────────
class PCMRingBuffer {
public:
    explicit PCMRingBuffer(size_t sz) : _size(sz), _head(0), _tail(0), _avail(0) {
        // Try PSRAM first (fast external SPIRAM on N16R8)
        _buf = (uint8_t*)heap_caps_malloc(sz, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!_buf) {
            // Fallback: internal RAM with reduced size
            size_t fallback = sz / 4;
            _buf = (uint8_t*)malloc(fallback);
            _size = _buf ? fallback : 0;
            if (_buf)
                Serial.printf("[RingBuf] PSRAM unavailable — fallback to %d KB internal RAM\n",
                    (int)(_size/1024));
        } else {
            Serial.printf("[RingBuf] Allocated %d KB in PSRAM\n", (int)(sz/1024));
        }
    }
    ~PCMRingBuffer() { free(_buf); }

    bool isAllocated() const { return _buf != nullptr && _size > 0; }
    size_t capacity()  const { return _size; }

    bool write(const uint8_t* data, size_t len) {
        if (!_buf || _avail+len > _size) return false;
        for (size_t i=0; i<len; i++) { _buf[_tail++]=data[i]; if(_tail>=_size)_tail=0; }
        _avail+=len; return true;
    }
    size_t read(uint8_t* out, size_t len) {
        size_t n=(_avail<len)?_avail:len;
        for (size_t i=0; i<n; i++) { out[i]=_buf[_head++]; if(_head>=_size)_head=0; }
        _avail-=n; return n;
    }
    size_t available() const { return _avail; }
    void   clear()           { _head=_tail=_avail=0; }

private:
    uint8_t* _buf;
    size_t   _size, _head, _tail, _avail;
};

// ─────────────────────────────────────────────────────────────────────────────
// Global state (identical structure to C6 sketch)
// ─────────────────────────────────────────────────────────────────────────────
WiFiMulti        wifiMulti;
WiFiClient       netClient;
PubSubClient     mqtt(netClient);
WebsocketsClient wsClient;

KalmanTimeFilter timeFilter;
PCMRingBuffer*   ringBuf = nullptr;

i2s_chan_handle_t i2sTxChan = nullptr;
bool i2sReady = false;

enum class AudioState : uint8_t { IDLE, BUFFERING, PLAYING };
AudioState audioState = AudioState::IDLE;

int64_t firstChunkLocalTs = 0;
int64_t i2sStartTs        = 0;

int  currentVolume = INITIAL_VOLUME;
bool currentMuted  = false;
bool wsConnected   = false;

unsigned long lastTimeSendMs  = 0;
unsigned long lastTelemetryMs = 0;
unsigned long lastWifiCheckMs = 0;
unsigned long lastMqttLoopMs  = 0;
unsigned long lastWsRetryMs   = 0;

static uint8_t i2sScratch[DMA_BUF_LEN];

struct { String action; int volume; bool pending; } pendingMqtt = {"", 0, false};

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
void logMsg(const String& msg) {
    Serial.println(msg);
    if (mqtt.connected())
        mqtt.publish(("audioauto/log/" + String(DEVICE_NAME)).c_str(), msg.c_str());
}

void applyVolume(uint8_t* buf, size_t len) {
    if (currentMuted || currentVolume == 0) { memset(buf, 0, len); return; }
    if (currentVolume >= 100) return;
    float gain = ((float)currentVolume / 100.0f);
    gain = gain * gain;  // squared law perceptual
    int16_t* s = (int16_t*)buf;
    size_t n = len / 2;
    for (size_t i = 0; i < n; i++) s[i] = (int16_t)((float)s[i] * gain);
}

// ─────────────────────────────────────────────────────────────────────────────
// I2S (ESP-IDF v5)
// ─────────────────────────────────────────────────────────────────────────────
void setupI2S() {
    if (i2sReady) return;
    i2s_chan_config_t ch = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ch.auto_clear = true;
    if (i2s_new_channel(&ch, &i2sTxChan, NULL) != ESP_OK) {
        Serial.println("[I2S] new_channel failed"); return;
    }
    i2s_std_config_t cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(PCM_SAMPLE_RATE),
        .slot_cfg = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)I2S_BCLK_PIN,
            .ws   = (gpio_num_t)I2S_LRC_PIN,
            .dout = (gpio_num_t)I2S_DOUT_PIN,
            .din  = I2S_GPIO_UNUSED,
            .invert_flags = {false, false, false},
        },
    };
    if (i2s_channel_init_std_mode(i2sTxChan, &cfg) != ESP_OK ||
        i2s_channel_enable(i2sTxChan) != ESP_OK) {
        Serial.println("[I2S] init failed");
        i2s_del_channel(i2sTxChan); i2sTxChan = nullptr; return;
    }
    i2sReady = true;
    Serial.printf("[I2S] Ready: %d Hz / 16-bit / stereo  BCK=%d LRC=%d DOUT=%d\n",
        PCM_SAMPLE_RATE, I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
}

void feedI2S() {
    if (!i2sReady || !ringBuf) return;
    size_t avail = ringBuf->available();
    size_t toWrite;
    if (avail == 0) {
        memset(i2sScratch, 0, sizeof(i2sScratch));
        toWrite = sizeof(i2sScratch);
        Serial.println("WARN: I2S underrun");
    } else {
        toWrite = min(avail, sizeof(i2sScratch));
        toWrite &= ~3u;
        if (toWrite == 0) return;
        ringBuf->read(i2sScratch, toWrite);
        applyVolume(i2sScratch, toWrite);
    }
    size_t written = 0;
    i2s_channel_write(i2sTxChan, i2sScratch, toWrite, &written, pdMS_TO_TICKS(5));
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin stream control
// ─────────────────────────────────────────────────────────────────────────────
void stopStream() {
    audioState=AudioState::IDLE; firstChunkLocalTs=0; i2sStartTs=0;
    if(ringBuf) ringBuf->clear();
    Serial.println("[Sendspin] Stream stopped");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin outgoing messages
// ─────────────────────────────────────────────────────────────────────────────
void sendClientHello() {
    StaticJsonDocument<512> doc;
    doc["type"]      = "client/hello";
    doc["client_id"] = DEVICE_NAME;
    doc["name"]      = DEVICE_NAME;
    doc["version"]   = 1;
    JsonArray roles = doc.createNestedArray("supported_roles");
    roles.add("player@v1"); roles.add("controller@v1");
    JsonObject ps = doc.createNestedObject("player@v1_support");
    JsonArray fmts = ps.createNestedArray("supported_formats");
    JsonObject f = fmts.createNestedObject();
    f["codec"]="pcm"; f["sample_rate"]=PCM_SAMPLE_RATE; f["channels"]=2; f["bit_depth"]=16;
    ps["buffer_capacity"] = (int)(ringBuf ? ringBuf->capacity() * 4 / 5 : RING_BUF_SIZE * 4 / 5);
    JsonArray cmds = ps.createNestedArray("supported_commands");
    cmds.add("volume"); cmds.add("mute");
    char buf[512]; serializeJson(doc, buf);
    wsClient.send(buf);
    Serial.println("[Sendspin] → client/hello");
}

void sendClientState() {
    StaticJsonDocument<256> doc;
    doc["type"]="client/state"; doc["state"]="synchronized";
    JsonObject p = doc.createNestedObject("player");
    p["volume"]=currentVolume; p["muted"]=currentMuted;
    p["static_delay_ms"]=0;
    p["required_lead_time_ms"]=REQUIRED_LEAD_TIME_MS;
    p["min_buffer_ms"]=MIN_BUFFER_MS;
    char buf[256]; serializeJson(doc, buf);
    wsClient.send(buf);
}

void sendClientTime() {
    int64_t T1 = localUs();
    StaticJsonDocument<128> doc;
    doc["type"]="client/time";
    doc["client_transmitted"]=(double)T1;
    char buf[128]; serializeJson(doc, buf);
    wsClient.send(buf);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin incoming message handlers
// ─────────────────────────────────────────────────────────────────────────────
void handleServerHello(JsonDocument& doc) {
    Serial.printf("[Sendspin] ← server/hello  id=%s\n", (const char*)(doc["server_id"]|"?"));
    sendClientState(); sendClientTime(); lastTimeSendMs = millis();
}

void handleServerTime(JsonDocument& doc) {
    int64_t T4 = localUs();
    double T1d=doc["client_transmitted"]|0.0, T2d=doc["server_received"]|0.0, T3d=doc["server_transmitted"]|0.0;
    timeFilter.update((int64_t)T1d,(int64_t)T2d,(int64_t)T3d,T4);
    if (timeFilter.count <= 6) {
        int64_t rtt = (T4-(int64_t)T1d)-((int64_t)T3d-(int64_t)T2d);
        Serial.printf("[Sync] #%d  offset=%.2f ms  RTT=%.2f ms\n",
            timeFilter.count, timeFilter.offsetMs(), rtt/1000.0);
    }
}

void handleStreamStart(JsonDocument& doc) {
    const char* codec = doc["player"]["codec"]|"?";
    Serial.printf("[Sendspin] ← stream/start  codec=%s\n", codec);
    stopStream();
    if (!i2sReady) setupI2S();
    audioState = AudioState::BUFFERING;
    Serial.printf("[Sendspin] Buffering... (buf=%d KB)\n", (int)(ringBuf->capacity()/1024));
}

void handleStreamEnd()  { Serial.println("[Sendspin] ← stream/end");   stopStream(); }
void handleStreamClear() {
    Serial.println("[Sendspin] ← stream/clear");
    if(ringBuf)ringBuf->clear(); firstChunkLocalTs=0; i2sStartTs=0;
    audioState=AudioState::BUFFERING;
}

void handleServerCommand(JsonDocument& doc) {
    JsonObject p = doc["player"]; if(p.isNull())return;
    if(p.containsKey("volume")) { currentVolume=constrain((int)p["volume"],0,100); sendClientState(); }
    if(p.containsKey("mute"))   { currentMuted=(bool)p["mute"]; sendClientState(); }
}

void handleJsonMessage(const String& text) {
    StaticJsonDocument<512> doc;
    if (deserializeJson(doc, text) != DeserializationError::Ok) return;
    const char* type = doc["type"]|"";
    if      (!strcmp(type,"server/hello"))   handleServerHello(doc);
    else if (!strcmp(type,"server/time"))    handleServerTime(doc);
    else if (!strcmp(type,"stream/start"))   handleStreamStart(doc);
    else if (!strcmp(type,"stream/end"))     handleStreamEnd();
    else if (!strcmp(type,"stream/clear"))   handleStreamClear();
    else if (!strcmp(type,"server/command")) handleServerCommand(doc);
}

void handleBinaryMessage(const uint8_t* data, size_t len) {
    static const int HDR = 9;
    if (len < (size_t)(HDR+1) || data[0] != 4) return;
    int64_t serverTs=0;
    for(int i=0;i<8;i++) serverTs=(serverTs<<8)|(int64_t)data[1+i];
    const uint8_t* pcm = data+HDR;
    size_t pcmLen = len-HDR;
    if (audioState==AudioState::IDLE) return;
    if (firstChunkLocalTs==0) {
        firstChunkLocalTs = timeFilter.synced ? timeFilter.toLocalTime(serverTs) : serverTs;
        i2sStartTs = firstChunkLocalTs - DMA_LATENCY_US;
        Serial.printf("[Sync] First chunk: play in %.1f ms (sync=%d)\n",
            (float)(firstChunkLocalTs-localUs())/1000.0f, timeFilter.count);
    }
    if (!ringBuf->write(pcm, pcmLen)) {
        static unsigned long w=0;
        if(millis()-w>2000){w=millis(); Serial.println("WARN: Ring buffer full");}
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket callbacks
// ─────────────────────────────────────────────────────────────────────────────
void onWsMessage(WebsocketsMessage msg) {
    if (msg.isText()) handleJsonMessage(msg.data());
    else if (msg.isBinary()) handleBinaryMessage((const uint8_t*)msg.c_str(), msg.length());
}
void onWsEvent(WebsocketsEvent event, String data) {
    if (event==WebsocketsEvent::ConnectionOpened) {
        wsConnected=true; Serial.println("[WS] Connected"); sendClientHello();
    } else if (event==WebsocketsEvent::ConnectionClosed) {
        wsConnected=false; stopStream(); Serial.println("[WS] Disconnected");
    } else if (event==WebsocketsEvent::GotPing) wsClient.pong();
}
void connectWS() {
    if (wsConnected) return;
    if (millis()-lastWsRetryMs < 5000) return;
    lastWsRetryMs=millis();
    Serial.printf("[WS] Connecting %s:%d%s …\n", SS_HOST, SS_PORT, SS_PATH);
    wsClient.onMessage(onWsMessage); wsClient.onEvent(onWsEvent);
    wsClient.setMaxMessageSize(8192);
    wsClient.connect(SS_HOST, SS_PORT, SS_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// MQTT
// ─────────────────────────────────────────────────────────────────────────────
void mqttCallback(char* topic, byte* payload, unsigned int len) {
    String msg; msg.reserve(len);
    for (unsigned int i=0;i<len;i++) msg+=(char)payload[i];
    StaticJsonDocument<256> doc;
    if(deserializeJson(doc,msg)!=DeserializationError::Ok) return;
    const char* a=doc["action"]|"";
    if(!strcmp(a,"volume")) pendingMqtt={"volume",constrain((int)(doc["volume"]|currentVolume),0,100),true};
    else if(!strcmp(a,"stop")||!strcmp(a,"pause")) pendingMqtt={"stop",0,true};
}
void connectMQTT() {
    if(mqtt.connected())return;
    for(int t=0;t<3&&!mqtt.connected();t++){
        Serial.print("[MQTT] ...");
        if(mqtt.connect(DEVICE_NAME,MQTT_USER,MQTT_PASS)){
            Serial.println("OK");
            mqtt.subscribe(("audioauto/commands/"+String(DEVICE_NAME)).c_str(),1);
            mqtt.subscribe("audioauto/commands/all",1);
            StaticJsonDocument<128> reg; reg["name"]=DEVICE_NAME; reg["ip"]=WiFi.localIP().toString();
            char rb[128]; serializeJson(reg,rb);
            mqtt.publish("audioauto/register",rb,true);
            logMsg("Sendspin client online: "+String(DEVICE_NAME));
        } else { Serial.printf("fail(%d)\n",mqtt.state()); delay(2000); }
    }
}
void publishTelemetry() {
    StaticJsonDocument<256> doc;
    doc["ip"]=WiFi.localIP().toString(); doc["rssi"]=WiFi.RSSI();
    doc["ws_connected"]=wsConnected; doc["sync_count"]=timeFilter.count;
    doc["sync_offset_ms"]=(float)timeFilter.offsetMs();
    doc["audio_state"]=(audioState==AudioState::PLAYING)?"playing":
                       (audioState==AudioState::BUFFERING)?"buffering":"idle";
    if(ringBuf) { doc["buf_kb"]=(int)(ringBuf->available()/1024); doc["buf_cap_kb"]=(int)(ringBuf->capacity()/1024); }
    char buf[256]; serializeJson(doc,buf);
    mqtt.publish(("audioauto/telemetry/"+String(DEVICE_NAME)).c_str(),buf);
}

// ═════════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("\n╔═══════════════════════════════════╗");
    Serial.println("║  Audio-Auto ESP32-S3 N16R8 v5.0  ║");
    Serial.println("║  Sendspin Protocol / PCM Direct  ║");
    Serial.println("╚═══════════════════════════════════╝");
    Serial.println(DEVICE_NAME);

    // ── Allocate ring buffer (PSRAM) ─────────────────────────────────────────
    ringBuf = new PCMRingBuffer(RING_BUF_SIZE);
    if (!ringBuf->isAllocated()) {
        Serial.println("[FATAL] Ring buffer allocation failed — halting");
        while(true) delay(1000);
    }

    // ── WiFi ─────────────────────────────────────────────────────────────────
    wifiMulti.addAP(WIFI_SSID1,WIFI_PASS1);
    wifiMulti.addAP(WIFI_SSID2,WIFI_PASS2);
    wifiMulti.addAP(WIFI_SSID3,WIFI_PASS3);
    Serial.print("[WiFi] Connecting");
    while(wifiMulti.run()!=WL_CONNECTED){delay(500);Serial.print('.');}
    Serial.printf(" OK\n  SSID: %s\n  IP:   %s\n  RSSI: %d dBm\n",
        WiFi.SSID().c_str(),WiFi.localIP().toString().c_str(),WiFi.RSSI());

    // ── MQTT ─────────────────────────────────────────────────────────────────
    mqtt.setServer(MQTT_BROKER,MQTT_PORT);
    mqtt.setCallback(mqttCallback);
    mqtt.setBufferSize(512); mqtt.setKeepAlive(30);
    connectMQTT();

    // ── I2S ──────────────────────────────────────────────────────────────────
    setupI2S();

    // ── Sendspin WS ──────────────────────────────────────────────────────────
    connectWS();

    Serial.println("\n[Ready] Waiting for Sendspin stream…\n");
}

// ═════════════════════════════════════════════════════════════════════════════
void loop() {
    // 1. WebSocket
    if (wsConnected) wsClient.poll(); else connectWS();

    // 2. Pending MQTT command
    if (pendingMqtt.pending) {
        pendingMqtt.pending=false;
        if (pendingMqtt.action=="volume") {
            currentVolume=pendingMqtt.volume;
            if(wsConnected)sendClientState();
        } else if (pendingMqtt.action=="stop") stopStream();
    }

    // 3. Audio state machine
    if (audioState==AudioState::BUFFERING && firstChunkLocalTs>0) {
        if (localUs()>=i2sStartTs) {
            audioState=AudioState::PLAYING;
            Serial.println("[Sync] Playback started");
        }
    }
    if (audioState==AudioState::PLAYING) feedI2S();

    // 4. Clock sync heartbeat
    if (wsConnected) {
        unsigned long interval=(timeFilter.count<5)?250UL:1000UL;
        if (millis()-lastTimeSendMs>=interval) { lastTimeSendMs=millis(); sendClientTime(); }
    }

    // 5. WiFi watchdog
    if (millis()-lastWifiCheckMs>5000) {
        lastWifiCheckMs=millis();
        if(wifiMulti.run()!=WL_CONNECTED){ wsConnected=false; Serial.println("[WiFi] Reconnecting…"); }
    }

    // 6. MQTT
    if (millis()-lastMqttLoopMs>=10) {
        lastMqttLoopMs=millis();
        if(!mqtt.connected())connectMQTT();
        mqtt.loop();
    }

    // 7. Telemetry
    if (millis()-lastTelemetryMs>20000) {
        lastTelemetryMs=millis();
        if(mqtt.connected())publishTelemetry();
    }
}
