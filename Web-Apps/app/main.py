import os
import re
import shutil
import time
import unicodedata
from urllib.parse import quote
from datetime import datetime, timedelta
try:
    from zoneinfo import ZoneInfo          # Python 3.9+
except ImportError:
    from backports.zoneinfo import ZoneInfo # fallback

_TZ_NAME = os.environ.get("TZ", "Asia/Jayapura")

def _local_now():
    """Current time as a naive datetime in the configured local timezone."""
    return datetime.now(ZoneInfo(_TZ_NAME)).replace(tzinfo=None)

def _parse_play_time(raw: str) -> datetime:
    """Parse browser-sent play_time. Returns naive local datetime."""
    clean = raw.rstrip('Z').split('+')[0].split('.')[0]
    return datetime.fromisoformat(clean)

def _tz_offset_str() -> str:
    """Return UTC offset string like '+09:00' for the configured timezone."""
    import datetime as _dt
    tz = ZoneInfo(_TZ_NAME)
    offset = _dt.datetime.now(tz).utcoffset()
    total_minutes = int(offset.total_seconds() / 60)
    sign = '+' if total_minutes >= 0 else '-'
    h, m = divmod(abs(total_minutes), 60)
    return f"{sign}{h:02d}:{m:02d}"


from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException, Request, Response, status, WebSocket, WebSocketDisconnect, BackgroundTasks
import json
import asyncio
from fastapi.responses import HTMLResponse, RedirectResponse, StreamingResponse, FileResponse, JSONResponse
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

from . import models, database
from .ma_client import ma_client, MA_MEDIA_URL_BASE


# ─── Filename Sanitisation ────────────────────────────────────────────────────
def sanitize_filename(original: str) -> str:
    name, _, ext = original.rpartition('.')
    if not name:
        name, ext = original, ''
    else:
        ext = '.' + ext.lower()
    name = unicodedata.normalize('NFKD', name)
    name = name.encode('ascii', 'ignore').decode('ascii')
    name = re.sub(r"[^\w\s\-.]", "", name)
    name = re.sub(r"[\s_]+", "_", name)
    name = name.strip('_-')
    if not name:
        name = "audio"
    return name + ext


def audio_url(filename: str) -> str:
    """Build the full URL MA uses to stream this file."""
    encoded = quote(filename, safe='')
    return f"{MA_MEDIA_URL_BASE}/audio_files/{encoded}"


# ─── DB bootstrap ─────────────────────────────────────────────────────────────
max_retries = 30
for i in range(max_retries):
    try:
        models.Base.metadata.create_all(bind=database.engine)
        break
    except OperationalError:
        print(f"Database not ready, waiting 2 seconds... ({i+1}/{max_retries})")
        time.sleep(2)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")


# ─── WebSocket Connection Manager ─────────────────────────────────────────────
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
        disconnected = []
        for ws in self.active_connections.copy():
            try:
                await ws.send_json(message)
            except Exception:
                disconnected.append(ws)
        for ws in disconnected:
            self.disconnect(ws)


manager = ConnectionManager()
main_loop = None

# ─── MA Event → Browser WebSocket bridge ─────────────────────────────────────
async def _ma_event_handler(event_type: str, data) -> None:
    """Forward MA events to all connected browser WebSocket clients."""
    global main_loop
    if not main_loop:
        return
    
    try:
        if event_type in ("player_updated", "player_added", "player_removed"):
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"type": "ma_player", "event": event_type, "player": data}),
                main_loop,
            )
        elif event_type in ("queue_updated", "queue_added"):
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"type": "ma_queue", "event": event_type, "queue": data}),
                main_loop,
            )
        elif event_type == "queue_items_updated":
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"type": "ma_queue_items", "data": data}),
                main_loop,
            )
        elif event_type == "queue_time_updated":
            # Forward queue time updates for progress bar
            asyncio.run_coroutine_threadsafe(
                manager.broadcast({"type": "ma_queue_time", "data": data}),
                main_loop,
            )
    except RuntimeError:
        # main_loop might be closed, ignore
        pass


