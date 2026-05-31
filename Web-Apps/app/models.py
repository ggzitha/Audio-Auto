from sqlalchemy import Column, Integer, String, Boolean, DateTime, Float, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy.ext.declarative import declarative_base
from datetime import datetime

Base = declarative_base()

class Device(Base):
    __tablename__ = "devices"

    id = Column(Integer, primary_key=True, index=True)
    name = Column(String(100), unique=True, index=True) # e.g., ESP32-Ruang-Axxxx
    ip_address = Column(String(50))
    status = Column(String(50), default="offline")
    rssi = Column(Integer, default=0)
    temperature = Column(Float, default=0.0)
    last_seen = Column(DateTime, default=datetime.utcnow)

class AudioFile(Base):
    __tablename__ = "audio_files"

    id = Column(Integer, primary_key=True, index=True)
    filename = Column(String(255), unique=True, index=True)
    original_name = Column(String(255))
    duration_sec = Column(Integer, default=0)
    upload_time = Column(DateTime, default=datetime.utcnow)

class Schedule(Base):
    __tablename__ = "schedules"

    id = Column(Integer, primary_key=True, index=True)
    device_name = Column(String(100)) # "all" or specific device name
    audio_id = Column(Integer, ForeignKey("audio_files.id"))
    play_time = Column(DateTime)
    volume = Column(Integer, default=50)
    is_active = Column(Boolean, default=True)

    audio = relationship("AudioFile")
