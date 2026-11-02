from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from dotenv import load_dotenv

load_dotenv(Path(__file__).resolve().parents[2] / ".env")
uvicorn.run("app.server:app", host=os.getenv("HARNESS_HOST", "127.0.0.1"),
            port=int(os.getenv("HARNESS_PORT", "8001")), workers=1)
