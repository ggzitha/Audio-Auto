import sys
with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/main.py', 'r') as f:
    lines = f.readlines()

new_lines = []
for line in lines:
    if 'return templates.TemplateResponse' in line and '"request": request' in line and 'cache_buster' not in line:
        line = line.replace('{"request": request}', '{"request": request, "cache_buster": int(time.time())}')
        if '{"request": request, "error"' in line:
            line = line.replace(', "error"', ', "cache_buster": int(time.time()), "error"')
    new_lines.append(line)

# Inject PlaybackState before ConnectionManager
state_code = '''
class PlaybackState(BaseModel):
    audio_id: int | None = None
    is_playing: bool = False
    position: float = 0.0
    volume: int = 50
    speed: float = 1.0
    last_updated: float = 0.0

global_state = PlaybackState()

def broadcast_state():
    global main_loop
    global_state.last_updated = time.time()
    if main_loop and main_loop.is_running():
        asyncio.run_coroutine_threadsafe(manager.broadcast({"type": "state", "state": global_state.dict()}), main_loop)

'''

cm_idx = next(i for i, l in enumerate(new_lines) if l.startswith('class ConnectionManager:'))
new_lines.insert(cm_idx, state_code)

with open('d:/004_Programming_Things/Arduino/AI-Coded/Audio-Auto/Web-Apps/app/main.py', 'w') as f:
    f.writelines(new_lines)
