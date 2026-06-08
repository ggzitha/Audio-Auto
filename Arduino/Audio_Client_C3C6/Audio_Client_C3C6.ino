/**
 * Audio-Auto Client — ESP32-C6 / ESP32-C3  v5.1  (Sendspin Protocol)
 * ════════════════════════════════════════════════════════════════════
 *
 * v5.1 fixes vs v5.0:
 *   • I2S writing moved to a dedicated FreeRTOS task on Core 0
 *     → main loop (WiFi / WS / MQTT) runs freely on Core 1, no starvation
 *     → i2s_channel_write with portMAX_DELAY: I2S always stays fed
 *   • Ring buffer replaced with FreeRTOS StreamBuffer (thread-safe, no mutex needed)
 *   • REQUIRED_LEAD_TIME_MS raised to 500 ms (gives the stream buffer time to fill
 *     before the first I2S write)
 *   • Removed broken bytes_in_flight back-pressure (it never decremented → server
 *     silently stopped sending after 38 KB)
 *
 * ── REQUIREMENTS ─────────────────────────────────────────────────────────────
 *  Board package : Arduino ESP32 v3.x  (ESP-IDF v5, required for ESP32-C6)
 *  Libraries     : ArduinoWebsockets by Gil Maimon
 *                  PubSubClient by Nick O'Leary
 *                  ArduinoJson v6 or v7
 *
 * ── WIRING — PCM5102A → ESP32-C6 ─────────────────────────────────────────────
 *  PCM5102A  │  GPIO  │  Notes
 *  ──────────┼────────┼─────────────────────────────────────────────
 *  BCK       │   19   │  Bit Clock
 *  LCK/LRCK  │   18   │  Word Select
 *  DIN       │   20   │  Serial Data
 *  SCK/MCLK  │  GND   │  Tie LOW — enables PCM5102A internal PLL
 *  FMT       │  GND   │  I2S standard format
 *  XMT/XSMT  │  3.3V  │  *** MUST BE HIGH or no sound ***
 *  VCC       │  3.3V  │
 *  GND       │  GND   │
 *  LOUT/ROUT → 3.5 mm TRS jack
 */

// ── Chip-specific pin definitions ─────────────────────────────────────────────
#if defined(CONFIG_IDF_TARGET_ESP32C6)
  #define CHIP_NAME    "ESP32-C6"
  #define I2S_BCLK_PIN  19
  #define I2S_LRC_PIN   18
  #define I2S_DOUT_PIN  20
#elif defined(CONFIG_IDF_TARGET_ESP32C3)
  #define CHIP_NAME    "ESP32-C3"
  #define I2S_BCLK_PIN  5
  #define I2S_LRC_PIN   4
  #define I2S_DOUT_PIN  6
#else
  #error "This sketch targets ESP32-C6 or ESP32-C3."
#endif

// ── Library includes ─────────────────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiMulti.h>
#include <PubSubClient.h>
#include <ArduinoJson.h>
#include <ArduinoWebsockets.h>
#include "driver/i2s_std.h"          // ESP-IDF v5 I2S
#include "esp_timer.h"                // monotonic µs clock
#include "freertos/FreeRTOS.h"
#include "freertos/stream_buffer.h"   // thread-safe single-producer / single-consumer

using namespace websockets;

// ═════════════════════════════════════════════════════════════════════════════
// ▶  USER CONFIGURATION
// ═════════════════════════════════════════════════════════════════════════════

const char* DEVICE_NAME = "ESP32c6-Ruang-C001";

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

// Stream buffer: 80 KB = ~453 ms of 44100/16/stereo PCM.
// With REQUIRED_LEAD_TIME_MS=250ms, server sends at most 44KB before
// playback starts — leaves 36KB slack to absorb asyncio jitter bursts.
// (was 48KB; increased to survive bursts from slow WiFi ACK cycles)
static const size_t STREAM_BUF_SIZE = 80 * 1024;

