import os
import shutil
import time
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException, Request, Response, status, WebSocket, WebSocketDisconnect
import json
import asyncio
from fastapi.responses import HTMLResponse, RedirectResponse
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

# Wait for DB to be ready
max_retries = 30
for i in range(max_retries):
    try:
        models.Base.metadata.create_all(bind=database.engine)
        break
    except OperationalError:
        print(f"Database not ready, waiting 2 seconds... ({i+1}/{max_retries})")
        time.sleep(2)

pwd_context = CryptContext(schemes=["pbkdf2_sha256"], deprecated="auto")

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
app.mount("/audio_files", StaticFiles(directory="audio_files"), name="audio_files")

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
            url = f"http://192.168.88.8:9876/audio_files/{audio.filename}"
            start_time = int(time.time()) + 5
            
            cmd = {
                "action": "play",
                "url": url,
                "start_time": start_time,
                "volume": schedule.volume
            }
            mqtt_handler.publish_command(schedule.device_name, cmd)
            
            if schedule.device_name in ["all", "Web App"]:
                # Use asyncio.run safely by checking event loop
                try:
                    loop = asyncio.get_event_loop()
                    if loop.is_running():
                        loop.create_task(manager.broadcast({"type": "play", "audio_id": audio.id, "volume": schedule.volume, "start_time": start_time}))
                    else:
                        asyncio.run(manager.broadcast({"type": "play", "audio_id": audio.id, "volume": schedule.volume, "start_time": start_time}))
                except RuntimeError:
                    asyncio.run(manager.broadcast({"type": "play", "audio_id": audio.id, "volume": schedule.volume, "start_time": start_time}))
            
            if schedule.repeat == "none":
                schedule.is_active = False
                db.commit()
    db.close()

def add_schedule_job(sch: models.Schedule):
    if sch.repeat == "none":
        if sch.play_time > datetime.now():
            scheduler.add_job(
                execute_schedule, 
                trigger=DateTrigger(run_date=sch.play_time), 
                args=[sch.id],
                id=f"sched_{sch.id}"
            )
    else:
        hour = sch.play_time.hour
        minute = sch.play_time.minute
        second = sch.play_time.second
        if sch.repeat == "daily":
            trigger = CronTrigger(hour=hour, minute=minute, second=second)
        elif sch.repeat == "weekly":
            day_of_week = sch.play_time.weekday() # 0-6 (Mon-Sun)
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
            id=f"sched_{sch.id}"
        )

@app.on_event("startup")
def startup_event():
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
            asyncio.run_coroutine_threadsafe(manager.broadcast({"type": "log", "device": dev_name, "text": log_text}), main_loop)
    
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
    return templates.TemplateResponse("login.html", {"request": request})

@app.post("/login")
def login_submit(request: Request, username: str = Form(...), password: str = Form(...), db: Session = Depends(database.get_db)):
    user = db.query(models.User).filter(models.User.username == username).first()
    if not user or not pwd_context.verify(password, user.password_hash):
        return templates.TemplateResponse("login.html", {"request": request, "error": "Invalid credentials"})
    request.session["user_id"] = user.id
    return RedirectResponse(url="/", status_code=status.HTTP_303_SEE_OTHER)

@app.get("/logout")
def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url="/login", status_code=status.HTTP_303_SEE_OTHER)

# --- HTML Routes ---
@app.get("/", response_class=HTMLResponse)
def read_root(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/scheduler", response_class=HTMLResponse)
def read_scheduler(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("scheduler.html", {"request": request})

@app.get("/devices", response_class=HTMLResponse)
def read_devices(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("devices.html", {"request": request})

@app.get("/config", response_class=HTMLResponse)
def read_config(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("config.html", {"request": request})

@app.get("/help", response_class=HTMLResponse)
def read_help(request: Request, user=Depends(require_auth)):
    return templates.TemplateResponse("help.html", {"request": request})

# --- API Routes ---
@app.get("/api/devices")
def get_devices(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    devices = db.query(models.Device).all()
    return devices


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

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), db: Session = Depends(database.get_db), user=Depends(require_auth)):
    allowed_extensions = ["mp3", "wav", "flac", "aac", "ogg"]
    ext = file.filename.split(".")[-1].lower()
    if ext not in allowed_extensions:
        raise HTTPException(status_code=400, detail="Invalid file type")
    
    filename = f"{int(time.time())}_{file.filename}"
    file_path = os.path.join("audio_files", filename)
    
    with open(file_path, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)
        
    audio = models.AudioFile(filename=filename, original_name=file.filename)
    db.add(audio)
    db.commit()
    db.refresh(audio)
    return {"message": "File uploaded successfully", "file": audio}

class ScheduleRequest(BaseModel):
    device_name: str
    audio_id: int
    play_time: str
    repeat: str = "none"
    volume: int = 50

@app.post("/api/schedules")
def add_schedule(
    sched: ScheduleRequest,
    db: Session = Depends(database.get_db),
    user=Depends(require_auth)
):
    try:
        dt = datetime.fromisoformat(sched.play_time)
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
            "play_time": s.play_time.isoformat(),
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
        dt = datetime.fromisoformat(sched.play_time)
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
def realtime_play(device_name: str = Form("all"), audio_id: int = Form(...), volume: int = Form(50), position: float = Form(0.0), db: Session = Depends(database.get_db), user=Depends(require_auth)):
    audio = db.query(models.AudioFile).filter(models.AudioFile.id == audio_id).first()
    if not audio:
        raise HTTPException(status_code=404, detail="Audio not found")
        
    url = f"http://192.168.88.8:9876/audio_files/{audio.filename}"
    start_time = int(time.time()) + 2 
    
    cmd = {
        "action": "play",
        "url": url,
        "start_time": start_time,
        "volume": volume,
        "position": position
    }
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Play command sent"}

@app.post("/api/stop")
def realtime_stop(device_name: str = Form("all"), user=Depends(require_auth)):
    cmd = {"action": "stop"}
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Stop command sent"}

@app.post("/api/seek")
def realtime_seek(device_name: str = Form("all"), position: float = Form(...), user=Depends(require_auth)):
    cmd = {
        "action": "seek",
        "position": position,
        "start_time": int(time.time()) + 2
    }
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Seek command sent"}

@app.post("/api/speed")
def realtime_speed(device_name: str = Form("all"), speed: float = Form(1.0), user=Depends(require_auth)):
    cmd = {
        "action": "speed",
        "speed": speed
    }
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Speed command sent"}

@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await manager.connect(websocket)
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
    db.commit()
    return {"status": "ok"}

@app.post("/api/sync_time")
def sync_time(db: Session = Depends(database.get_db), user=Depends(require_auth)):
    mqtt_handler.publish_command("all", {"action": "sync_time"})
    return {"status": "ok"}

@app.post("/api/volume")
async def update_volume(device_name: str = Form(...), volume: int = Form(...)):
    mqtt_handler.publish_command(device_name, {"action": "volume", "volume": volume})
    return {"status": "ok"}

@app.post("/api/speed")
async def update_speed(device_name: str = Form(...), speed: float = Form(...)):
    mqtt_handler.publish_command(device_name, {"action": "speed", "speed": speed})
    return {"status": "ok"}
