#!/usr/bin/env python

import json
import os

from dotenv import load_dotenv
import ee

# Load environment variables from a .env file if present
load_dotenv()


def get_env_var(*names, default=None, required=True):
    for name in names:
        value = os.environ.get(name)
        if value:
            return value
    if default is not None:
        return default
    if required:
        joined = ", ".join(names)
        raise EnvironmentError(f"Missing required environment variable: {joined}")
    return default


def _infer_service_account_email(key_file):
    if not key_file or not os.path.exists(key_file):
        return None
    try:
        with open(key_file, "r", encoding="utf-8") as handle:
            payload = json.load(handle)
        return payload.get("client_email")
    except Exception:
        return None


EE_PRIVATE_KEY_FILE = get_env_var("EE_PRIVATE_KEY_FILE", "GOOGLE_APPLICATION_CREDENTIALS")
EE_ACCOUNT = get_env_var(
    "EE_ACCOUNT",
    default=_infer_service_account_email(EE_PRIVATE_KEY_FILE),
    required=True,
)
GOOGLE_MAPS_API_KEY = get_env_var("GOOGLE_MAPS_API_KEY", default="", required=False)
MAPBOX_ACCESS_KEY = get_env_var(
    "MAPBOX_ACCESS_KEY",
    "REACT_APP_MAPBOX_ACCESS_KEY",
    default="",
    required=False,
)
CHATGPT_API_KEY = get_env_var("CHATGPT_API_KEY", "OPENAI_API_KEY")
GEE_PROJECT_ID = get_env_var("GEE_PROJECT_ID", "PROJECT_ID", default=None, required=False)

EE_CREDENTIALS = ee.ServiceAccountCredentials(EE_ACCOUNT, EE_PRIVATE_KEY_FILE)
