import sys
with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/main.py', 'r') as f:
    content = f.read()

play_replace = '''
    global global_state
    global_state.audio_id = audio_id
    global_state.is_playing = True
    global_state.position = position
    global_state.volume = volume
    broadcast_state()
    
    mqtt_handler.publish_command(device_name, cmd)'''

content = content.replace('    mqtt_handler.publish_command(device_name, cmd)\n    return {"message": "Play command sent"}', play_replace + '\n    return {"message": "Play command sent"}', 1)

stop_replace = '''
    global global_state
    global_state.is_playing = False
    broadcast_state()
    
    mqtt_handler.publish_command(device_name, cmd)'''
content = content.replace('    mqtt_handler.publish_command(device_name, cmd)\n    return {"message": "Stop command sent"}', stop_replace + '\n    return {"message": "Stop command sent"}', 1)

seek_replace = '''
    global global_state
    global_state.position = position
    broadcast_state()
    
    mqtt_handler.publish_command(device_name, cmd)'''
content = content.replace('    mqtt_handler.publish_command(device_name, cmd)\n    return {"message": "Seek command sent"}', seek_replace + '\n    return {"message": "Seek command sent"}', 1)

speed_replace = '''
    global global_state
    global_state.speed = speed
    broadcast_state()
    
    mqtt_handler.publish_command(device_name, cmd)'''
content = content.replace('    mqtt_handler.publish_command(device_name, cmd)\n    return {"message": "Speed command sent"}', speed_replace + '\n    return {"message": "Speed command sent"}', 1)

vol_replace = '''
    global global_state
    global_state.volume = volume
    broadcast_state()
    
    mqtt_handler.publish_command(device_name, cmd)'''
content = content.replace('    mqtt_handler.publish_command(device_name, cmd)\n    return {"message": "Volume command sent"}', vol_replace + '\n    return {"message": "Volume command sent"}', 1)

api_state = '''
@app.get("/api/state")
def get_global_state():
    return global_state.dict()
    
# --- API Routes ---'''
content = content.replace('# --- API Routes ---', api_state)

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/main.py', 'w') as f:
    f.write(content)