# ─── Scheduler ────────────────────────────────────────────────────────────────
scheduler = BackgroundScheduler(
    timezone=os.environ.get("TZ", "Asia/Jayapura"),
    misfire_grace_time=1  # Reject jobs that fire more than 1 second late
)


def stop_scheduled_playback(schedule_id: int, player_id: str):
    """Stop playback after scheduled song ends. Called automatically after song duration."""
    print(f"[Schedule] Auto-stopping playback for schedule {schedule_id} on player {player_id}")
    try:
        # Import asyncio here to avoid circular import issues
        import asyncio as _asyncio
        async def _stop():
            try:
                await ma_client.stop(player_id)
                print(f"[Schedule] Stop command sent for schedule {schedule_id}")
            except Exception as e:
                print(f"[Schedule] Stop command failed: {e}")
        _asyncio.run(_stop())
    except Exception as e:
        print(f"[Schedule] Auto-stop error: {e}")
    
    # Remove the stop job after execution
    try:
        scheduler.remove_job(f"stop_sched_{schedule_id}")
    except Exception:
        pass


def execute_schedule(schedule_id: int):
    """Fire a scheduled playback via Music Assistant."""
    db = database.SessionLocal()
    try:
        schedule = db.query(models.Schedule).filter(models.Schedule.id == schedule_id).first()
        if not schedule or not schedule.is_active or not schedule.audio:
            print(f"[Schedule] Schedule {schedule_id} skipped: inactive or no audio")
            return

        # Check if this is a one-time schedule (repeat == 'none')
        is_one_time = schedule.repeat == 'none'

        # Resolve player_id - use device_name directly if it's a valid MA player_id
        raw_player = schedule.device_name
        
        # Get player_id - this now checks cache first, then falls back to group
        player_id = ma_client.resolve_player_id(raw_player)
        
        print(f"[Schedule] Device '{raw_player}' → player_id '{player_id}'")
        
        # If still no valid player_id, use the group player
        if not player_id:
            player_id = ma_client.get_group_player_id()
            print(f"[Schedule] Using group player: {player_id}")
        
        uri = audio_url(schedule.audio.filename)
        volume = schedule.volume
        track_name = schedule.audio.original_name
        duration_sec = schedule.audio.duration_sec or 0  # Get song duration from database

        global main_loop
        if main_loop and main_loop.is_running():
            async def _run():
                try:
                    # Set volume first
                    await ma_client.set_volume(player_id, volume)
                    # Small delay to let volume settle
                    await asyncio.sleep(0.5)
                    # Then play media
                    await ma_client.play_media(player_id, uri, name=track_name)
                    print(f"[Schedule] Triggered: {track_name} → {player_id} (vol: {volume}%)")
                except Exception as e:
                    print(f"[Schedule] MA error: {e}")
            asyncio.run_coroutine_threadsafe(_run(), main_loop)
        else:
            print(f"[Schedule] main_loop not available, scheduling retry...")
            # Try to execute immediately if main_loop not available
            try:
                import asyncio as _asyncio
                _asyncio.run(_execute_schedule_async(schedule_id, player_id, uri, volume, track_name))
            except Exception as e:
                print(f"[Schedule] Direct execution error: {e}")

        # Schedule auto-stop after song duration ends
        # This ensures music stops even if song loops or doesn't finish naturally
        if duration_sec > 0:
            stop_time = datetime.now(ZoneInfo(_TZ_NAME)) + timedelta(seconds=duration_sec)
            scheduler.add_job(
                stop_scheduled_playback,
                trigger=DateTrigger(run_date=stop_time),
                args=[schedule_id, player_id],
                id=f"stop_sched_{schedule_id}",
                replace_existing=True,
            )
            print(f"[Schedule] Auto-stop scheduled at {stop_time.strftime('%H:%M:%S')} (duration: {duration_sec}s)")
        else:
            print(f"[Schedule] Warning: No duration info for {track_name}, auto-stop disabled")

        # For one-time schedules, mark as inactive after execution
        # This prevents the schedule from being re-added on app restart
        if is_one_time:
            schedule.is_active = False
            db.commit()
            print(f"[Schedule] One-time schedule {schedule_id} marked as inactive (played once)")
            
            # Also remove the play job from the scheduler to be safe
            try:
                scheduler.remove_job(f"sched_{schedule_id}")
            except Exception:
                pass  # Job might already be removed by APScheduler

    finally:
        db.close()