// Lead time: tells the server how far ahead to stamp chunks.
// MUST be < (STREAM_BUF_SIZE / PCM_BYTES_SEC * 1000) = 453ms.
// 250ms lead → server sends 44KB max before i2sStartTs.
static const int    REQUIRED_LEAD_TIME_MS = 250;
static const int    MIN_BUFFER_MS         = 200;

// I2S DMA: 8 × 512 bytes = 4096 bytes ≈ 23 ms DMA latency at 176400 B/s.
static const int    DMA_BUF_COUNT  = 8;
static const size_t DMA_BUF_LEN   = 512;

// Minimum bytes in stream buffer before we begin I2S playback.
// With 200ms lead time, buffer has ~30KB by i2sStartTs; 16KB is comfortably met.
static const size_t MIN_PLAY_BYTES = 16 * 1024;   // ~90 ms

// DMA latency used in play-time scheduling
static const int64_t DMA_LATENCY_US =
    (int64_t)DMA_BUF_COUNT * (int64_t)DMA_BUF_LEN * 1000000LL / 176400LL;

static const int PCM_SAMPLE_RATE   = 44100;
static const int PCM_BYTES_FRAME   = 4;            // 2ch × 2 bytes
static const int PCM_BYTES_PER_SEC = 176400;

static const int INITIAL_VOLUME = 80;

// ═════════════════════════════════════════════════════════════════════════════

inline int64_t localUs() { return esp_timer_get_time(); }

// ─────────────────────────────────────────────────────────────────────────────
// Kalman Time Filter  (ported from sendspin-cpp/src/time_filter.cpp)
// ─────────────────────────────────────────────────────────────────────────────
class KalmanTimeFilter {
public:
    bool  synced = false;
    int   count  = 0;

    void reset() {
        count=0; _offset=0; _drift=0; _offCov=1e18;
        _driftCov=0; _odCov=0; _lastUpd=0; _useDrift=false; synced=false;
    }

    // T1=client_transmitted, T2=server_received, T3=server_transmitted, T4=local_now
    void update(int64_t T1, int64_t T2, int64_t T3, int64_t T4) {
        int64_t meas = ((T2-T1)+(T3-T4))/2;
        int64_t rtt  = (T4-T1)-(T3-T2); if (rtt<0) rtt=-rtt;
        _kalmanUpdate(meas, rtt/2, T4);
        synced = (count >= 3);
    }

    // Convert server monotonic µs → local ESP32 µs
    int64_t toLocalTime(int64_t serverTs) const {
        if (!synced) return serverTs;
        double effDrift = _useDrift ? _drift : 0.0;
        return (int64_t)round(
            ((double)serverTs - _offset + effDrift*(double)_lastUpd)
            / (1.0 + effDrift));
    }

    double offsetMs() const { return _offset / 1000.0; }

private:
    static constexpr double DRIFT_PROC_VAR = 1e-22;
    static constexpr double MAX_ERR_SCALE  = 0.5;
    static constexpr double DRIFT_SIG_SQ   = 4.0;

    double  _offset=0,_drift=0,_offCov=1e18,_driftCov=0,_odCov=0;
    int64_t _lastUpd=0;
    bool    _useDrift=false;

