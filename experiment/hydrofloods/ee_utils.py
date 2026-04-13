import os
from pathlib import Path

import ee
from dotenv import load_dotenv


ROOT_DOTENV = Path(__file__).resolve().parents[2] / ".env"
load_dotenv(ROOT_DOTENV)


def init_gee():
    key_file = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    project_id = os.getenv("GEE_PROJECT_ID")

    if not key_file:
        raise RuntimeError("Missing GOOGLE_APPLICATION_CREDENTIALS")
    if not project_id:
        raise RuntimeError("Missing GEE_PROJECT_ID")
    if not os.path.exists(key_file):
        raise RuntimeError(f"GEE key file not found: {key_file}")

    credentials = ee.ServiceAccountCredentials(email=None, key_file=key_file)
    ee.Initialize(credentials, project=project_id)

    return {
        "initialized": True,
        "project_id": project_id,
        "key_file": key_file,
        "mode": "service_account",
    }


# 地图瓦片服务 getMapId() → map_id["tile_fetcher"].url_format
# 静态图片URL getThumbURL()