async def _execute_schedule_async(schedule_id: int, player_id: str, uri: str, volume: int, track_name: str):
    """Async helper for direct schedule execution."""
    try:
        await ma_client.set_volume(player_id, volume)
        await asyncio.sleep(0.5)
        await ma_client.play_media(player_id, uri, name=track_name)
        print(f"[Schedule] Direct triggered: {track_name} → {player_id}")
    except Exception as e:
        print(f"[Schedule] Direct MA error: {e}")


def add_schedule_job(sch: models.Schedule):
    if sch.repeat == "none":
        if sch.play_time > _local_now():
            scheduler.add_job(
                execute_schedule,
                trigger=DateTrigger(run_date=sch.play_time),
                args=[sch.id],
                id=f"sched_{sch.id}",
                replace_existing=True,
            )
    else:
        hour   = sch.play_time.hour
        minute = sch.play_time.minute
        second = sch.play_time.second
        if sch.repeat == "daily":
            trigger = CronTrigger(hour=hour, minute=minute, second=second)
        elif sch.repeat == "weekly":
            trigger = CronTrigger(day_of_week=sch.play_time.weekday(),
                                  hour=hour, minute=minute, second=second)
        elif sch.repeat == "monthly":
            trigger = CronTrigger(day=sch.play_time.day,
                                  hour=hour, minute=minute, second=second)
        else:
            return
        scheduler.add_job(
            execute_schedule,
            trigger=trigger,
            args=[sch.id],
            id=f"sched_{sch.id}",
            replace_existing=True,
        )


# ─── FastAPI App ───────────────────────────────────────────────────────────────
app = FastAPI(title="Audio-Auto")
app.add_middleware(SessionMiddleware, secret_key="super-secret-audio-auto-key-123")
app.mount("/static", StaticFiles(directory="app/static"), name="static")

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        players = ma_client.get_cached_players()
        await websocket.send_json({"type": "ma_players_snapshot", "players": players})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ─── Audio file serving ────────────────────────────────────────────────────────
@app.get("/audio_files/{filename:path}")
def get_audio_file(filename: str, request: Request):
    """Serve uploaded audio files — also reachable by MA via MA_MEDIA_URL_BASE."""
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
            "Content-Type": "audio/mpeg",
        }
        return FileResponse(file_path, headers=headers, media_type="audio/mpeg")

    range_match = range_header.replace("bytes=", "").split("-")
    start = int(range_match[0]) if range_match[0] else 0
    end   = int(range_match[1]) if len(range_match) > 1 and range_match[1] else file_size - 1

    if start >= file_size:
        return Response(status_code=416, headers={"Content-Range": f"bytes */{file_size}"})

    chunk_size = end - start + 1
    with open(file_path, "rb") as f:
        f.seek(start)
        data = f.read(chunk_size)

    headers = {
        "Content-Range":  f"bytes {start}-{end}/{file_size}",
        "Accept-Ranges":  "bytes",
        "Content-Length": str(chunk_size),
        "Content-Type":   "audio/mpeg",
    }
    return Response(content=data, status_code=206, headers=headers, media_type="audio/mpeg")


templates = Jinja2Templates(directory="app/templates")


# ─── Auth helpers ──────────────────────────────────────────────────────────────
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