    void _kalmanUpdate(int64_t meas, int64_t maxErr, int64_t t) {
        if (count>0 && t<=_lastUpd) return;
        double mVar=(double)(maxErr*MAX_ERR_SCALE)*(double)(maxErr*MAX_ERR_SCALE);
        if (count==0) {_offset=(double)meas;_offCov=mVar;_lastUpd=t;count++;return;}
        double dt=(double)(t-_lastUpd);
        if (count==1) {
            _drift=((double)meas-_offset)/dt;
            _driftCov=(_offCov+mVar)/(dt*dt);
            _offset=(double)meas;_offCov=mVar;_lastUpd=t;count++;return;
        }
        double pO=_offset+_drift*dt,nDC=_driftCov+dt*DRIFT_PROC_VAR,
               nODC=_odCov+_driftCov*dt,nOC=_offCov+2*_odCov*dt+_driftCov*dt*dt;
        double innov=(double)meas-pO, Si=1.0/(nOC+mVar);
        double kO=nOC*Si, kD=nODC*Si;
        _offset=pO+kO*innov; _drift+=kD*innov;
        _driftCov=nDC-kD*nODC; _odCov=nODC-kD*nOC; _offCov=nOC-kO*nOC;
        _useDrift=(_drift*_drift>DRIFT_SIG_SQ*_driftCov);
        _lastUpd=t; if(count<255)count++;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// Globals
// ─────────────────────────────────────────────────────────────────────────────
WiFiMulti        wifiMulti;
WiFiClient       netClient;
PubSubClient     mqtt(netClient);
WebsocketsClient wsClient;
KalmanTimeFilter timeFilter;

// FreeRTOS stream buffer — single producer (WS task, Core 1),
// single consumer (I2S task, Core 0). Safe without a mutex.
StreamBufferHandle_t audioStream = NULL;

i2s_chan_handle_t i2sTxChan = nullptr;
bool i2sReady = false;

// Shared state between Core 1 (main) and Core 0 (I2S task).
// volatile ensures the compiler doesn't cache these in registers.
enum class AudioState : uint8_t { IDLE, BUFFERING, PLAYING };
volatile AudioState audioState = AudioState::IDLE;
volatile int     currentVolume = INITIAL_VOLUME;
volatile bool    currentMuted  = false;
volatile int64_t firstChunkLocalTs = 0;
volatile int64_t i2sStartTs        = 0;

// Underrun counter updated by I2S task, read by main for telemetry
volatile uint32_t underrunCount = 0;

bool wsConnected = false;

unsigned long lastTimeSendMs  = 0;
unsigned long lastTelemetryMs = 0;
unsigned long lastWifiCheckMs = 0;
unsigned long lastMqttLoopMs  = 0;
unsigned long lastWsRetryMs   = 0;

struct { String action; int volume; bool pending; } pendingMqtt = {"", 0, false};

// ─────────────────────────────────────────────────────────────────────────────
// Volume scaling (called from I2S task — reads volatile currentVolume/Muted)
// ─────────────────────────────────────────────────────────────────────────────
void applyVolume(uint8_t* buf, size_t len) {
    int vol  = currentVolume;   // snapshot volatile once
    bool mut = currentMuted;
    if (mut || vol == 0) { memset(buf, 0, len); return; }
    if (vol >= 100) return;
    float gain = ((float)vol / 100.0f);
    gain = gain * gain;   // squared-law perceptual
    int16_t* s = (int16_t*)buf;
    size_t n = len / 2;
    for (size_t i = 0; i < n; i++)
        s[i] = (int16_t)((float)s[i] * gain);
}

// ─────────────────────────────────────────────────────────────────────────────
// I2S (ESP-IDF v5)
// ─────────────────────────────────────────────────────────────────────────────
void setupI2S() {
    if (i2sReady) return;
    i2s_chan_config_t ch = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);
    ch.auto_clear = true;   // output silence on DMA underrun (not our ring buffer underrun)
    if (i2s_new_channel(&ch, &i2sTxChan, NULL) != ESP_OK) {
        Serial.println("[I2S] new_channel failed"); return;
    }
    i2s_std_config_t cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(PCM_SAMPLE_RATE),
        .slot_cfg = I2S_STD_MSB_SLOT_DEFAULT_CONFIG(
            I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = (gpio_num_t)I2S_BCLK_PIN,
            .ws   = (gpio_num_t)I2S_LRC_PIN,
            .dout = (gpio_num_t)I2S_DOUT_PIN,
            .din  = I2S_GPIO_UNUSED,
            .invert_flags = {.mclk_inv=false,.bclk_inv=false,.ws_inv=false},
        },
    };
    if (i2s_channel_init_std_mode(i2sTxChan, &cfg) != ESP_OK ||
        i2s_channel_enable(i2sTxChan) != ESP_OK) {
        Serial.println("[I2S] init failed");
        i2s_del_channel(i2sTxChan); i2sTxChan=nullptr; return;
    }
    i2sReady = true;
    Serial.printf("[I2S] Ready: %d Hz/16-bit/stereo  BCK=%d LRC=%d DOUT=%d\n",
        PCM_SAMPLE_RATE, I2S_BCLK_PIN, I2S_LRC_PIN, I2S_DOUT_PIN);
}

