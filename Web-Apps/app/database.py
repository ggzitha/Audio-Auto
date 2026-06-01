import os
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from .models import Base

DB_USER = os.environ.get("DB_USER", "audioauto")
DB_PASS = os.environ.get("DB_PASS", "secure_db_password")
DB_HOST = os.environ.get("DB_HOST", "db")
DB_NAME = os.environ.get("DB_NAME", "audioauto")

# Use pymysql (pure Python, no C extension needed).
# Force connect_timeout and charset to avoid IPv6/encoding issues.
# PyMySQL connect_args: use_unicode, charset override at engine level.
SQLALCHEMY_DATABASE_URL = (
    f"mysql+pymysql://{DB_USER}:{DB_PASS}@{DB_HOST}/{DB_NAME}"
    f"?charset=utf8mb4"
)

try:
    engine = create_engine(
        SQLALCHEMY_DATABASE_URL,
        pool_pre_ping=True,
        pool_recycle=3600,
        connect_args={
            "connect_timeout": 10,
        }
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
except Exception as e:
    print(f"DB init error: {e} — falling back to SQLite")
    engine = create_engine(
        "sqlite:///./sql_app.db",
        connect_args={"check_same_thread": False}
    )
    SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)

def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
