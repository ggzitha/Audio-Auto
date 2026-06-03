import os
import re
import shutil
import time
import unicodedata
from urllib.parse import quote
from datetime import datetime
try:
    from zoneinfo import ZoneInfo          # Python 3.9+
except ImportError:
    from backports.zoneinfo import ZoneInfo # fallback

_TZ_NAME = os.environ.get("TZ", "Asia/Jayapura")

def _local_now():
    """Current time as a naive datetime in the configured local timezone."""
    return datetime.now(ZoneInfo(_TZ_NAME)).replace(tzinfo=None)

def _parse_play_time(raw: str) -> datetime:
    """
    Parse the play_time string sent by the browser.
    The browser now sends 'YYYY-MM-DDTHH:MM:SS' (no Z, no offset).
    Old rows saved with a trailing Z are also handled.
    Returns a naive datetime representing LOCAL time.
    """
    # Strip trailing Z or +00:00 — we treat the value as local time
    clean = raw.rstrip('Z').split('+')[0].split('.')[0]
    return datetime.fromisoformat(clean)

def _tz_offset_str() -> str:
    """Return the UTC offset as '+HH:MM' for the configured local timezone."""
    import datetime as _dt
    tz = ZoneInfo(_TZ_NAME)
    offset = _dt.datetime.now(tz).utcoffset()
    total_minutes = int(offset.total_seconds() / 60)
    sign = '+' if total_minutes >= 0 else '-'
    h, m = divmod(abs(total_minutes), 60)
    return f"{sign}{h:02d}:{m:02d}"

from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException, Request, Response, status, WebSocket, WebSocketDisconnect
import json
import asyncio
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from pydantic import BaseModel
from sqlalchemy import text
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger
from apscheduler.triggers.cron import CronTrigger
from passlib.context import CryptContext
from starlette.middleware.sessions import SessionMiddleware

from sqlalchemy.exc import OperationalError
from . import models, database, mqtt_handler


# ─── Filename Sanitisation ────────────────────────────────────────────────────
def sanitize_filename(original: str) -> str:
    """
    Convert any uploaded filename to a URL-safe ASCII string.

    Steps:
      1. Strip the extension, sanitise the stem.
      2. Transliterate unicode → ASCII (e.g. é → e).
      3. Keep only alphanumeric, space, dash, underscore, dot.
      4. Collapse whitespace → single underscore.
      5. Remove leading/trailing underscores and dashes.

    Examples:
      "01 It's All over but the crying.mp3"  → "01_Its_All_over_but_the_crying.mp3"
      "Café au lait (live).flac"              → "Cafe_au_lait_live.flac"
    """
    # Split extension
    name, _, ext = original.rpartition('.')
    if not name:        # no dot found — treat whole string as name
        name, ext = original, ''
    else:
        ext = '.' + ext.lower()

    # Transliterate unicode → closest ASCII
    name = unicodedata.normalize('NFKD', name)
    name = name.encode('ascii', 'ignore').decode('ascii')

    # Remove characters that are not alphanumeric, space, dash, underscore, dot
    name = re.sub(r"[^\w\s\-.]", "", name)

    # Collapse runs of whitespace/underscores → single underscore
    name = re.sub(r"[\s_]+", "_", name)

    # Strip leading/trailing underscores and dashes
    name = name.strip('_-')

    # Fallback if stem becomes empty
    if not name:
        name = "audio"

    return name + ext


def audio_url(server_host: str, filename: str) -> str:
    """
    Build a fully percent-encoded URL for an audio file.
    The filename stored on disk may still contain spaces (legacy files),
    so we always quote it here regardless.
    """
    encoded = quote(filename, safe='')
    return f"http://{server_host}/audio_files/{encoded}"


def _calc_bitrate_kbps(filename: str, duration_sec: float) -> int:
    """
    Estimate the average bitrate of an audio file in kbps.
    Used by MQTT play commands so ESP32 clients can compute accurate
    byte-offset seeks (byteOffset = seekSec × bitrate_kbps × 1000 / 8).
    Falls back to 128 kbps if the file is missing or duration is 0.
    """
    if duration_sec and duration_sec > 0:
        file_path = os.path.join("audio_files", filename)
        try:
            file_size = os.path.getsize(file_path)
            return max(32, int((file_size * 8) / (duration_sec * 1000)))
        except OSError:
            pass
    return 128  # safe default