// ─────────────────────────────────────────────────────────────────────────────
// I2S Writer Task — runs on Core 0 with high priority.
// Completely decoupled from the WiFi / WebSocket / MQTT loop on Core 1.
// Uses portMAX_DELAY on both xStreamBufferReceive and i2s_channel_write so
// it never burns CPU when idle.
// ─────────────────────────────────────────────────────────────────────────────
static uint8_t i2sTaskBuf[DMA_BUF_LEN];

void i2sWriterTask(void* pvParam) {
    while (true) {
        if (audioState != AudioState::PLAYING || !i2sReady || !audioStream) {
            vTaskDelay(pdMS_TO_TICKS(5));
            continue;
        }

        // Block until stream buffer has at least 4 bytes (one stereo frame).
        // Timeout 10 ms: longer timeout allows I2S to wait for data without
        // spinning the task constantly, reducing CPU contention.
        size_t rx = xStreamBufferReceive(
            audioStream, i2sTaskBuf, DMA_BUF_LEN, pdMS_TO_TICKS(10));

        if (rx == 0) {
            // Timeout → underrun: fill with silence so I2S clock keeps running
            memset(i2sTaskBuf, 0, DMA_BUF_LEN);
            rx = DMA_BUF_LEN;
            underrunCount++;
        }

        // Align to stereo frame (4 bytes)
        rx &= ~3u;
        if (rx == 0) continue;

        applyVolume(i2sTaskBuf, rx);

        // portMAX_DELAY: block until DMA accepts the data.
        // This is correct here — Core 0 can wait; Core 1 is free to do WiFi.
        size_t written = 0;
        i2s_channel_write(i2sTxChan, i2sTaskBuf, rx, &written, portMAX_DELAY);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin stream control
// ─────────────────────────────────────────────────────────────────────────────
void stopStream() {
    audioState        = AudioState::IDLE;
    firstChunkLocalTs = 0;
    i2sStartTs        = 0;
    // Drain stream buffer (xStreamBufferReset is not safe if task is reading,
    // so use a large receive with timeout 0 to quickly empty it)
    if (audioStream) {
        uint8_t tmp[256];
        while (xStreamBufferReceive(audioStream, tmp, sizeof(tmp), 0) > 0) {}
    }
    Serial.println("[Sendspin] Stream stopped");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin outgoing messages
// ─────────────────────────────────────────────────────────────────────────────
void sendClientHello() {
    StaticJsonDocument<768> doc;
    doc["type"]="client/hello"; 
    JsonObject payload = doc.createNestedObject("payload");
    payload["client_id"]=DEVICE_NAME;
    payload["name"]=DEVICE_NAME;    payload["version"]=1;

    JsonArray roles=payload.createNestedArray("supported_roles");
    roles.add("player@v1"); roles.add("controller@v1");

    JsonObject ps=payload.createNestedObject("player@v1_support");
    JsonArray fmts=ps.createNestedArray("supported_formats");
    JsonObject f=fmts.createNestedObject();
    f["codec"]="pcm"; f["sample_rate"]=PCM_SAMPLE_RATE;
    f["channels"]=2;  f["bit_depth"]=16;
    // Do NOT advertise buffer_capacity — the broken back-pressure on the server
    // would stop sending after capacity bytes. Set to 0 to disable it.
    ps["buffer_capacity"] = 0;
    JsonArray cmds=ps.createNestedArray("supported_commands");
    cmds.add("volume"); cmds.add("mute");

    char buf[768]; serializeJson(doc,buf);
    wsClient.send(buf);
    Serial.println("[Sendspin] → client/hello");
}

void sendClientState() {
    StaticJsonDocument<384> doc;
    doc["type"]="client/state"; 
    JsonObject payload = doc.createNestedObject("payload");
    payload["state"]="synchronized";
    JsonObject p=payload.createNestedObject("player");
    p["volume"]=currentVolume; p["muted"]=currentMuted;
    p["static_delay_ms"]=0;
    p["required_lead_time_ms"]=REQUIRED_LEAD_TIME_MS;
    p["min_buffer_ms"]=MIN_BUFFER_MS;
    char buf[384]; serializeJson(doc,buf);
    wsClient.send(buf);
}

void sendClientTime() {
    int64_t T1=localUs();
    StaticJsonDocument<192> doc;
    doc["type"]="client/time";
    JsonObject payload = doc.createNestedObject("payload");
    payload["client_transmitted"]=(double)T1;
    char buf[192]; serializeJson(doc,buf);
    wsClient.send(buf);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin incoming message handlers
// ─────────────────────────────────────────────────────────────────────────────
void handleServerHello(JsonDocument& doc) {
    JsonObject payload = doc["payload"];
    Serial.printf("[Sendspin] ← server/hello  id=%s\n",(const char*)(payload["server_id"]|"?"));
    sendClientState(); sendClientTime(); lastTimeSendMs=millis();
}

void handleServerTime(JsonDocument& doc) {
    int64_t T4=localUs();
    JsonObject payload = doc["payload"];
    double T1d=payload["client_transmitted"]|0.0;
    double T2d=payload["server_received"]    |0.0;
    double T3d=payload["server_transmitted"] |0.0;
    timeFilter.update((int64_t)T1d,(int64_t)T2d,(int64_t)T3d,T4);
    if (timeFilter.count<=6) {
        int64_t rtt=(T4-(int64_t)T1d)-((int64_t)T3d-(int64_t)T2d);
        Serial.printf("[Sync] #%d  offset=%.2f ms  RTT=%.2f ms\n",
            timeFilter.count, timeFilter.offsetMs(), rtt/1000.0);
    }
}

void handleStreamStart(JsonDocument& doc) {
    JsonObject payload = doc["payload"];
    const char* codec=payload["player"]["codec"]|"?";
    Serial.printf("[Sendspin] ← stream/start  codec=%s\n",codec);
    stopStream();
    if (!i2sReady) setupI2S();
    audioState=AudioState::BUFFERING;
    Serial.println("[Sendspin] Buffering...");
}

void handleStreamEnd()  { Serial.println("[Sendspin] ← stream/end");  stopStream(); }
void handleStreamClear() {
    Serial.println("[Sendspin] ← stream/clear (seek)");
    // Drain without fully stopping
    if (audioStream) {
        uint8_t tmp[256];
        while (xStreamBufferReceive(audioStream,tmp,sizeof(tmp),0)>0) {}
    }
    firstChunkLocalTs=0; i2sStartTs=0;
    audioState=AudioState::BUFFERING;
}

void handleServerCommand(JsonDocument& doc) {
    JsonObject payload = doc["payload"];
    JsonObject p=payload["player"]; if(p.isNull())return;
    if(p.containsKey("volume")) {
        currentVolume=constrain((int)p["volume"],0,100);
        Serial.printf("[Sendspin] Volume → %d\n",currentVolume);
        sendClientState();
    }
    if(p.containsKey("mute")) {
        currentMuted=(bool)p["mute"];
        Serial.printf("[Sendspin] Mute → %s\n",currentMuted?"on":"off");
        sendClientState();
    }
}

void handleJsonMessage(const String& text) {
    StaticJsonDocument<1024> doc;
    if (deserializeJson(doc,text)!=DeserializationError::Ok) return;
    const char* type=doc["type"]|"";
    if      (!strcmp(type,"server/hello"))   handleServerHello(doc);
    else if (!strcmp(type,"server/time"))    handleServerTime(doc);
    else if (!strcmp(type,"stream/start"))   handleStreamStart(doc);
    else if (!strcmp(type,"stream/end"))     handleStreamEnd();
    else if (!strcmp(type,"stream/clear"))   handleStreamClear();
    else if (!strcmp(type,"server/command")) handleServerCommand(doc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary audio frame handler (runs on Core 1 — WS callback)
//
// Sendspin Type 4 frame:
//   byte[0]    = 4  (frame type)
//   byte[1..8] = server timestamp µs (int64 big-endian)
//   byte[9..N] = raw PCM signed 16-bit LE stereo
// ─────────────────────────────────────────────────────────────────────────────
void handleBinaryMessage(const uint8_t* data, size_t len) {
    static const int HDR = 9;
    if (len < (size_t)(HDR+1) || data[0] != 4) return;
    if (audioState == AudioState::IDLE) return;

    // Parse big-endian int64 server timestamp
    int64_t serverTs = 0;
    for (int i=0; i<8; i++) serverTs=(serverTs<<8)|(int64_t)data[1+i];

    const uint8_t* pcm = data + HDR;
    size_t pcmLen = len - HDR;

    // Capture local play time from first chunk's timestamp
    if (firstChunkLocalTs == 0) {
        int64_t localPlayTs = timeFilter.synced
            ? timeFilter.toLocalTime(serverTs)
            : (serverTs);   // no sync yet: use raw (may be slightly off)

        firstChunkLocalTs = localPlayTs;
        // Start I2S DMA writes DMA_LATENCY_US before the play time.
        // Also wait until MIN_PLAY_BYTES are buffered so I2S never starves.
        // i2sStartTs is rechecked in the main loop state machine.
        i2sStartTs = localPlayTs - DMA_LATENCY_US;

        float aheadMs = (float)(localPlayTs - localUs()) / 1000.0f;
        Serial.printf("[Sync] First chunk: play in %.1f ms  (syncCount=%d)\n",
            aheadMs, timeFilter.count);
    }

    // Push PCM into the stream buffer.
    // xStreamBufferSend with timeout 0: if buffer full, drop the chunk
    // (server will send the next one 5.7 ms later).
    if (audioStream) {
        size_t sent = xStreamBufferSend(audioStream, pcm, pcmLen, 0);
        if (sent < pcmLen) {
            // Buffer full — only log occasionally to avoid flooding Serial
            static unsigned long lastWarnMs = 0;
            if (millis()-lastWarnMs > 2000) {
                lastWarnMs=millis();
                Serial.println("WARN: Stream buffer full — chunk dropped");
            }
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket callbacks
// ─────────────────────────────────────────────────────────────────────────────
void onWsMessage(WebsocketsMessage msg) {
    if (msg.isText())
        handleJsonMessage(msg.data());
    else if (msg.isBinary())
        handleBinaryMessage((const uint8_t*)msg.c_str(), msg.length());
}

void onWsEvent(WebsocketsEvent event, String data) {
    if (event==WebsocketsEvent::ConnectionOpened) {
        wsConnected=true;
        Serial.println("[WS] Connected");
        sendClientHello();
    } else if (event==WebsocketsEvent::ConnectionClosed) {
        wsConnected=false;
        stopStream();
        Serial.println("[WS] Disconnected");
    } else if (event==WebsocketsEvent::GotPing) {
        wsClient.pong();
    }
}

void connectWS() {
    if (wsConnected) return;
    if (millis()-lastWsRetryMs < 5000) return;
    lastWsRetryMs=millis();
    Serial.printf("[WS] Connecting %s:%d%s ...\n",SS_HOST,SS_PORT,SS_PATH);
    wsClient.onMessage(onWsMessage);
    wsClient.onEvent(onWsEvent);
    // ArduinoWebsockets v0.5.4 default max is 32 KB — fits our 1017-byte frames.
    wsClient.connect(SS_HOST,SS_PORT,SS_PATH);
}

// ─────────────────────────────────────────────────────────────────────────────
// MQTT (telemetry only)
// ─────────────────────────────────────────────────────────────────────────────
void logMsg(const String& msg) {
    Serial.println(msg);
    if (mqtt.connected())
        mqtt.publish(("audioauto/log/"+String(DEVICE_NAME)).c_str(), msg.c_str());
}

void mqttCallback(char* topic, byte* payload, unsigned int len) {
    String msg; msg.reserve(len);
    for (unsigned int i=0;i<len;i++) msg+=(char)payload[i];
    StaticJsonDocument<256> doc;
    if(deserializeJson(doc,msg)!=DeserializationError::Ok) return;
    const char* a=doc["action"]|"";
    if(!strcmp(a,"volume"))
        pendingMqtt={"volume",constrain((int)(doc["volume"]|currentVolume),0,100),true};
    else if(!strcmp(a,"stop")||!strcmp(a,"pause"))
        pendingMqtt={"stop",0,true};
}

void connectMQTT() {
    if(mqtt.connected())return;
    for(int t=0;t<3&&!mqtt.connected();t++){
        Serial.print("[MQTT] ...");
        if(mqtt.connect(DEVICE_NAME,MQTT_USER,MQTT_PASS)){
            Serial.println("OK");
            mqtt.subscribe(("audioauto/commands/"+String(DEVICE_NAME)).c_str(),1);
            mqtt.subscribe("audioauto/commands/all",1);
            StaticJsonDocument<128> reg;
            reg["name"]=DEVICE_NAME; reg["ip"]=WiFi.localIP().toString();
            char rb[128]; serializeJson(reg,rb);
            mqtt.publish("audioauto/register",rb,true);
            logMsg("Sendspin client online: "+String(DEVICE_NAME));
        } else { Serial.printf("fail(%d)\n",mqtt.state()); delay(2000); }
    }
}

void publishTelemetry() {
    StaticJsonDocument<256> doc;
    doc["ip"]=WiFi.localIP().toString(); doc["rssi"]=WiFi.RSSI();
    doc["ws_connected"]=wsConnected;
    doc["sync_count"]=timeFilter.count;
    doc["sync_offset_ms"]=(float)timeFilter.offsetMs();
    doc["audio_state"]=(audioState==AudioState::PLAYING) ?"playing":
                       (audioState==AudioState::BUFFERING)?"buffering":"idle";
    if (audioStream) {
        size_t inBuf = STREAM_BUF_SIZE - xStreamBufferSpacesAvailable(audioStream);
        doc["buf_kb"]=(int)(inBuf/1024);
    }
    doc["underruns"]=underrunCount;
    char buf[256]; serializeJson(doc,buf);
    mqtt.publish(("audioauto/telemetry/"+String(DEVICE_NAME)).c_str(),buf);
}

// ═════════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.printf("\n╔═══════════════════════════════════╗\n"
                  "║  Audio-Auto %-10s v5.1    ║\n"
                  "║  Sendspin Protocol / PCM Direct   ║\n"
                  "╚═══════════════════════════════════╝\n", CHIP_NAME);
    Serial.println(DEVICE_NAME);

    // ── Stream buffer (FreeRTOS) ─────────────────────────────────────────────
    // xTriggerLevel=1: unblock receiver after any byte arrives.
    audioStream = xStreamBufferCreate(STREAM_BUF_SIZE, 1);
    if (!audioStream) {
        Serial.println("[FATAL] Stream buffer alloc failed — halting");
        while(true) delay(1000);
    }
    Serial.printf("[Init] Stream buffer: %d KB (~%d ms)\n",
        (int)(STREAM_BUF_SIZE/1024),
        (int)(STREAM_BUF_SIZE*1000/PCM_BYTES_PER_SEC));

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

    // ── I2S writer task ───────────────────────────────────────────────────
    // Priority 1 = same as Arduino loopTask on ESP32-C6 (single RISC-V core).
    // Equal priority → FreeRTOS round-robins: I2S task and WiFi/WS/MQTT share
    // time fairly.  Priority 5 was causing I2S to preempt wsClient.poll()
    // mid-execution, destabilising the WebSocket connection on single-core.
    // With REQUIRED_LEAD_TIME_MS=200ms there should be no underruns, so the
    // task spends most time blocked on DMA (fully yielding to others).
    BaseType_t ret = xTaskCreatePinnedToCore(
        i2sWriterTask,
        "i2s_write",
        4096,
        NULL,
        1,      // same priority as loopTask → fair round-robin
        NULL,
        0       // ignored on single-core C6; core param kept for portability
    );
    if (ret != pdPASS) {
        Serial.println("[FATAL] I2S task create failed — halting");
        while(true) delay(1000);
    }
    Serial.println("[Init] I2S writer task → priority 1 (round-robin with loop)");

    // ── Sendspin WS ──────────────────────────────────────────────────────────
    connectWS();

    Serial.println("\n[Ready] Waiting for Sendspin stream...\n");
}

// ═════════════════════════════════════════════════════════════════════════════
void loop() {
    // Core 1 — WiFi / WebSocket / MQTT / timing / watchdog
    // The I2S task on Core 0 handles all audio output autonomously.

    // ── 1. WebSocket ─────────────────────────────────────────────────────────
    if (wsConnected)
        wsClient.poll();
    else
        connectWS();

    // ── 2. MQTT command (from callback, deferred to main loop) ───────────────
    if (pendingMqtt.pending) {
        pendingMqtt.pending=false;
        if (pendingMqtt.action=="volume") {
            currentVolume=pendingMqtt.volume;
            if(wsConnected) sendClientState();
            logMsg("Volume → "+String(currentVolume));
        } else if (pendingMqtt.action=="stop") {
            stopStream();
        }
    }

    // ── 3. Audio state machine: BUFFERING → PLAYING transition ───────────────
    if (audioState==AudioState::BUFFERING && firstChunkLocalTs>0) {
        // Wait until:
        //   a) it's time to start playing (i2sStartTs reached), AND
        //   b) the stream buffer has at least MIN_PLAY_BYTES of data.
        // This prevents starting I2S before the buffer is comfortably filled.
        int64_t now = localUs();
        size_t  inBuf = STREAM_BUF_SIZE - xStreamBufferSpacesAvailable(audioStream);
        if (now >= i2sStartTs && inBuf >= MIN_PLAY_BYTES) {
            audioState = AudioState::PLAYING;
            float lateMs = max(0LL, now - i2sStartTs) / 1000.0f;
            Serial.printf("[Sync] Playback started  buf=%d KB%s\n",
                (int)(inBuf/1024),
                lateMs>1.0f ? ("  LATE "+String(lateMs,1)+"ms").c_str() : "");
        }
    }

    // ── 4. Log underruns (periodically, not from I2S task to avoid race) ─────
    static uint32_t lastUnderrunReport = 0;
    if (underrunCount > lastUnderrunReport) {
        if (millis() - lastTelemetryMs > 1000) {  // throttle to 1s
            Serial.printf("WARN: I2S underrun x%lu\n",
                (unsigned long)(underrunCount - lastUnderrunReport));
            lastUnderrunReport = underrunCount;
        }
    }

    // ── 5. Clock sync heartbeat ───────────────────────────────────────────────
    if (wsConnected) {
        unsigned long interval=(timeFilter.count<5)?250UL:1000UL;
        if (millis()-lastTimeSendMs>=interval){
            lastTimeSendMs=millis();
            sendClientTime();
        }
    }

    // ── 6. WiFi watchdog ─────────────────────────────────────────────────────
    if (millis()-lastWifiCheckMs>5000) {
        lastWifiCheckMs=millis();
        if(wifiMulti.run()!=WL_CONNECTED){
            wsConnected=false;
            Serial.println("[WiFi] Reconnecting...");
        }
    }

    // ── 7. MQTT ───────────────────────────────────────────────────────────────
    if (millis()-lastMqttLoopMs>=10){
        lastMqttLoopMs=millis();
        if(!mqtt.connected()) connectMQTT();
        mqtt.loop();
    }

    // ── 8. Telemetry (every 20 s) ─────────────────────────────────────────────
    if (millis()-lastTelemetryMs>20000){
        lastTelemetryMs=millis();
        if(mqtt.connected()) publishTelemetry();
    }
}
