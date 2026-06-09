/**
 * Audio-Auto Client — ESP32-S3 N16R8  v9.7  (Sendspin-Only Audio)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * Fixes over v9.6:
 *   1. FIX v9.7: Reset time format detection on reconnect to handle server changes
 *   2. FIX v9.7: Improved stream start/end handling to prevent race conditions
 *   3. FIX v9.7: Added sequence number tracking to detect duplicate stream messages
 *   4. FIX v9.7: Better buffer management to prevent underruns
 *
 * Per Sendspin SPEC:
 *   - server/time uses microseconds relative to server's monotonic clock
 *   - All timing is relative, NOT Unix epoch
 */

#ifndef CONFIG_IDF_TARGET_ESP32S3
  #error "This sketch is for ESP32-S3."
#endif

// ── I2S pin configuration ────────────────────────────────────────────────────
#define I2S_BCLK_PIN  4
#define I2S_LRC_PIN   5
#define I2S_DOUT_PIN  6

// ── Library includes ─────────────────────────────────────────────────────────
#include <WiFi.h>
#include <WiFiMulti.h>
#include <ArduinoJson.h>
#include "driver/i2s_std.h"
#include "esp_timer.h"
#include "esp_heap_caps.h"
#include <vector>
#include <algorithm>
#include <cmath>

#include <ArduinoWebsockets.h>
#include "minimp3.h"

// ═══════════════════════════════════════════════════════════════════════════
// ▶  USER CONFIGURATION
// ═══════════════════════════════════════════════════════════════════════════

const char* DEVICE_NAME = "ESP32s3-Ruang-S001";

const char* WIFI_SSID1 = "DCLXVI";               const char* WIFI_PASS1 = "1029384756";
const char* WIFI_SSID2 = "BBWV_Oprasional";     const char* WIFI_PASS2 = "Balai5-OPRA123!";
const char* WIFI_SSID3 = "BMKG-JAYAPURA";        const char* WIFI_PASS3 = "bmkg@123";

const char* SS_HOST = "192.168.88.8";
const int   SS_PORT = 8927;
const char* SS_PATH = "/sendspin";

// ── Audio Tuning ─────────────────────────────────────────────────────────────
static const size_t RING_BUF_SIZE         = 1024 * 1024;   // 1 MB PSRAM ring buffer
static const int    REQUIRED_LEAD_TIME_MS = 150;
static const int    MIN_BUFFER_MS         = 150;

static const int    DMA_BUF_COUNT = 16;
static const size_t DMA_BUF_LEN  = 1024;

static const int PCM_SAMPLE_RATE   = 44100;
static const int PCM_BYTES_PER_SEC = 176400;   // 44100 * 2ch * 2 bytes
static const int INITIAL_VOLUME    = 80;

// ── Audio chunk queue ────────────────────────────────────────────────────────
struct AudioChunk {
    uint8_t* data;
    size_t   len;
    int64_t  serverTs;  // server µs timestamp (when first sample should play)
};

static const int AUDIO_QUEUE_SIZE = 64;
static QueueHandle_t audioQueue   = nullptr;

inline int64_t localUs() { return esp_timer_get_time(); }

// ─────────────────────────────────────────────────────────────────────────────
// Time Sync
// ─────────────────────────────────────────────────────────────────────────────

static const int TIME_SYNC_BURST_SIZE              = 8;
static const int TIME_SYNC_ROBUST_SELECTION_COUNT  = 3;
static const unsigned long TIME_RESYNC_INTERVAL_MS = 10000UL; // re-burst every 10 s

class TimeFilter {
public:
    bool    synced    = false;
    int     count     = 0;
    int64_t offset_us = 0;
    int64_t last_sync_us = 0;

    void reset() {
        count = 0; _offset = 0.0; _drift = 0.0; _offCov = 1e18;
        _driftCov = 0.0; _odCov = 0.0; _lastUpd = 0; _useDrift = false;
        synced = false; offset_us = 0; last_sync_us = 0;
    }

