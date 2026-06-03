import os
import paho.mqtt.client as mqtt
import json
from datetime import datetime
from .database import SessionLocal
from .models import Device

MQTT_BROKER = os.environ.get("MQTT_BROKER", "192.168.88.8")
MQTT_PORT = int(os.environ.get("MQTT_PORT", 1883))
MQTT_USER = os.environ.get("MQTT_USER", "inskal")
MQTT_PASS = os.environ.get("MQTT_PASS", "admin_inskal_mqtt")

# In paho-mqtt 2.0.0, callback_api_version is required
client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION1, client_id="fastapi_backend")
on_log_callback = None

def on_connect(client, userdata, flags, rc):
    print(f"Connected to MQTT broker with result code {rc}")
    client.subscribe("audioauto/telemetry/#")
    client.subscribe("audioauto/log/#")
    client.subscribe("audioauto/sync_request/#")

def on_message(client, userdata, msg):
    try:
        topic = msg.topic
        
        if topic.startswith("audioauto/log/"):
            parts = topic.split("/")
            if len(parts) >= 3:
                device_name = parts[2]
                payload_str = msg.payload.decode(errors='ignore')
                if on_log_callback:
                    on_log_callback(device_name, payload_str)
            return

        if topic.startswith("audioauto/sync_request/"):
            parts = topic.split("/")
            if len(parts) >= 3:
                device_name = parts[2]
                from .main import global_state, get_current_position
                from .database import SessionLocal
                from .models import AudioFile
                import time
                
                if global_state.is_playing and global_state.audio_id:
                    db = SessionLocal()
                    try:
                        audio = db.query(AudioFile).filter(AudioFile.id == global_state.audio_id).first()
                        if audio:
                            url = f"http://{MQTT_BROKER}:9876/audio_files/{audio.filename}"
                            start_time = int(time.time()) + 1
                            current_pos = get_current_position()
                            cmd = {
                                "action": "play",
                                "url": url,
                                "start_time": start_time,
                                "volume": global_state.volume,
                                "position": current_pos,
                            }
                            publish_command(device_name, cmd)
                    except Exception as e:
                        print(f"Error sending sync state: {e}")
                    finally:
                        db.close()
            return

        payload = json.loads(msg.payload.decode())
        
        # Topic format: audioauto/telemetry/{device_name}
        parts = topic.split("/")
        if len(parts) == 3:
            device_name = parts[2]
            
            db = SessionLocal()
            device = db.query(Device).filter(Device.name == device_name).first()
            if not device:
                device = Device(name=device_name)
                db.add(device)
            
            device.ip_address = payload.get("ip", device.ip_address)
            device.status = payload.get("status", "online")
            device.rssi = payload.get("rssi", device.rssi)
            device.temperature = payload.get("temperature", device.temperature)
            device.last_seen = datetime.utcnow()
            
            db.commit()
            db.close()
    except Exception as e:
        print(f"Error processing MQTT message: {e}")

client.on_connect = on_connect
client.on_message = on_message

if MQTT_USER and MQTT_PASS:
    client.username_pw_set(MQTT_USER, MQTT_PASS)

def start_mqtt():
    try:
        client.connect(MQTT_BROKER, MQTT_PORT, 60)
        client.loop_start()
    except Exception as e:
        print(f"Failed to connect to MQTT: {e}")

def publish_command(device_name: str, command: dict):
    """
    Publish a command to a specific device or 'all'.
    Command is a dictionary, e.g., {"action": "play", "url": "...", "start_time": 12345}
    """
    topic = f"audioauto/commands/{device_name}"
    client.publish(topic, json.dumps(command))