max_retries = 30
for i in range(max_retries):
    try:
        models.Base.metadata.create_all(bind=database.engine)
        break
    except OperationalError:
        print(f"Database not ready, waiting 2 seconds... ({i+1}/{max_retries})")
        time.sleep(2)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


class PlaybackState(BaseModel):
    audio_id: int | None = None
    is_playing: bool = False
    position: float = 0.0        # position snapshot at last_updated
    volume: int = 50
    speed: float = 1.0
    last_updated: float = 0.0    # Unix timestamp when position was last set


global_state = PlaybackState()


def get_current_position() -> float:
    """Calculate current playback position accounting for elapsed time."""
    if not global_state.is_playing or global_state.last_updated == 0:
        return global_state.position
    elapsed = time.time() - global_state.last_updated
    return global_state.position + elapsed * global_state.speed


def broadcast_state():
    global main_loop
    # Build a state dict that includes the real-time server_time so clients
    # can calculate exact current position regardless of network latency.
    state_dict = global_state.dict()
    state_dict["server_time"] = time.time()  # current server unix timestamp
    if main_loop and main_loop.is_running():
        asyncio.run_coroutine_threadsafe(
            manager.broadcast({"type": "state", "state": state_dict}),
            main_loop
        )

class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []

    async def connect(self, websocket: WebSocket):
        await websocket.accept()
        self.active_connections.append(websocket)

    def disconnect(self, websocket: WebSocket):
        if websocket in self.active_connections:
            self.active_connections.remove(websocket)

    async def broadcast(self, message: dict):
        for connection in self.active_connections.copy():
            try:
                await connection.send_json(message)
            except:
                pass

manager = ConnectionManager()


app = FastAPI(title="Audio-Auto")
app.add_middleware(SessionMiddleware, secret_key="super-secret-audio-auto-key-123")

app.mount("/static", StaticFiles(directory="app/static"), name="static")

@app.get("/audio_files/{filename:path}")
def get_audio_file(filename: str, request: Request):
    # Strip directory traversal and decode any remaining percent-encoding
    safe = os.path.basename(filename)
    file_path = os.path.join("audio_files", safe)
    if not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="File not found")

    file_size = os.path.getsize(file_path)
    range_header = request.headers.get("Range")

    if not range_header:
        headers = {
            "Accept-Ranges": "bytes",
            "Content-Length": str(file_size),
            "Content-Type": "audio/mpeg"
        }
        return FileResponse(file_path, headers=headers, media_type="audio/mpeg")

    range_match = range_header.replace("bytes=", "").split("-")
    start = int(range_match[0]) if range_match[0] else 0
    end = int(range_match[1]) if len(range_match) > 1 and range_match[1] else file_size - 1

    if start >= file_size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    chunk_size = end - start + 1

    def file_iterator():
        with open(file_path, "rb") as f:
            f.seek(start)
            bytes_left = chunk_size
            while bytes_left > 0:
                chunk = f.read(min(bytes_left, 65536))
                if not chunk:
                    break
                bytes_left -= len(chunk)
                yield chunk

    headers = {
        "Content-Range": f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges": "bytes",
        "Content-Length": str(chunk_size),
        "Content-Type": "audio/mpeg"
    }

    return StreamingResponse(file_iterator(), status_code=206, headers=headers)

templates = Jinja2Templates(directory="app/templates")

scheduler = BackgroundScheduler(timezone=os.environ.get("TZ", "Asia/Jayapura"))

# Auth Dependencies
def get_current_user(request: Request, db: Session = Depends(database.get_db)):
    user_id = request.session.get("user_id")
    if not user_id:
        return None
    return db.query(models.User).filter(models.User.id == user_id).first()

def require_auth(request: Request, db: Session = Depends(database.get_db)):
    user = get_current_user(request, db)
    if not user:
        raise HTTPException(status_code=status.HTTP_303_SEE_OTHER, headers={"Location": "/login"})
    return user

def execute_schedule(schedule_id: int):
    db = database.SessionLocal()
    schedule = db.query(models.Schedule).filter(models.Schedule.id == schedule_id).first()
    if schedule and schedule.is_active:
        audio = schedule.audio
        if audio:
            url = audio_url("192.168.88.8:9876", audio.filename)
            # Give 5s for all devices to receive and buffer
            start_time = int(time.time()) + 5
            bitrate_kbps = _calc_bitrate_kbps(audio.filename, audio.duration_sec)

            cmd = {
                "action": "play",
                "url": url,
                "start_time": start_time,
                "volume": schedule.volume,
                "position": 0.0,
                "bitrate_kbps": bitrate_kbps
            }
            mqtt_handler.publish_command(schedule.device_name, cmd)

            # Update global state
            global global_state
            global_state.audio_id = audio.id
            global_state.is_playing = True
            global_state.position = 0.0
            global_state.volume = schedule.volume
            global_state.last_updated = float(start_time)  # will start counting from start_time

            if schedule.device_name in ["all", "Web App"]:
                state_dict = global_state.dict()
                state_dict["server_time"] = time.time()
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast({"type": "state", "state": state_dict}),
                        main_loop
                    )

            if schedule.repeat == "none":
                schedule.is_active = False
                db.commit()
    db.close()

