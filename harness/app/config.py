"""Harness adapter for shared root configuration, independent of launch cwd."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))
from satgpt_config import load_project_env, validate_config  # noqa: E402
