#!/usr/bin/env python

import os
from pathlib import Path

import ee
from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent
ROOT_ENV_PATH = PROJECT_ROOT / ".env"

# The repository root .env is the canonical config entry point.
load_dotenv(ROOT_ENV_PATH)


def get_env_var(*names, required=True, default=None):
    for name in names:
        value = os.environ.get(name)
        if value not in (None, ""):
            return value
    if required:
        joined = ", ".join(names)
        raise EnvironmentError(f"Missing required environment variable: one of [{joined}]")
    return default


def resolve_root_relative_path(raw_value):
    if raw_value in (None, ""):
        return raw_value

    candidate = Path(raw_value)
    if candidate.is_absolute():
        return str(candidate)

    return str((PROJECT_ROOT / candidate).resolve())


EE_ACCOUNT = get_env_var("EE_ACCOUNT", required=False, default=None)
EE_PRIVATE_KEY_FILE = resolve_root_relative_path(
    get_env_var("GOOGLE_APPLICATION_CREDENTIALS", "EE_PRIVATE_KEY_FILE")
)
GOOGLE_MAPS_API_KEY = get_env_var("GOOGLE_MAPS_API_KEY", required=False, default="")
MAPBOX_ACCESS_KEY = get_env_var(
    "MAPBOX_ACCESS_KEY",
    "REACT_APP_MAPBOX_ACCESS_KEY",
    required=False,
    default="",
)
CHATGPT_API_KEY = get_env_var("OPENAI_API_KEY", "CHATGPT_API_KEY")

EE_CREDENTIALS = ee.ServiceAccountCredentials(EE_ACCOUNT, EE_PRIVATE_KEY_FILE)
