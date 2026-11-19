"""Opt-in local page/live verification server. Uses root .env and isolated history.

Run: harness/.venv/Scripts/python -m harness.tests.region_page_server
Uses the configured AGENT_PORT; never touches existing conversation storage.
"""
import shutil
import uuid
from pathlib import Path

from harness.app import server
from satgpt_config import load_project_env, validate_config, integer, required_env


def main():
    load_project_env(); validate_config('backend')
    root = Path(__file__).resolve().parents[1]
    isolated = root / 'state' / 'region-verification' / uuid.uuid4().hex
    shutil.copytree(root / 'app', isolated / 'app', ignore=shutil.ignore_patterns('__pycache__'))
    server.ROOT = isolated
    import uvicorn
    uvicorn.run('satgpt_backend:app', host=required_env('AGENT_HOST'), port=integer('AGENT_PORT'),
                log_level='warning')


if __name__ == '__main__': main()