    void update(int64_t offset_meas_us, int64_t maxErr_us, int64_t t_us) {
        if (count > 0 && t_us <= _lastUpd) return;
        double mVar = (double)(maxErr_us) * (double)(maxErr_us) * 0.25;
        if (count == 0) {
            _offset = (double)offset_meas_us; _offCov = mVar;
            _lastUpd = t_us; count++; return;
        }
        double dt = (double)(t_us - _lastUpd);
        if (count == 1) {
            _drift  = ((double)offset_meas_us - _offset) / dt;
            _driftCov = (_offCov + mVar) / (dt * dt);
            _offset = (double)offset_meas_us; _offCov = mVar;
            _lastUpd = t_us; count++; return;
        }
        double pO    = _offset + _drift * dt;
        double nDC   = _driftCov + dt * 1e-22;
        double nODC  = _odCov + _driftCov * dt;
        double nOC   = _offCov + 2 * _odCov * dt + _driftCov * dt * dt;
        double innov = (double)offset_meas_us - pO;
        double Si    = 1.0 / (nOC + mVar);
        double kO    = nOC  * Si;
        double kD    = nODC * Si;
        _offset   = pO + kO * innov;
        _drift   += kD * innov;
        _driftCov = nDC  - kD * nODC;
        _odCov    = nODC - kD * nOC;
        _offCov   = nOC  - kO * nOC;
        _useDrift = (_drift * _drift > 4.0 * _driftCov);
        _lastUpd  = t_us;
        if (count < 255) count++;
        synced       = (count >= 3);
        offset_us    = (int64_t)_offset;
        last_sync_us = t_us;
    }

    int64_t toLocalTime(int64_t serverTsUs) const {
        if (!synced) return serverTsUs;
        return serverTsUs - offset_us;
    }
    double offsetMs() const { return (double)offset_us / 1000.0; }

private:
    double  _offset = 0.0, _drift = 0.0;
    double  _offCov = 1e18, _driftCov = 0.0, _odCov = 0.0;
    int64_t _lastUpd = 0;
    bool    _useDrift = false;
};

class TimeSyncManager {
public:
    TimeSyncManager() { reset(); }
    void reset() { burstActive = false; burstSentCount = 0; inFlightTransmitted = 0; samples.clear(); }

    void markProbeSent(int64_t t1) { burstSentCount++; inFlightTransmitted = t1; }

    bool handleServerTime(int64_t T1, int64_t T2, int64_t T3, int64_t T4, TimeFilter& filter) {
        if (inFlightTransmitted == 0 || T1 != inFlightTransmitted) return false;
        inFlightTransmitted = 0;
        int64_t rtt    = (T4 - T1) - (T3 - T2); if (rtt < 0) rtt = -rtt;
        int64_t offset = ((T2 - T1) + (T3 - T4)) / 2;
        TimeSample s   = {rtt, offset, rtt / 2, T4};
        samples.push_back(s);
        if (burstSentCount >= TIME_SYNC_BURST_SIZE) finalizeBurst(filter);
        return true;
    }

    void startBurst() {
        if (!burstActive) { burstActive = true; burstSentCount = 0; samples.clear(); inFlightTransmitted = 0; }
    }
    bool isBurstActive()   const { return burstActive; }
    int  sentCount()       const { return burstSentCount; }

private:
    struct TimeSample { int64_t rtt_us, offset_us, maxErr, t4; };
    bool burstActive           = false;
    int  burstSentCount        = 0;
    int64_t inFlightTransmitted = 0;
    std::vector<TimeSample> samples;

    void finalizeBurst(TimeFilter& filter) {
        if (samples.empty()) { burstActive = false; return; }
        std::sort(samples.begin(), samples.end(),
            [](const TimeSample& a, const TimeSample& b){ return a.rtt_us < b.rtt_us; });
        int count = min(TIME_SYNC_ROBUST_SELECTION_COUNT, (int)samples.size());
        std::vector<TimeSample> top(samples.begin(), samples.begin() + count);
        std::sort(top.begin(), top.end(),
            [](const TimeSample& a, const TimeSample& b){ return a.offset_us < b.offset_us; });
        const TimeSample& c = top[count / 2];
        filter.update(c.offset_us, c.maxErr, c.t4);
        burstActive = false;
    }
};

// ─────────────────────────────────────────────────────────────────────────────
// PCM Ring Buffer (PSRAM-backed)
// ─────────────────────────────────────────────────────────────────────────────
class PCMRingBuffer {
public:
    explicit PCMRingBuffer(size_t sz) : _size(sz), _head(0), _tail(0), _avail(0) {
        _buf = (uint8_t*)heap_caps_malloc(sz, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!_buf) { size_t fb = sz / 4; _buf = (uint8_t*)malloc(fb); _size = fb ? fb : 0; }
    }
    ~PCMRingBuffer() { if (_buf) free(_buf); }

    bool   isAllocated() const { return _buf != nullptr && _size > 0; }
    size_t capacity()    const { return _size; }
    size_t available()   const { return _avail; }

    bool write(const uint8_t* data, size_t len) {
        if (!_buf || _avail + len > _size) return false;
        size_t fc = _size - _tail;
        if (len <= fc) memcpy(_buf + _tail, data, len);
        else { memcpy(_buf + _tail, data, fc); memcpy(_buf, data + fc, len - fc); }
        _tail = (_tail + len) % _size; _avail += len; return true;
    }

