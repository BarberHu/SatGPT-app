"""Basic compatibility import for the shared root configuration contract."""
import sys
from pathlib import Path
PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
from satgpt_config import load_project_env, required_env, validate_config  # noqa: E402