# ─── Startup / Shutdown ────────────────────────────────────────────────────────
@app.on_event("startup")
async def startup_event():
    global main_loop
    main_loop = asyncio.get_running_loop()

    # Schema migration
    db = database.SessionLocal()
    try:
        db.execute(text("ALTER TABLE schedules ADD COLUMN `repeat` VARCHAR(50) DEFAULT 'none'"))
        db.commit()
    except Exception:
        db.rollback()

    # Admin user
    admin_user = os.environ.get("ADMIN_USER", "admin")
    admin_pass = os.environ.get("ADMIN_PASS", "admin123")
    user = db.query(models.User).filter(models.User.username == admin_user).first()
    if not user:
        new_user = models.User(username=admin_user, password_hash=pwd_context.hash(admin_pass))
        db.add(new_user)
        db.commit()

    # System config
    config = db.query(models.SystemConfig).first()
    if not config:
        db.add(models.SystemConfig())
        db.commit()

    db.close()

    # Register MA event → browser bridge
    ma_client.add_event_callback(_ma_event_handler)

    # Start MA WebSocket listener
    await ma_client.start()

    # Scheduler
    scheduler.start()
    db2 = database.SessionLocal()
    try:
        active = db2.query(models.Schedule).filter(models.Schedule.is_active == True).all()
        for sch in active:
            add_schedule_job(sch)
    finally:
        db2.close()


@app.on_event("shutdown")
def shutdown_event():
    scheduler.shutdown()


# ─── Auth Routes ───────────────────────────────────────────────────────────────
@app.get("/login", response_class=HTMLResponse)
def login_page(request: Request):
    return templates.TemplateResponse("login.html", {"request": request, "cache_buster": int(time.time())})


@app.post("/login")
def login_submit(request: Request, username: str = Form(...), password: str = Form(...),
                 db: Session = Depends(database.get_db)):
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user or not pwd_context.verify(password, user.password_hash):
        return templates.TemplateResponse("login.html",
            {"request": request, "cache_buster": int(time.time()), "error": "Invalid credentials"})
    request.session["user_id"] = user.id
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)


@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)


# ─── HTML Page Routes ──────────────────────────────────────────────────────────
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