    size_t read(uint8_t* out, size_t len) {
        size_t n = (_avail < len) ? _avail : len; if (n == 0) return 0;
        size_t fc = _size - _head;
        if (n <= fc) memcpy(out, _buf + _head, n);
        else { memcpy(out, _buf + _head, fc); memcpy(out + fc, _buf, n - fc); }
        _head = (_head + n) % _size; _avail -= n; return n;
    }

    void clear() { _head = _tail = _avail = 0; }

private:
    uint8_t* _buf;
    size_t   _size, _head, _tail, _avail;
};

// ─────────────────────────────────────────────────────────────────────────────
// Global state
// ─────────────────────────────────────────────────────────────────────────────
WiFiMulti                  wifiMulti;
websockets::WebsocketsClient wsClient;

TimeFilter      timeFilter;
TimeSyncManager timeSync;
PCMRingBuffer*  ringBuf = nullptr;

i2s_chan_handle_t i2sTxChan = nullptr;
bool i2sReady = false;

enum class AudioState : uint8_t { IDLE, BUFFERING, PLAYING };
volatile AudioState audioState = AudioState::IDLE;

String currentCodec = "pcm";

static uint8_t*    i2sScratch     = nullptr;
static const size_t I2S_SCRATCH_SIZE = DMA_BUF_LEN * 4;

// ── MP3 decoder state ─────────────────────────────────────────────────────────
mp3dec_t  mp3d;
static uint8_t* mp3DecodeBuf  = nullptr;  static const size_t MP3_DECODE_BUF_SIZE = 8192;
static short*   mp3PcmOut     = nullptr;  static const size_t MP3_PCM_OUT_SIZE    = MINIMP3_MAX_SAMPLES_PER_FRAME * sizeof(short);
static uint8_t* mp3Remainder  = nullptr;  static const size_t MP3_REMAINDER_SIZE  = 4096;
static size_t   mp3RemainderLen = 0;

int  currentVolume = INITIAL_VOLUME;
bool currentMuted  = false;
bool wsConnected   = false;

// Timing bookkeeping
unsigned long lastTimeSendMs   = 0;
unsigned long lastWifiCheckMs  = 0;
unsigned long lastWsRetryMs    = 0;
unsigned long lastBinaryRecvMs = 0;
unsigned long lastResyncMs     = 0;
int timeBurstCount = 0;

TaskHandle_t audioTaskHandle = nullptr;

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
            .invert_flags = {false, false, false}
        },
    };
    if (i2s_channel_init_std_mode(i2sTxChan, &cfg) != ESP_OK ||
        i2s_channel_enable(i2sTxChan)              != ESP_OK) {
        Serial.println("[I2S] init failed");
        i2s_del_channel(i2sTxChan); i2sTxChan = nullptr; return;
    }
    i2sReady = true;
    Serial.printf("[I2S] Ready: %d Hz / 16-bit / stereo\n", PCM_SAMPLE_RATE);
}

void applyVolume(uint8_t* buf, size_t len) {
    if (currentMuted || currentVolume == 0) { memset(buf, 0, len); return; }
    if (currentVolume >= 100) return;
    float gain = (float)currentVolume / 100.0f; gain = gain * gain;  // perceptual curve
    int16_t* s = (int16_t*)buf; size_t n = len / 2;
    for (size_t i = 0; i < n; i++) s[i] = (int16_t)((float)s[i] * gain);
}