def add_schedule_job(sch: models.Schedule):
    if sch.repeat == "none":
        if sch.play_time > _local_now():
            scheduler.add_job(
                execute_schedule,
                trigger=DateTrigger(run_date=sch.play_time),
                args=[sch.id],
                id=f"sched_{sch.id}",
                replace_existing=True
            )
    else:
        hour = sch.play_time.hour
        minute = sch.play_time.minute
        second = sch.play_time.second
        if sch.repeat == "daily":
            trigger = CronTrigger(hour=hour, minute=minute, second=second)
        elif sch.repeat == "weekly":
            day_of_week = sch.play_time.weekday()  # 0-6 (Mon-Sun)
            trigger = CronTrigger(day_of_week=day_of_week, hour=hour, minute=minute, second=second)
        elif sch.repeat == "monthly":
            day = sch.play_time.day
            trigger = CronTrigger(day=day, hour=hour, minute=minute, second=second)
        else:
            return

        scheduler.add_job(
            execute_schedule,
            trigger=trigger,
            args=[sch.id],
            id=f"sched_{sch.id}",
            replace_existing=True
        )

main_loop = None

@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()

    # Attempt schema migrations safely
    db = database.SessionLocal()
    try:
        db.execute(text("ALTER TABLE schedules ADD COLUMN `repeat` VARCHAR(50) DEFAULT 'none'"))
        db.commit()
    except Exception:
        db.rollback()

    # Admin init
    admin_user = os.environ.get("ADMIN_USER", "admin")
    admin_pass = os.environ.get("ADMIN_PASS", "admin123")
    user = db.query(models.User).filter(models.User.username == admin_user).first()
    if not user:
        hash_pass = pwd_context.hash(admin_pass)
        new_user = models.User(username=admin_user, password_hash=hash_pass)
        db.add(new_user)
        db.commit()

    # Init config
    config = db.query(models.SystemConfig).first()
    if not config:
        config = models.SystemConfig()
        db.add(config)
        db.commit()

    # Init Web App Device
    web_device = db.query(models.Device).filter(models.Device.name == "Web App").first()
    if not web_device:
        web_device = models.Device(name="Web App", status="online")
        db.add(web_device)
        db.commit()
    else:
        web_device.status = "online"
        web_device.last_seen = datetime.utcnow()
        db.commit()

    def handle_mqtt_log(dev_name, log_text):
        global main_loop
        if main_loop and main_loop.is_running():
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"type": "log", "device": dev_name, "text": log_text}),
                main_loop
            )

    mqtt_handler.on_log_callback = handle_mqtt_log
    mqtt_handler.start_mqtt()
    scheduler.start()

    active_schedules = db.query(models.Schedule).filter(models.Schedule.is_active == True).all()
    for sch in active_schedules:
        add_schedule_job(sch)

    db.close()

@app.on_event("shutdown")
def shutdown_event():
    scheduler.shutdown()

# --- Auth Routes ---
@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request, "cache_buster": int(time.time())})

@app.post("/login")
def login_submit(request: Request, username: str = Form(...), password: str = Form(...), db: Session = Depends(database.get_db)):
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user or not pwd_context.verify(password, user.password_hash):
        return templates.TemplateResponse("login.html", {"request": request, "cache_buster": int(time.time()), "error": "Invalid credentials"})
    request.session["user_id"] = user.id
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)

@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)