# ─── File APIs ─────────────────────────────────────────────────────────────────
@app.get("/api/files")
def get_files(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    return db.query(models.AudioFile).all()


@app.delete("/api/files/{file_id}")
def delete_file(file_id: int, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    audio_file = db.query(models.AudioFile).filter(models.AudioFile.id == file_id).first()
    if not audio_file:
        raise HTTPException(status_code=404, detail="File not found")
    file_path = os.path.join("audio_files", audio_file.filename)
    if os.path.exists(file_path):
        os.remove(file_path)
    db.query(models.Schedule).filter(models.Schedule.audio_id == file_id).delete()
    db.delete(audio_file)
    db.commit()
    return {"status": "ok"}


@app.post("/api/upload")
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    db: Session = Depends(database.get_db),
    user=Depends(require_auth),
):
    # Stream-ready formats (accepted without transcode)
    stream_ready = ["mp3", "wav", "flac", "aac", "ogg"]
    # All formats accepted when transcode is enabled (ffmpeg handles conversion)
    all_formats = stream_ready + [
        "mp4", "m4a", "mkv", "webm", "avi", "mov", "wma", "opus",
        "mpeg", "mpg", "ts", "mka", "3gp", "amr", "ape", "dts", "ac3",
    ]
    conf = db.query(models.SystemConfig).first()
    transcode_on = conf and conf.transcode_enabled
    allowed_extensions = all_formats if transcode_on else stream_ready
    ext = file.filename.rsplit(".", 1)[-1].lower() if '.' in file.filename else ''
    if ext not in allowed_extensions:
        detail = (
            f"Unsupported format '.{ext}'. Accepted: {', '.join(stream_ready)}. "
            "Enable Transcode in Config to upload any audio/video format."
            if not transcode_on
            else f"Unsupported format '.{ext}'."
        )
        raise HTTPException(status_code=400, detail=detail)

    safe_name = sanitize_filename(file.filename)
    filename  = f"{int(time.time())}_{safe_name}"
    file_path = os.path.join("audio_files", filename)

    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    duration_sec = 0.0
    import subprocess
    try:
        res = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", file_path],
            capture_output=True, text=True, check=True,
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
        def transcode_audio(audio_id, orig_path, orig_name, c_format, c_type, c_samplerate, c_bitrate):
            target_ext = c_format.lower()
            if target_ext not in ["mp3", "aac", "ogg", "flac", "wav"]:
                target_ext = "mp3"
            tc_filename = f"{orig_name.rsplit('.', 1)[0]}_tc.{target_ext}"
            tc_path = os.path.join("audio_files", tc_filename)
            cmd = ["ffmpeg", "-y", "-i", orig_path, "-ar", c_samplerate, "-ac", "2", "-vn", "-map_metadata", "-1"]
            if c_type == "lossy":
                bitrate = c_bitrate if "k" in c_bitrate else c_bitrate + "k"
                if target_ext == "mp3":
                    cmd.extend(["-b:a", bitrate, "-abr", "0"])
                else:
                    cmd.extend(["-b:a", bitrate])
            elif c_type == "lossless":
                if target_ext == "wav":
                    cmd.extend(["-c:a", "pcm_s" + c_bitrate.replace("bit", "") + "le"])
                elif target_ext == "flac":
                    cmd.extend(["-c:a", "flac"])
            cmd.append(tc_path)

            global main_loop
            if main_loop and main_loop.is_running():
                asyncio.run_coroutine_threadsafe(
                    manager.broadcast({"type": "transcode_progress", "status": "started", "file": orig_name}),
                    main_loop,
                )
            try:
                subprocess.run(cmd, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
                if os.path.exists(orig_path):
                    os.remove(orig_path)
                db_sess = database.SessionLocal()
                try:
                    db_audio = db_sess.query(models.AudioFile).filter(models.AudioFile.id == audio_id).first()
                    if db_audio:
                        db_audio.filename = tc_filename
                        try:
                            import subprocess as _sp
                            res = _sp.run(
                                ["ffprobe", "-v", "error", "-show_entries", "format=duration",
                                 "-of", "default=noprint_wrappers=1:nokey=1", tc_path],
                                capture_output=True, text=True,
                            )
                            db_audio.duration_sec = float(res.stdout.strip())
                        except Exception:
                            pass
                        db_sess.commit()
                finally:
                    db_sess.close()
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast({"type": "transcode_progress", "status": "done", "file": orig_name}),
                        main_loop,
                    )
            except subprocess.CalledProcessError:
                if main_loop and main_loop.is_running():
                    asyncio.run_coroutine_threadsafe(
                        manager.broadcast({"type": "transcode_progress", "status": "error", "file": orig_name}),
                        main_loop,
                    )

        background_tasks.add_task(
            transcode_audio,
            audio.id, file_path, filename,
            conf.transcode_format, conf.transcode_type,
            conf.transcode_samplerate, conf.transcode_bitrate,
        )

    return {"message": "File uploaded successfully", "file": audio}


# ─── Schedule APIs ─────────────────────────────────────────────────────────────
class ScheduleRequest(BaseModel):
    device_name: str
    audio_id: int
    play_time: str
    repeat: str = "none"
    volume: int = 50


@app.post("/api/schedules")
@app.post("/api/schedule")
def add_schedule(sched: ScheduleRequest, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    try:
        dt = _parse_play_time(sched.play_time)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")
    new_sched = models.Schedule(
        device_name=sched.device_name, audio_id=sched.audio_id,
        play_time=dt, repeat=sched.repeat, volume=sched.volume,
    )
    db.add(new_sched)
    db.commit()
    db.refresh(new_sched)
    add_schedule_job(new_sched)
    return {"message": "Schedule added", "id": new_sched.id}


@app.get("/api/schedules")
def get_schedules(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    schedules = db.query(models.Schedule).all()
    return [{
        "id": s.id,
        "device_name": s.device_name,
        "audio_name": s.audio.original_name if s.audio else "Unknown",
        "audio_id": s.audio_id,
        "play_time": s.play_time.isoformat() + _tz_offset_str(),
        "repeat": s.repeat,
        "volume": s.volume,
        "is_active": s.is_active,
    } for s in schedules]


@app.put("/api/schedules/{schedule_id}")
def update_schedule(schedule_id: int, sched: ScheduleRequest,
                    db: Session = Depends(database.get_db), user=Depends(require_auth)):
    existing = db.query(models.Schedule).filter(models.Schedule.id == schedule_id).first()
    if not existing:
        raise HTTPException(status_code=404, detail="Not found")
    try:
        dt = _parse_play_time(sched.play_time)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")
    existing.device_name = sched.device_name
    existing.audio_id    = sched.audio_id
    existing.play_time   = dt
    existing.repeat      = sched.repeat
    existing.volume      = sched.volume
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


# ─── Config APIs ───────────────────────────────────────────────────────────────
@app.get("/api/config")
def get_config(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    return db.query(models.SystemConfig).first()


@app.post("/api/config")
async def update_config(request: Request, db: Session = Depends(database.get_db), user=Depends(require_auth)):
    form = await request.form()
    conf = db.query(models.SystemConfig).first()
    if not conf:
        conf = models.SystemConfig()
        db.add(conf)
    conf.default_volume      = int(form.get("default_volume", 50))
    conf.timezone            = form.get("timezone", "UTC")
    conf.language            = form.get("language", "en")
    conf.transcode_enabled   = form.get("transcode_enabled") == "true"
    conf.transcode_type      = form.get("transcode_type", "lossy")
    conf.transcode_format    = form.get("transcode_format", "mp3")
    conf.transcode_bitrate   = form.get("transcode_bitrate", "128k")
    conf.transcode_samplerate = form.get("transcode_samplerate", "44100")
    db.commit()
    return {"status": "ok"}


# ─── Music Assistant API Proxy Routes ──────────────────────────────────────────

@app.get("/api/ma/status")
async def ma_status(user=Depends(require_auth)):
    """MA connection status + group player info."""
    return {
        "connected": ma_client.connected,
        "group_player_name": ma_client.group_player_name,
        "group_player_id":   ma_client.group_player_id,
        "ma_url":            ma_client._http_url,
    }


@app.get("/api/ma/players")
async def ma_get_players(user=Depends(require_auth)):
    """All MA players; marks which ones are in the ESP32-Sync group."""
    try:
        players = await ma_client.get_players()
    except Exception as e:
        # Fall back to cache
        players = ma_client.get_cached_players()

    group_id = ma_client.group_player_id
    group_members: list[str] = []
    for p in players:
        if p.get("player_id") == group_id:
            group_members = p.get("group_members", [])
            break

    result = []
    for p in players:
        pid = p.get("player_id", "")
        is_group = p.get("type") == "group"
        in_sync  = (pid in group_members) or (pid == group_id)
        result.append({
            "player_id":       pid,
            "name":            p.get("name", pid),
            "type":            p.get("type", "player"),
            "available":       p.get("available", False),
            "playback_state":  p.get("playback_state", "idle"),
            "volume_level":    p.get("volume_level"),
            "group_volume":    p.get("group_volume"),
            "current_media":   p.get("current_media"),
            "elapsed_time":    p.get("elapsed_time"),
            "elapsed_time_last_updated": p.get("elapsed_time_last_updated"),
            "group_members":   p.get("group_members", []),
            "is_group":        is_group,
            "in_sync_group":   in_sync,
        })
    return result


@app.get("/api/ma/player/{player_id:path}")
async def ma_get_player(player_id: str, user=Depends(require_auth)):
    try:
        return await ma_client.get_player(player_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/ma/queue/{queue_id:path}")
async def ma_get_queue(queue_id: str, user=Depends(require_auth)):
    try:
        return await ma_client.get_queue(queue_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.get("/api/ma/queue/{queue_id:path}/items")
async def ma_get_queue_items(queue_id: str, user=Depends(require_auth)):
    try:
        return await ma_client.get_queue_items(queue_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/play")
async def ma_play(
    player_id: str = Form(...),
    audio_id: int = Form(None),
    uri: str = Form(None),
    db: Session = Depends(database.get_db),
    user=Depends(require_auth),
):
    """Play a local audio file or a raw URI on the specified MA player."""
    track_name = None
    if audio_id:
        audio = db.query(models.AudioFile).filter(models.AudioFile.id == audio_id).first()
        if not audio:
            raise HTTPException(status_code=404, detail="Audio not found")
        uri        = audio_url(audio.filename)
        track_name = audio.original_name
    if not uri:
        raise HTTPException(status_code=400, detail="Provide audio_id or uri")
    try:
        result = await ma_client.play_media(player_id, uri, name=track_name)
        return {"status": "ok", "uri": uri, "result": result}
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/play_pause")
async def ma_play_pause(player_id: str = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.play_pause(player_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/pause")
async def ma_pause(player_id: str = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.pause(player_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/stop")
async def ma_stop(player_id: str = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.stop(player_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/volume")
async def ma_volume(player_id: str = Form(...), volume: int = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.set_volume(player_id, volume)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/seek")
async def ma_seek(player_id: str = Form(...), position: float = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.seek(player_id, position)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/next")
async def ma_next(player_id: str = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.next_track(player_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/prev")
async def ma_prev(player_id: str = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.previous_track(player_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/shuffle")
async def ma_shuffle(queue_id: str = Form(...), shuffle: bool = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.set_shuffle(queue_id, shuffle)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


@app.post("/api/ma/repeat")
async def ma_repeat(queue_id: str = Form(...), repeat_mode: str = Form(...), user=Depends(require_auth)):
    try:
        return await ma_client.set_repeat(queue_id, repeat_mode)
    except Exception as e:
        raise HTTPException(status_code=502, detail=str(e))


# ─── Browser WebSocket endpoint ────────────────────────────────────────────────
@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
    # Send initial MA player snapshot on connect
    try:
        players = ma_client.get_cached_players()
        await websocket.send_json({"type": "ma_players_snapshot", "players": players})
    except Exception:
        pass
    try:
        while True:
            await websocket.receive_text()   # keep alive (ignore incoming)
    except WebSocketDisconnect:
        manager.disconnect(websocket)


# ─── Sendspin Client Cleanup API ───────────────────────────────────────────────
# Track connected browser clients for Sendspin sync
_sendspin_clients: dict = {}  # clientId → {group, joinedAt, lastSeen}

@app.post("/api/sendspin/leave")
async def sendspin_leave(request: Request, user=Depends(require_auth)):
    """Handle browser tab close - remove client from group tracking."""
    try:
        body = await request.json()
        client_id = body.get('clientId', '')
        group = body.get('group', 'ESP32-Sync')
        
        if client_id in _sendspin_clients:
            del _sendspin_clients[client_id]
            print(f"[Sendspin] Client {client_id} left group {group}")
        
        return {"status": "ok", "removed": client_id}
    except Exception as e:
        print(f"[Sendspin] Leave error: {e}")
        return {"status": "error", "message": str(e)}


@app.get("/api/sendspin/clients")
async def sendspin_get_clients(user=Depends(require_auth)):
    """Get list of connected Sendspin browser clients."""
    return {"clients": list(_sendspin_clients.values()), "count": len(_sendspin_clients)}


@app.post("/api/sendspin/join")
async def sendspin_join(request: Request, user=Depends(require_auth)):
    """Register a browser client joining a Sendspin group."""
    try:
        body = await request.json()
        client_id = body.get('clientId', '')
        group = body.get('group', 'ESP32-Sync')
        
        _sendspin_clients[client_id] = {
            'clientId': client_id,
            'group': group,
            'joinedAt': time.time(),
            'lastSeen': time.time(),
        }
        print(f"[Sendspin] Client {client_id} joined group {group}")
        
        return {"status": "ok", "registered": client_id}
    except Exception as e:
        print(f"[Sendspin] Join error: {e}")
        return {"status": "error", "message": str(e)}
