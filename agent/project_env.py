from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ENV_PATH = PROJECT_ROOT / ".env"


def load_project_env() -> Path:
    """Load the repository root .env as the single source of truth."""
    load_dotenv(PROJECT_ENV_PATH, override=False)
    return PROJECT_ENV_PATH