# --- HTML Routes ---
@app.get("/", response_class=HTMLResponse)
def read_root(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("index.html", {"request": request, "cache_buster": int(time.time())})

@app.get("/scheduler", response_class=HTMLResponse)
def read_scheduler(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("scheduler.html", {"request": request, "cache_buster": int(time.time())})

@app.get("/devices", response_class=HTMLResponse)
def read_devices(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("devices.html", {"request": request, "cache_buster": int(time.time())})

@app.get("/config", response_class=HTMLResponse)
def read_config(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("config.html", {"request": request, "cache_buster": int(time.time())})

@app.get("/help", response_class=HTMLResponse)
def read_help(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("help.html", {"request": request, "cache_buster": int(time.time())})


@app.get("/api/state")
def get_global_state():
    """Return current playback state with real-time position calculation."""
    state_dict = global_state.dict()
    state_dict["current_position"] = get_current_position()
    state_dict["server_time"] = time.time()
    return state_dict

# --- API Routes ---
@app.get("/api/devices")
def get_devices(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    devices = db.query(models.Device).all()
    now = datetime.utcnow()
    result = []
    for d in devices:
        if d.name == "Web App":
            result.append({
                "id": d.id, "name": d.name, "ip_address": d.ip_address,
                "status": d.status, "rssi": d.rssi, "temperature": d.temperature,
                "last_seen": d.last_seen.isoformat() + "Z" if d.last_seen else None
            })
            continue
            
        if d.last_seen:
            diff = now - d.last_seen
            if diff.total_seconds() > 3 * 24 * 3600:
                # Older than 3 days, permanently delete
                db.delete(d)
                continue
            elif diff.total_seconds() > 1 * 3600:
                # Older than 1 hours, mark as offline
                d.status = "offline"
                
        result.append({
            "id": d.id, "name": d.name, "ip_address": d.ip_address,
            "status": d.status, "rssi": d.rssi, "temperature": d.temperature,
            "last_seen": d.last_seen.isoformat() + "Z" if d.last_seen else None
        })
    db.commit()
    return result


@app.delete("/api/files/{file_id}")
def delete_file(file_id: int, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    audio_file = db.query(models.AudioFile).filter(models.AudioFile.id == file_id).first()
    if not audio_file:
        raise HTTPException(status_code=404, detail="File not found")

    # Delete file from disk
    file_path = os.path.join("audio_files", audio_file.filename)
    if os.path.exists(file_path):
        os.remove(file_path)

    # Delete related schedules
    db.query(models.Schedule).filter(models.Schedule.audio_id == file_id).delete()

    # Delete DB record
    db.delete(audio_file)
    db.commit()

    return {"status": "ok"}

@app.get("/api/files")
def get_files(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    files = db.query(models.AudioFile).all()
    return files

from fastapi import BackgroundTasks

@app.post("/api/upload")
async def upload_file(background_tasks: BackgroundTasks, file: UploadFile = File(...), db: Session = Depends(database.get_db), user=Depends(require_auth)):
    allowed_extensions = ["mp3", "wav", "flac", "aac", "ogg"]
    ext = file.filename.rsplit(".", 1)[-1].lower() if '.' in file.filename else ''
    if ext not in allowed_extensions:
        raise HTTPException(status_code=400, detail="Invalid file type")

    # Sanitise filename: make it URL-safe BEFORE saving to disk
    safe_name = sanitize_filename(file.filename)
    filename = f"{int(time.time())}_{safe_name}"
    file_path = os.path.join("audio_files", filename)

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    duration_sec = 0.0
    import subprocess
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, text=True, check=True
        )
        duration_sec = float(res.stdout.strip())
    except Exception as e:
        print("Failed to get duration:", e)

    audio = models.AudioFile(filename=filename, original_name=file.filename, duration_sec=duration_sec)
    db.add(audio)
    db.commit()
    db.refresh(audio)

    conf = db.query(models.SystemConfig).first()
    if conf and conf.transcode_enabled:
        # Define background task
        def transcode_audio(audio_id: int, orig_path: str, orig_name: str, c_format: str, c_type: str, c_samplerate: str, c_bitrate: str):
            target_ext = c_format.lower()
            if target_ext not in ["mp3", "aac", "ogg", "flac", "wav"]:
                target_ext = "mp3"
                
            tc_filename = f"{orig_name.rsplit('.', 1)[0]}_tc.{target_ext}"
            tc_path = os.path.join("audio_files", tc_filename)
            
            cmd = ["ffmpeg", "-y", "-i", orig_path,
                   "-ar", c_samplerate,
                   "-ac", "2",            # stereo — helix decoder expects stereo
                   "-map_metadata", "-1", # strip ID3/metadata tags — large tags
                                           # can corrupt helix frame-sync on ESP32
                   ]
            if c_type == "lossy":
                bitrate = c_bitrate if "k" in c_bitrate else c_bitrate + "k"
                if target_ext == "mp3":
                    # Force true CBR — VBR/ABR causes helix decoder frame-sync loss
                    cmd.extend(["-b:a", bitrate, "-abr", "0"])
                else:
                    cmd.extend(["-b:a", bitrate])
            elif c_type == "lossless":
                if target_ext == "wav":
                    cmd.extend(["-c:a", "pcm_s" + c_bitrate.replace("bit", "") + "le"])
                elif target_ext == "flac":
                    cmd.extend(["-c:a", "flac"])
            cmd.append(tc_path)
            
            # Broadcast start
            global main_loop
            if main_loop and main_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    manager.broadcast({"type": "transcode_progress", "status": "started", "file": orig_name}),
                    main_loop
                )
            
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if os.path.exists(orig_path):
                    os.remove(orig_path)
                
                # Re-probe duration for the transcoded file and update DB
                db_sess = database.SessionLocal()
                try:
                    db_audio = db_sess.query(models.AudioFile).filter(models.AudioFile.id == audio_id).first()
                    if db_audio:
                        db_audio.filename = tc_filename
                        # Update duration for accurate bitrate_kbps calculation
                        try:
                            import subprocess as _sp
                            res = _sp.run(
                                ["ffprobe", "-v", "error",
                                 "-show_entries", "format=duration",
                                 "-of", "default=noprint_wrappers=1:nokey=1",
                                 tc_path],
                                capture_output=True, text=True
                            )
                            db_audio.duration_sec = float(res.stdout.strip())
                        except Exception:
                            pass  # keep original duration if probe fails
                        db_sess.commit()
                finally:
                    db_sess.close()
                
                # Broadcast done
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast({"type": "transcode_progress", "status": "done", "file": orig_name}),
                        main_loop
                    )
            except subprocess.CalledProcessError:
                # Broadcast error
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast({"type": "transcode_progress", "status": "error", "file": orig_name}),
                        main_loop
                    )

        background_tasks.add_task(
            transcode_audio, 
            audio.id, file_path, filename, 
            conf.transcode_format, conf.transcode_type, 
            conf.transcode_samplerate, conf.transcode_bitrate
        )

    return {"message": "File uploaded successfully", "file": audio}

class ScheduleRequest(BaseModel):
    device_name: str
    audio_id: int
    play_time: str
    repeat: str = "none"
    volume: int = 50

# POST /api/schedules (canonical) and alias /api/schedule (for backward compat with old spa.js calls)
@app.post("/api/schedules")
@app.post("/api/schedule")
def add_schedule(
    sched: ScheduleRequest,
    db: Session = Depends(database.get_db),
    user=Depends(require_auth)
):
    try:
        dt = _parse_play_time(sched.play_time)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    new_sched = models.Schedule(
        device_name=sched.device_name,
        audio_id=sched.audio_id,
        play_time=dt,
        repeat=sched.repeat,
        volume=sched.volume
    )
    db.add(new_sched)
    db.commit()
    db.refresh(new_sched)

    add_schedule_job(new_sched)
    return {"message": "Schedule added", "id": new_sched.id}

@app.get("/api/schedules")
def get_schedules(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    schedules = db.query(models.Schedule).all()
    result = []
    for s in schedules:
        result.append({
            "id": s.id,
            "device_name": s.device_name,
            "audio_name": s.audio.original_name if s.audio else "Unknown",
            "audio_id": s.audio_id,
            # Append the local UTC offset so browser new Date() interprets as local time
            "play_time": s.play_time.isoformat() + _tz_offset_str(),
            "repeat": s.repeat,
            "volume": s.volume,
            "is_active": s.is_active
        })
    return result

@app.put("/api/schedules/{schedule_id}")
def update_schedule(schedule_id: int, sched: ScheduleRequest, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    existing = db.query(models.Schedule).filter(models.Schedule.id == schedule_id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        dt = _parse_play_time(sched.play_time)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")

    existing.device_name = sched.device_name
    existing.audio_id = sched.audio_id
    existing.play_time = dt
    existing.repeat = sched.repeat
    existing.volume = sched.volume
    db.commit()

    try:
        scheduler.remove_job(f"sched_{existing.id}")
    except Exception:
        pass
    add_schedule_job(existing)
    return {"message": "Schedule updated"}

@app.delete("/api/schedules/{schedule_id}")
def delete_schedule(schedule_id: int, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    sched = db.query(models.Schedule).filter(models.Schedule.id == schedule_id).first()
    if sched:
        try:
            scheduler.remove_job(f"sched_{sched.id}")
        except Exception:
            pass
        db.delete(sched)
        db.commit()
        return {"message": "Deleted"}
    raise HTTPException(status_code=404, detail="Not found")

@app.post("/api/play")
def realtime_play(
    device_name: str = Form("all"),
    audio_id: int = Form(...),
    volume: int = Form(50),
    position: float = Form(0.0),
    db: Session = Depends(database.get_db),
    user=Depends(require_auth)
):
    audio = db.query(models.AudioFile).filter(models.AudioFile.id == audio_id).first()
    if not audio:
        raise HTTPException(status_code=404, detail="Audio not found")

    url = audio_url("192.168.88.8:9876", audio.filename)
    # Give 2 seconds for all listeners to receive the command and buffer
    start_time = int(time.time()) + 2
    bitrate_kbps = _calc_bitrate_kbps(audio.filename, audio.duration_sec)

    cmd = {
        "action": "play",
        "url": url,
        "start_time": start_time,
        "volume": volume,
        "position": position,
        "bitrate_kbps": bitrate_kbps
    }

    global global_state
    global_state.audio_id = audio_id
    global_state.is_playing = True
    global_state.position = position
    global_state.volume = volume
    # Set last_updated to start_time so position counting begins correctly
    global_state.last_updated = float(start_time)

    broadcast_state()
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Play command sent", "start_time": start_time}

@app.post("/api/stop")
def realtime_stop(device_name: str = Form("all"), clear: bool = Form(False), user=Depends(require_auth)):
    cmd = {"action": "stop"}

    global global_state
    # Snapshot the current position before pausing
    global_state.position = get_current_position()
    global_state.is_playing = False
    global_state.last_updated = time.time()
    
    if clear:
        global_state.audio_id = None
        global_state.position = 0.0

    broadcast_state()
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Stop command sent"}

@app.post("/api/seek")
def realtime_seek(device_name: str = Form("all"), position: float = Form(...), user=Depends(require_auth)):
    # 300ms sync window: enough for MQTT to reach all ESP32s before they seek,
    # but imperceptible to the human ear (vs. 1s which is very noticeable).
    sync_delay = 0.3
    start_time = time.time() + sync_delay
    cmd = {
        "action": "seek",
        "position": position,
        "start_time": start_time
    }

    global global_state
    global_state.position = position
    global_state.last_updated = start_time

    broadcast_state()
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Seek command sent"}

@app.post("/api/speed")
def realtime_speed(device_name: str = Form("all"), speed: float = Form(1.0), user=Depends(require_auth)):
    cmd = {
        "action": "speed",
        "speed": speed
    }

    global global_state
    # Snapshot current position before changing speed
    global_state.position = get_current_position()
    global_state.last_updated = time.time()
    global_state.speed = speed

    broadcast_state()
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Speed command sent"}

@app.post("/api/volume")
def realtime_volume(device_name: str = Form("all"), volume: int = Form(50), user=Depends(require_auth)):
    cmd = {"action": "volume", "volume": volume}

    global global_state
    global_state.volume = volume

    broadcast_state()
    mqtt_handler.publish_command(device_name, cmd)
    return {"status": "ok"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Send current state immediately on connect so new clients sync instantly
    try:
        state_dict = global_state.dict()
        state_dict["current_position"] = get_current_position()
        state_dict["server_time"] = time.time()
        await websocket.send_json({"type": "state", "state": state_dict})
    except Exception:
        pass
    try:
        while True:
            data = await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)

@app.get("/api/config")
def get_config(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    conf = db.query(models.SystemConfig).first()
    return conf

@app.post("/api/config")
async def update_config(request: Request, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    form = await request.form()
    conf = db.query(models.SystemConfig).first()
    if not conf:
        conf = models.SystemConfig()
        db.add(conf)

    conf.default_volume = int(form.get("default_volume", 50))
    conf.timezone = form.get("timezone", "UTC")
    conf.language = form.get("language", "en")
    
    conf.transcode_enabled = form.get("transcode_enabled") == "true"
    conf.transcode_type = form.get("transcode_type", "lossy")
    conf.transcode_format = form.get("transcode_format", "mp3")
    conf.transcode_bitrate = form.get("transcode_bitrate", "128k")
    conf.transcode_samplerate = form.get("transcode_samplerate", "44100")
    db.commit()
    return {"status": "ok"}

@app.post("/api/sync_time")
def sync_time(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    mqtt_handler.publish_command("all", {"action": "sync_time"})
    return {"status": "ok"}
