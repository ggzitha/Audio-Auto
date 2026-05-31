# Audio-Auto: Complete Project Walkthrough

This document serves as the comprehensive guide for the Audio-Auto project, covering both the web application and the hardware implementation.

---

## 🌐 1. Web Application Guide

### Startup & Backend Configuration
1. **Docker Deployment:** Navigate to the Web-Apps folder and run `docker-compose up -d --build`. This starts MariaDB, FastAPI, and the background task scheduler.
2. **Default Login:** On the very first run, the system automatically creates an admin account based on your `docker-compose.yml` environment variables:
   - **Username:** `admin`
   - **Password:** `admin123`
3. **MQTT Broker:** Ensure your MQTT broker (e.g., Mosquitto) is running at the IP `192.168.88.8:1883` with credentials `inskal` / `admin_inskal_mqtt` as defined in your compose file.

### Dashboard Features
- **Realtime Player:** Upload music, select a target device (or `all`), and hit play. The web UI will act as a synchronized master clock.
- **Seeking & Speed:** Dragging the waveform or altering the speed dropdown sends real-time MQTT commands to the ESP32s to adjust playback dynamically.
- **Recurring Scheduler:** Set daily, weekly, or monthly repeating schedules. The backend uses a cron-like trigger to run these indefinitely.

---

## 🔌 2. Hardware Guide & Wiring

To make the ESP32s play the synchronized audio, you must write a firmware sketch that receives MQTT commands and streams HTTP audio.

### Required Arduino Libraries
Before coding your boards, install these libraries via the Arduino Library Manager:
1. **`PubSubClient`** by Nick O'Leary (For MQTT communication)
2. **`ArduinoJson`** by Benoit Blanchon (For parsing MQTT JSON payloads)
3. **`ESP32-audioI2S`** by Schreibfaul1 (Crucial for HTTP audio streaming, MP3/WAV/FLAC decoding, and I2S output)

---

### Hardware Architectures & Wiring

Because you are using a mix of ESP32s, the wiring depends heavily on the board type. 
- **Classic ESP32:** Has built-in internal DACs. An external I2S DAC is **Optional**.
- **ESP32-C3 / ESP32-C6:** Lack internal DACs entirely. An external I2S DAC (like PCM5102A) is **Required**.
- **RTC Module (e.g., DS3231):** **Optional** on all boards to keep exact time when the internet/NTP is down.

#### Option A: Classic ESP32 (Internal DAC - No Extra Hardware)
This is the simplest wiring but produces lower audio quality (8-bit). 
- Connect an amplifier or headphones directly to `GPIO 25` (Left) or `GPIO 26` (Right).
- **Code Config:** Pass `true` or use internal DAC mode when initializing the `audioI2S` library.

#### Option B: Classic ESP32 with External DAC (PCM5102A)
Optional for the classic ESP32, but highly recommended for high-fidelity audio.
| ESP32 Pin | PCM5102A Pin | Function |
| :--- | :--- | :--- |
| **VIN / 5V** | VIN | Power |
| **GND** | GND | Ground |
| **GPIO 25** | LRC / LCK | Word Select / Left-Right Clock |
| **GPIO 26** | BCLK / BCK | Bit Clock |
| **GPIO 22** | DIN | Data In |

#### Option C: ESP32-C3 with External DAC (PCM5102A)
**[REQUIRED]** Since the C3 lacks an internal DAC, you must use I2S.
| ESP32-C3 Pin | PCM5102A Pin | Function |
| :--- | :--- | :--- |
| **5V / 3V3** | VIN | Power |
| **GND** | GND | Ground |
| **GPIO 4** | LRC / LCK | Word Select / Left-Right Clock |
| **GPIO 5** | BCLK / BCK | Bit Clock |
| **GPIO 6** | DIN | Data In |

#### Option D: ESP32-C6 with External DAC (PCM5102A)
**[REQUIRED]** Similar to the C3, the C6 also lacks an internal DAC.
| ESP32-C6 Pin | PCM5102A Pin | Function |
| :--- | :--- | :--- |
| **5V / 3V3** | VIN | Power |
| **GND** | GND | Ground |
| **GPIO 18** | LRC / LCK | Word Select / Left-Right Clock |
| **GPIO 19** | BCLK / BCK | Bit Clock |
| **GPIO 20** | DIN | Data In |

*(Note: C3 and C6 GPIO mappings can be customized in code using `audio.setPinout()`, the pins above are standard examples).*

---

### ESP32 Firmware Logic Flow
Your ESP32 code should follow this logic structure to be compatible with the web app:

1. **WiFi & NTP Sync:**
   - Connect to `WIFI_SSID1`.
   - Initialize NTP: `configTime(9 * 3600, 0, "pool.ntp.org");` to sync to Asia/Jayapura time.
   - *(Optional)* Fallback to an RTC module via I2C if NTP fails.
2. **MQTT Connection:**
   - Connect to `192.168.88.8`.
   - Subscribe to two topics:
     - `audioauto/devices/all` (For global commands)
     - `audioauto/devices/<ESP32_MAC_ADDRESS>` (For specific device targeting)
3. **Handling MQTT Commands:**
   When a JSON payload arrives, parse the `"action"` field:
   - `"play"`: Extract the `"url"` and `"start_time"`. Wait until the local NTP time strictly matches `"start_time"` (usually 2 seconds in the future), then call `audio.connecttohost(url)`.
   - `"stop"`: Call `audio.stopSong()`.
   - `"seek"`: Call `audio.setAudioPlayPosition(position_in_seconds)`.
   - `"speed"`: If supported by your decoder, adjust the playback speed.
4. **Main Loop:**
   - Call `audio.loop()` constantly to keep the stream buffer full.
   - Call `mqttClient.loop()` to process incoming messages.
