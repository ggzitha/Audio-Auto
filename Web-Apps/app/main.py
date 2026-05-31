import os
import shutil
import time
from datetime import datetime
from fastapi import FastAPI, UploadFile, File, Form, Depends, HTTPException, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from sqlalchemy.orm import Session
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.date import DateTrigger

from . import models, database, mqtt_handler

models.Base.metadata.create_all(bind=database.engine)

app = FastAPI(title="Audio-Auto")

app.mount("/static", StaticFiles(directory="app/static"), name="static")
app.mount("/audio_files", StaticFiles(directory="audio_files"), name="audio_files")

templates = Jinja2Templates(directory="app/templates")

scheduler = BackgroundScheduler(timezone=os.environ.get("TZ", "Asia/Jayapura"))

def execute_schedule(schedule_id: int):
    db = database.SessionLocal()
    schedule = db.query(models.Schedule).filter(models.Schedule.id == schedule_id).first()
    if schedule and schedule.is_active:
        audio = schedule.audio
        if audio:
            url = f"http://192.168.88.8:9876/audio_files/{audio.filename}"
            # Allow 5 seconds for devices to download and buffer before exact NTP sync start
            start_time = int(time.time()) + 5
            
            cmd = {
                "action": "play",
                "url": url,
                "start_time": start_time,
                "volume": schedule.volume
            }
            mqtt_handler.publish_command(schedule.device_name, cmd)
            
            schedule.is_active = False
            db.commit()
    db.close()

@app.on_event("startup")
def startup_event():
    mqtt_handler.start_mqtt()
    scheduler.start()
    
    db = database.SessionLocal()
    active_schedules = db.query(models.Schedule).filter(models.Schedule.is_active == True).all()
    for sch in active_schedules:
        if sch.play_time > datetime.now():
            scheduler.add_job(
                execute_schedule, 
                trigger=DateTrigger(run_date=sch.play_time), 
                args=[sch.id],
                id=f"sched_{sch.id}"
            )
    db.close()

@app.on_event("shutdown")
def shutdown_event():
    scheduler.shutdown()

# --- HTML Routes ---

@app.get("/", response_class=HTMLResponse)
def read_root(request: Request):
    return templates.TemplateResponse("index.html", {"request": request})

@app.get("/scheduler", response_class=HTMLResponse)
def read_scheduler(request: Request):
    return templates.TemplateResponse("scheduler.html", {"request": request})

@app.get("/devices", response_class=HTMLResponse)
def read_devices(request: Request):
    return templates.TemplateResponse("devices.html", {"request": request})

@app.get("/config", response_class=HTMLResponse)
def read_config(request: Request):
    return templates.TemplateResponse("config.html", {"request": request})

@app.get("/help", response_class=HTMLResponse)
def read_help(request: Request):
    return templates.TemplateResponse("help.html", {"request": request})

# --- API Routes ---

@app.get("/api/devices")
def get_devices(db: Session = Depends(database.get_db)):
    devices = db.query(models.Device).all()
    return devices

@app.get("/api/files")
def get_files(db: Session = Depends(database.get_db)):
    files = db.query(models.AudioFile).all()
    return files

@app.post("/api/upload")
async def upload_file(file: UploadFile = File(...), db: Session = Depends(database.get_db)):
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

@app.post("/api/schedule")
def add_schedule(
    device_name: str = Form(...),
    audio_id: int = Form(...),
    play_time: str = Form(...),
    volume: int = Form(50),
    db: Session = Depends(database.get_db)
):
    try:
        dt = datetime.fromisoformat(play_time)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid date format")
        
    if dt <= datetime.now():
        raise HTTPException(status_code=400, detail="Play time must be in the future")

    new_sched = models.Schedule(
        device_name=device_name,
        audio_id=audio_id,
        play_time=dt,
        volume=volume
    )
    db.add(new_sched)
    db.commit()
    db.refresh(new_sched)
    
    scheduler.add_job(
        execute_schedule, 
        trigger=DateTrigger(run_date=dt), 
        args=[new_sched.id],
        id=f"sched_{new_sched.id}"
    )
    
    return {"message": "Schedule added", "schedule": new_sched}

@app.get("/api/schedules")
def get_schedules(db: Session = Depends(database.get_db)):
    schedules = db.query(models.Schedule).all()
    result = []
    for s in schedules:
        result.append({
            "id": s.id,
            "device_name": s.device_name,
            "audio_name": s.audio.original_name if s.audio else "Unknown",
            "play_time": s.play_time.isoformat(),
            "volume": s.volume,
            "is_active": s.is_active
        })
    return result

@app.delete("/api/schedule/{schedule_id}")
def delete_schedule(schedule_id: int, db: Session = Depends(database.get_db)):
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
def realtime_play(device_name: str = Form("all"), audio_id: int = Form(...), volume: int = Form(50), db: Session = Depends(database.get_db)):
    audio = db.query(models.AudioFile).filter(models.AudioFile.id == audio_id).first()
    if not audio:
        raise HTTPException(status_code=404, detail="Audio not found")
        
    url = f"http://192.168.88.8:9876/audio_files/{audio.filename}"
    start_time = int(time.time()) + 2 
    
    cmd = {
        "action": "play",
        "url": url,
        "start_time": start_time,
        "volume": volume
    }
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Play command sent"}

@app.post("/api/stop")
def realtime_stop(device_name: str = Form("all")):
    cmd = {"action": "stop"}
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Stop command sent"}

@app.post("/api/seek")
def realtime_seek(device_name: str = Form("all"), position: int = Form(...)):
    cmd = {
        "action": "seek",
        "position": position,
        "start_time": int(time.time()) + 2
    }
    mqtt_handler.publish_command(device_name, cmd)
    return {"message": "Seek command sent"}
