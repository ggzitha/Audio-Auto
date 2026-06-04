#ifndef AUDIO_FILE_SOURCE_WEBSOCKET_H
#define AUDIO_FILE_SOURCE_WEBSOCKET_H

#include <AudioFileSource.h>
#include <Arduino.h>
#include <functional>

class AudioFileSourceWebSocket : public AudioFileSource {
public:
  AudioFileSourceWebSocket() {
    buffer = nullptr;
    head = 0;
    tail = 0;
    size = 0;
    capacity = 0;
    total_read = 0;
    eos = false;
  }

  virtual ~AudioFileSourceWebSocket() {
    if (buffer) {
      free(buffer);
    }
  }

  bool begin(size_t buf_size) {
    if (buffer) free(buffer);
    buffer = (uint8_t*)malloc(buf_size);
    if (!buffer) return false;
    capacity = buf_size;
    head = 0;
    tail = 0;
    size = 0;
    total_read = 0;
    eos = false;
    return true;
  }

  std::function<void()> pollCallback;

  virtual uint32_t read(void *data, uint32_t len) override {
    uint32_t startWait = millis();
    while (size == 0 && !eos) {
      if (pollCallback) pollCallback();
      if (millis() - startWait > 3000) return 0; // 3 second timeout
      delay(2);
    }
    
    if (size == 0) return 0;
    
    uint32_t to_read = min((uint32_t)size, len);
    uint8_t* dest = (uint8_t*)data;
    
    uint32_t part1 = min(to_read, (uint32_t)(capacity - head));
    memcpy(dest, buffer + head, part1);
    
    if (part1 < to_read) {
        memcpy(dest + part1, buffer, to_read - part1);
    }
    
    head = (head + to_read) % capacity;
    size -= to_read;
    total_read += to_read;
    
    return to_read;
  }

  virtual uint32_t readNonBlock(void *data, uint32_t len) override {
    return read(data, len);
  }

  bool writeData(const uint8_t *data, size_t len) {
    if (len > capacity - size) {
        Serial.printf("[WS] Overflow! Dropping %d bytes\n", len);
        return false; // Overflow
    }
    
    uint32_t part1 = min((uint32_t)len, (uint32_t)(capacity - tail));
    memcpy(buffer + tail, data, part1);
    
    if (part1 < len) {
        memcpy(buffer, data + part1, len - part1);
    }
    
    tail = (tail + len) % capacity;
    size += len;
    return true;
  }

  virtual bool seek(int32_t pos, int dir) override { return false; }
  virtual bool close() override { return true; }
  virtual bool isOpen() override { return true; }
  virtual uint32_t getSize() override { return 0; }
  virtual uint32_t getPos() override { return total_read; }
  
  void setEos(bool end) { eos = end; }

private:
  uint8_t *buffer;
  size_t head;
  size_t tail;
  size_t size;
  size_t capacity;
  uint32_t total_read;
  bool eos;
};

#endif