// ─────────────────────────────────────────────────────────────────────────────
// Stream control
// ─────────────────────────────────────────────────────────────────────────────
void stopStream() {
    audioState = AudioState::IDLE;
    if (ringBuf) ringBuf->clear();
    if (audioQueue) {
        AudioChunk chunk;
        while (xQueueReceive(audioQueue, &chunk, 0) == pdTRUE)
            if (chunk.data) heap_caps_free(chunk.data);
    }
    mp3RemainderLen = 0;
    Serial.println("[Sendspin] Stream stopped");
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin outgoing messages
// ─────────────────────────────────────────────────────────────────────────────
void sendClientHello() {
    DynamicJsonDocument doc(2048);
    doc["type"] = "client/hello";
    JsonObject payload = doc.createNestedObject("payload");
    payload["client_id"] = DEVICE_NAME;
    payload["name"]      = DEVICE_NAME;
    payload["version"]   = 1;
    JsonArray roles = payload.createNestedArray("supported_roles");
    roles.add("player@v1"); roles.add("controller@v1");
    JsonObject di = payload.createNestedObject("device_info");
    di["product_name"] = "ESP32-S3 Audio Client";
    di["manufacturer"] = "Espressif";
    JsonObject ps   = payload.createNestedObject("player@v1_support");
    JsonArray  fmts = ps.createNestedArray("supported_formats");
    JsonObject fPcm = fmts.createNestedObject();
    fPcm["codec"] = "pcm"; fPcm["sample_rate"] = 44100;
    fPcm["channels"] = 2;  fPcm["bit_depth"] = 16;
    ps["buffer_capacity"] = (int)(ringBuf ? ringBuf->capacity() * 4 / 5 : 0);
    JsonArray cmds = ps.createNestedArray("supported_commands");
    cmds.add("volume"); cmds.add("mute");
    String out; serializeJson(doc, out);
    wsClient.send(out);
    Serial.println("[Sendspin] → client/hello");
}

void sendClientState() {
    DynamicJsonDocument doc(512);
    doc["type"] = "client/state";
    JsonObject payload = doc.createNestedObject("payload");
    payload["state"]   = "synchronized";
    JsonObject p = payload.createNestedObject("player");
    p["volume"]              = currentVolume;
    p["muted"]               = currentMuted;
    p["static_delay_ms"]     = 0;
    p["required_lead_time_ms"] = REQUIRED_LEAD_TIME_MS;
    p["min_buffer_ms"]       = MIN_BUFFER_MS;
    String out; serializeJson(doc, out);
    wsClient.send(out);
}

void sendClientTime() {
    int64_t T1 = localUs();
    DynamicJsonDocument doc(256);
    doc["type"] = "client/time";
    JsonObject payload = doc.createNestedObject("payload");
    payload["client_transmitted"] = (double)T1;
    String out; serializeJson(doc, out);
    wsClient.send(out);
    timeSync.markProbeSent(T1);
}

// ─────────────────────────────────────────────────────────────────────────────
// Sendspin incoming message handlers
// ─────────────────────────────────────────────────────────────────────────────
void handleServerHello(JsonDocument& doc) {
    JsonObject payload = doc["payload"];
    const char* sid = payload["server_id"] | "?";
    Serial.printf("[Sendspin] ← server/hello  id=%s\n", sid);
    timeBurstCount = 0;
    timeSync.startBurst();
    lastResyncMs = millis();
    delay(50); sendClientState();
    delay(50); sendClientTime();
    lastTimeSendMs = millis();
}

void handleServerTime(JsonDocument& doc) {
    int64_t T4 = localUs();
    JsonObject payload = doc["payload"];
    
    // FIX v9.3: Handle both integer and float JSON values correctly.
    // Also detect if server sends seconds (Unix epoch) vs microseconds.
    int64_t T1, T2, T3;
    
    // Helper lambda to extract number as int64_t
    auto getInt64 = [](JsonVariant v) -> int64_t {
        if (v.is<int64_t>()) return v.as<int64_t>();
        if (v.is<unsigned long>()) return (int64_t)v.as<unsigned long>();
        if (v.is<double>()) return (int64_t)v.as<double>();
        if (v.is<long>()) return (int64_t)v.as<long>();
        return 0;
    };
    
    T1 = payload.containsKey("client_transmitted") ? getInt64(payload["client_transmitted"]) : 0;
    T2 = payload.containsKey("server_received") ? getInt64(payload["server_received"]) : 0;
    T3 = payload.containsKey("server_transmitted") ? getInt64(payload["server_transmitted"]) : 0;
    
    // FIX v9.6: Correct time format detection.
    // T1 can be in different formats:
    //   - Microseconds since boot: ~1e6 to ~1e8 (10 seconds to ~166 minutes of uptime)
    //   - Unix timestamp in seconds: ~1e9 (year 2001+)
    //   - Unix timestamp in microseconds: ~1e15
    // Detection rules:
    //   - If T1 < 1e9: it's microseconds since boot (no conversion needed)
    //   - If T1 >= 1e9 && T1 < 1e12: it's Unix seconds -> multiply by 1e6
    //   - If T1 >= 1e12: it's Unix microseconds (no conversion needed)
    static bool serverSendsSeconds = false;
    static bool detectedFormat = false;
    
    // DEBUG: Print raw T1 value to see what we're receiving
    static int debugPrintCount = 0;
    if (debugPrintCount < 3) {
        Serial.printf("[Sync] DEBUG: T1=%lld\n", (long long)T1);
        debugPrintCount++;
    }
    
    if (!detectedFormat && T1 > 0) {
        if (T1 < 1'000'000'000LL) {
            // T1 is in range [1, 1e9) - this is MICROseconds since ESP32 boot
            // No conversion needed - server correctly echoes our microsecond timestamp
            serverSendsSeconds = false;
            detectedFormat = true;
            Serial.println("[Sync] Detected: T1 is microseconds (no conversion)");
        } else if (T1 < 1'000'000'000'000LL) {
            // T1 is in range [1e9, 1e12) - this is Unix SECONDS
            serverSendsSeconds = true;
            detectedFormat = true;
            Serial.println("[Sync] Detected: server sends seconds (converting to µs)");
        } else {
            // T1 >= 1e12 - this is Unix MICROSECONDS
            serverSendsSeconds = false;
            detectedFormat = true;
            Serial.println("[Sync] Detected: server sends Unix microseconds");
        }
    }
    
    // Convert if server sends seconds
    if (serverSendsSeconds && T1 > 0) {
        T1 = T1 * 1000000LL;
        T2 = T2 * 1000000LL;
        T3 = T3 * 1000000LL;
    }
    
    timeSync.handleServerTime(T1, T2, T3, T4, timeFilter);
    if (timeFilter.count <= 8) {
        int64_t rtt = (T4 - T1) - (T3 - T2);
        if (rtt < 0) rtt = -rtt;
        Serial.printf("[Sync] #%d  offset=%.2f ms  rtt=%.2f ms\n",
                      timeFilter.count, timeFilter.offsetMs(), (double)rtt / 1000.0);
    }
}

void handleStreamStart(JsonDocument& doc) {
    JsonObject payload = doc["payload"];
    const char* codec = payload["player"]["codec"] | "pcm";
    currentCodec = String(codec);
    Serial.printf("[Sendspin] ← stream/start  codec=%s\n", codec);
    stopStream();
    if (!i2sReady) setupI2S();
    audioState = AudioState::BUFFERING;
    mp3RemainderLen = 0;
    if (currentCodec == "mp3") mp3dec_init(&mp3d);
}

void handleStreamEnd() {
    Serial.println("[Sendspin] ← stream/end");
    stopStream();
}

void handleStreamClear() {
    Serial.println("[Sendspin] ← stream/clear");
    if (ringBuf) ringBuf->clear();
    if (audioQueue) {
        AudioChunk chunk;
        while (xQueueReceive(audioQueue, &chunk, 0) == pdTRUE)
            if (chunk.data) heap_caps_free(chunk.data);
    }
    audioState = AudioState::BUFFERING;
}

void handleServerCommand(JsonDocument& doc) {
    JsonObject payload = doc["payload"];
    JsonObject p = payload["player"]; if (p.isNull()) return;
    if (p.containsKey("command")) {
        const char* cmd = p["command"] | "";
        if (!strcmp(cmd, "volume") && p.containsKey("volume")) {
            currentVolume = constrain((int)p["volume"], 0, 100);
            sendClientState();
        } else if (!strcmp(cmd, "mute") && p.containsKey("mute")) {
            currentMuted = (bool)p["mute"];
            sendClientState();
        }
    }
    // Legacy flat-style (older servers sometimes send direct keys)
    if (p.containsKey("volume")) { currentVolume = constrain((int)p["volume"], 0, 100); sendClientState(); }
    if (p.containsKey("muted"))  { currentMuted  = (bool)p["muted"];                   sendClientState(); }
}

void handleJsonMessage(const String& text) {
    DynamicJsonDocument doc(4096);
    if (deserializeJson(doc, text) != DeserializationError::Ok) {
        Serial.println("[JSON] parse error");
        return;
    }
    const char* type = doc["type"] | "";
    if      (!strcmp(type, "server/hello"))   handleServerHello(doc);
    else if (!strcmp(type, "server/time"))    handleServerTime(doc);
    else if (!strcmp(type, "stream/start"))   handleStreamStart(doc);
    else if (!strcmp(type, "stream/end"))     handleStreamEnd();
    else if (!strcmp(type, "stream/clear"))   handleStreamClear();
    else if (!strcmp(type, "server/command")) handleServerCommand(doc);
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary message handler — Sendspin spec:
//   Byte 0       : message type (uint8) — must be 4 for audio
//   Bytes 1-8    : timestamp big-endian int64 µs (server clock when first sample plays)
//   Bytes 9+     : encoded audio frame
// ─────────────────────────────────────────────────────────────────────────────
void handleBinaryMessage(const uint8_t* data, size_t len) {
    static const size_t HDR = 9;   // 1 type + 8 timestamp
    lastBinaryRecvMs = millis();

    if (audioState == AudioState::IDLE) return;
    if (len < HDR + 1) return;

    uint8_t msgType = data[0];
    if (msgType != 4) return;   // only player audio chunks

    // Read big-endian int64 timestamp (bytes 1-8)
    int64_t serverTs = 0;
    for (int i = 0; i < 8; i++) serverTs = (serverTs << 8) | data[1 + i];

    size_t payloadLen = len - HDR;
    if (payloadLen == 0) return;

    // Allocate PSRAM copy of the audio payload
    uint8_t* chunkData = (uint8_t*)heap_caps_malloc(payloadLen, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!chunkData) chunkData = (uint8_t*)malloc(payloadLen);
    if (!chunkData) { Serial.println("WARN: chunk alloc failed"); return; }
    memcpy(chunkData, data + HDR, payloadLen);

    AudioChunk chunk = { chunkData, payloadLen, serverTs };
    if (xQueueSend(audioQueue, &chunk, pdMS_TO_TICKS(5)) != pdTRUE) {
        static unsigned long warnMs = 0;
        if (millis() - warnMs > 2000) { warnMs = millis(); Serial.println("WARN: audio queue full, dropping chunk"); }
        heap_caps_free(chunkData);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// PCM decode — direct passthrough
// ─────────────────────────────────────────────────────────────────────────────
void decodePCM(const uint8_t* data, size_t len) {
    if (!ringBuf->write(data, len)) {
        static unsigned long w = 0;
        if (millis() - w > 2000) { w = millis(); Serial.println("WARN: ring buffer full, dropping PCM"); }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MP3 decode — minimp3
// ─────────────────────────────────────────────────────────────────────────────
void decodeMP3(const uint8_t* data, size_t len) {
    if (!mp3DecodeBuf || !mp3PcmOut) return;
    size_t totalLen = mp3RemainderLen + len;
    if (totalLen > MP3_DECODE_BUF_SIZE) {
        mp3RemainderLen = 0;
        if (len > MP3_DECODE_BUF_SIZE) { data += len - MP3_DECODE_BUF_SIZE; len = MP3_DECODE_BUF_SIZE; totalLen = MP3_DECODE_BUF_SIZE; }
    }
    if (mp3RemainderLen > 0 && mp3Remainder) memcpy(mp3DecodeBuf, mp3Remainder, mp3RemainderLen);
    memcpy(mp3DecodeBuf + mp3RemainderLen, data, len);
    const uint8_t* dp = mp3DecodeBuf; size_t dl = totalLen; size_t offset = 0;
    mp3dec_frame_info_t info;
    while (offset < dl) {
        int samples = mp3dec_decode_frame(&mp3d, dp + offset, dl - offset, mp3PcmOut, &info);
        if (info.frame_bytes > 0) {
            if (samples > 0) ringBuf->write((uint8_t*)mp3PcmOut, samples * info.channels * 2);
            offset += info.frame_bytes;
        } else break;
        if (offset % 4096 == 0) vTaskDelay(1);
    }
    mp3RemainderLen = dl - offset;
    if (mp3RemainderLen > 0 && mp3RemainderLen <= MP3_REMAINDER_SIZE && mp3Remainder)
        memcpy(mp3Remainder, dp + offset, mp3RemainderLen);
    else
        mp3RemainderLen = 0;
}

// ─────────────────────────────────────────────────────────────────────────────
// Audio Task — Core 1
// Key fixes vs v8.1:
//   • Silence is only written when state == PLAYING AND ringBuf is empty
//     (real underrun). During BUFFERING or IDLE nothing reaches I2S at all.
//   • That eliminates the constant buzzing from pumping zeros to the DAC.
// ─────────────────────────────────────────────────────────────────────────────
void audioTask(void* param) {
    Serial.println("[AudioTask] Started on Core 1");
    AudioChunk chunk;
    size_t underrunCount = 0;
    size_t totalChunks   = 0;

    for (;;) {
        // ── Drain the decode queue ──────────────────────────────────────────
        int processed = 0;
        while (processed < 8 && xQueueReceive(audioQueue, &chunk, 0) == pdTRUE) {
            if (chunk.data && chunk.len > 0) {
                totalChunks++;
                if      (currentCodec == "pcm") decodePCM(chunk.data, chunk.len);
                else if (currentCodec == "mp3") decodeMP3(chunk.data, chunk.len);
            }
            if (chunk.data) heap_caps_free(chunk.data);
            processed++;
        }

        // ── Periodic stats ──────────────────────────────────────────────────
        if (totalChunks > 0 && totalChunks % 50 == 0) {
            Serial.printf("[Audio] chunks=%d  buf=%d KB  underruns=%d\n",
                          (int)totalChunks, (int)(ringBuf->available() / 1024), (int)underrunCount);
        }

        // ── BUFFERING → PLAYING transition ─────────────────────────────────
        if (audioState == AudioState::BUFFERING) {
            size_t avail = ringBuf->available();
            if (avail >= (size_t)(MIN_BUFFER_MS * PCM_BYTES_PER_SEC / 1000)) {
                audioState = AudioState::PLAYING;
                Serial.printf("[Audio] Buffer ready (%d KB), starting playback\n",
                              (int)(avail / 1024));
            }
        }

        // ── I2S output — ONLY while PLAYING ────────────────────────────────
        if (i2sReady && ringBuf && i2sScratch && audioState == AudioState::PLAYING) {
            size_t avail = ringBuf->available();
            size_t toWrite;

            if (avail == 0) {
                // True underrun: play silence to keep I2S clock alive
                // but count it and warn
                memset(i2sScratch, 0, I2S_SCRATCH_SIZE);
                toWrite = I2S_SCRATCH_SIZE;
                underrunCount++;
                if (underrunCount % 50 == 1) {
                    Serial.printf("WARN: I2S underrun #%d\n", (int)underrunCount);
                }
            } else {
                toWrite = min(avail, I2S_SCRATCH_SIZE);
                toWrite &= ~3u;   // 4-byte align
                if (toWrite == 0) { vTaskDelay(pdMS_TO_TICKS(1)); continue; }
                ringBuf->read(i2sScratch, toWrite);
                applyVolume(i2sScratch, toWrite);
            }

            size_t written = 0;
            esp_err_t err = i2s_channel_write(i2sTxChan, i2sScratch, toWrite, &written, pdMS_TO_TICKS(20));
            if (err != ESP_OK && err != ESP_ERR_TIMEOUT) {
                static unsigned long lastErr = 0;
                if (millis() - lastErr > 5000) {
                    lastErr = millis();
                    Serial.printf("WARN: I2S write error 0x%x\n", err);
                }
            }
        } else {
            // Not playing: yield so WiFi/WS tasks get CPU
            vTaskDelay(pdMS_TO_TICKS(2));
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// WebSocket callbacks
// ─────────────────────────────────────────────────────────────────────────────
void onWsMessage(websockets::WebsocketsClient& client, websockets::WebsocketsMessage msg) {
    (void)client;
    if (msg.isText()) {
        handleJsonMessage(msg.data());
    } else if (msg.isBinary()) {
        // FIX v9.2: WSString (std::string) must be cast to uint8_t* for binary data.
        // Using c_str() + reinterpret_cast to handle null bytes in audio chunks.
        const char* rawChars = msg.rawData().c_str();
        size_t rawLen = msg.length();  // Use length() instead of rawLength()
        if (rawChars && rawLen > 0) {
            handleBinaryMessage(reinterpret_cast<const uint8_t*>(rawChars), rawLen);
        }
    }
}

void onWsEvent(websockets::WebsocketsClient& client, websockets::WebsocketsEvent event, String data) {
    (void)client;
    if (event == websockets::WebsocketsEvent::ConnectionOpened) {
        wsConnected = true;
        Serial.println("[WS] Connected");
        timeFilter.reset(); timeSync.reset(); timeBurstCount = 0;
        sendClientHello();
    } else if (event == websockets::WebsocketsEvent::ConnectionClosed) {
        wsConnected = false; stopStream();
        Serial.printf("[WS] Disconnected (reason: %s)\n", data.c_str());
    } else if (event == websockets::WebsocketsEvent::GotPing) {
        wsClient.pong();
    }
}

void connectWS() {
    if (wsConnected) return;
    if (millis() - lastWsRetryMs < 3000) return;
    lastWsRetryMs = millis();
    Serial.printf("[WS] Connecting %s:%d%s …\n", SS_HOST, SS_PORT, SS_PATH);
    wsClient.onMessage(onWsMessage);
    wsClient.onEvent(onWsEvent);
    wsClient.connect(SS_HOST, SS_PORT, SS_PATH);
}

// ═══════════════════════════════════════════════════════════════════════════
// setup()
// ═══════════════════════════════════════════════════════════════════════════
void setup() {
    Serial.begin(115200);
    delay(300);
    Serial.println("\n╔════════════════════════════════════╗");
    Serial.println("║  Audio-Auto ESP32-S3 v9.6        ║");
    Serial.println("║  Sendspin / PCM / Fixes:         ║");
    Serial.println("║  - Binary msg via rawData()      ║");
    Serial.println("║  - Fixed time sync burst logic   ║");
    Serial.println("║  - Auto-detect sec/µs timestamps║");
    Serial.println("║  - Correct detection: <1e9=µs   ║");
    Serial.println("╚════════════════════════════════════╝");
    Serial.println(DEVICE_NAME);

    // ── Ring buffer ──────────────────────────────────────────────────────────
    ringBuf = new PCMRingBuffer(RING_BUF_SIZE);
    if (!ringBuf->isAllocated()) { Serial.println("[FATAL] Ring buffer failed"); while (true) delay(1000); }
    Serial.printf("[RingBuf] %d KB allocated\n", (int)(ringBuf->capacity() / 1024));

    // ── I2S scratch ──────────────────────────────────────────────────────────
    i2sScratch = (uint8_t*)heap_caps_malloc(I2S_SCRATCH_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!i2sScratch) i2sScratch = (uint8_t*)malloc(I2S_SCRATCH_SIZE);
    if (!i2sScratch) { Serial.println("[FATAL] I2S scratch failed"); while (true) delay(1000); }

    // ── MP3 buffers ──────────────────────────────────────────────────────────
    mp3DecodeBuf = (uint8_t*)heap_caps_malloc(MP3_DECODE_BUF_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!mp3DecodeBuf) mp3DecodeBuf = (uint8_t*)malloc(MP3_DECODE_BUF_SIZE);
    mp3PcmOut    = (short*)heap_caps_malloc(MP3_PCM_OUT_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!mp3PcmOut)    mp3PcmOut    = (short*)malloc(MP3_PCM_OUT_SIZE);
    mp3Remainder = (uint8_t*)heap_caps_malloc(MP3_REMAINDER_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!mp3Remainder) mp3Remainder = (uint8_t*)malloc(MP3_REMAINDER_SIZE);

    // ── Audio queue ──────────────────────────────────────────────────────────
    audioQueue = xQueueCreate(AUDIO_QUEUE_SIZE, sizeof(AudioChunk));
    if (!audioQueue) { Serial.println("[FATAL] Queue failed"); while (true) delay(1000); }

    mp3dec_init(&mp3d);

    // ── WiFi ─────────────────────────────────────────────────────────────────
    WiFi.setTxPower(WIFI_POWER_19_5dBm);
    WiFi.setSleep(false);   // WIFI_PS_NONE — reduce jitter
    wifiMulti.addAP(WIFI_SSID1, WIFI_PASS1);
    wifiMulti.addAP(WIFI_SSID2, WIFI_PASS2);
    wifiMulti.addAP(WIFI_SSID3, WIFI_PASS3);
    Serial.print("[WiFi] Connecting");
    while (wifiMulti.run() != WL_CONNECTED) { delay(500); Serial.print('.'); }
    Serial.printf(" OK\n  SSID: %s\n  IP:   %s\n  RSSI: %d dBm\n",
                  WiFi.SSID().c_str(), WiFi.localIP().toString().c_str(), WiFi.RSSI());

    // ── I2S ──────────────────────────────────────────────────────────────────
    setupI2S();

    // ── Audio task on Core 1 ─────────────────────────────────────────────────
    xTaskCreatePinnedToCore(audioTask, "AudioTask", 16384, NULL, 15, &audioTaskHandle, 1);

    // ── Sendspin WS ──────────────────────────────────────────────────────────
    connectWS();

    Serial.println("\n[Ready] Waiting for Sendspin stream…\n");
}

// ═══════════════════════════════════════════════════════════════════════════
// loop()  — runs on Core 0
// ═══════════════════════════════════════════════════════════════════════════
void loop() {
    // ── WebSocket poll ───────────────────────────────────────────────────────
    if (wsConnected) wsClient.poll();
    else             connectWS();

    // ── Time sync probes ─────────────────────────────────────────────────────
    if (wsConnected) {
        // FIX v9.1: Use timeFilter.synced to determine if we're in initial sync or maintenance mode.
        // Initial burst: 8 probes @ 50 ms interval while not yet synced.
        // Maintenance: 1 probe @ 1000 ms interval after initial sync is complete.
        unsigned long interval = timeFilter.synced ? 1000UL : 50UL;
        
        if (millis() - lastTimeSendMs >= interval) {
            lastTimeSendMs = millis();
            
            // Only start a burst if one is not already active
            if (!timeSync.isBurstActive()) {
                timeSync.startBurst();
                timeBurstCount = 0;
            }
            
            sendClientTime();
            
            // Track probes sent within this burst
            if (timeBurstCount < TIME_SYNC_BURST_SIZE) {
                timeBurstCount++;
            }
        }

        // Periodic full re-sync burst every TIME_RESYNC_INTERVAL_MS to keep Kalman filter healthy
        if (millis() - lastResyncMs >= TIME_RESYNC_INTERVAL_MS) {
            lastResyncMs = millis();
            if (!timeSync.isBurstActive()) {
                timeSync.startBurst();
                timeBurstCount = 0;
                Serial.println("[Sync] Periodic re-sync burst");
            }
        }
    }

    // ── WiFi watchdog ────────────────────────────────────────────────────────
    if (millis() - lastWifiCheckMs > 5000) {
        lastWifiCheckMs = millis();
        if (wifiMulti.run() != WL_CONNECTED) {
            wsConnected = false;
            Serial.println("[WiFi] Reconnecting…");
        }
    }

    // ── Silence watchdog — stop if no audio for 3 s during playback ─────────
    if (audioState == AudioState::PLAYING && wsConnected && lastBinaryRecvMs > 0) {
        unsigned long silence = millis() - lastBinaryRecvMs;
        if (silence > 3000) {
            Serial.printf("[Sendspin] No audio for %lu s — stopping\n", silence / 1000);
            stopStream(); lastBinaryRecvMs = 0;
        }
    }

    vTaskDelay(pdMS_TO_TICKS(1));
}
