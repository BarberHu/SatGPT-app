from __future__ import annotations

import os
from pathlib import Path

import uvicorn
from .config import load_project_env, validate_config

load_project_env()
try:
    validate_config("harness")
except ValueError as exc:
    raise SystemExit(f"Configuration error: {exc}") from None
uvicorn.run("app.server:app", host=os.getenv("HARNESS_HOST", "127.0.0.1"),
            port=int(os.getenv("HARNESS_PORT", "8001")), workers=1)
