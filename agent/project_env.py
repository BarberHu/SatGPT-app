import os
from pathlib import Path

from dotenv import load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ENV_PATH = PROJECT_ROOT / ".env"

def _resolve_project_relative_path(raw_value: str | None) -> str | None:
    if not raw_value:
        return raw_value

    candidate = Path(raw_value.strip())
    if candidate.is_absolute():
        return str(candidate)

    return str((PROJECT_ROOT / candidate).resolve())


def load_project_env() -> Path:
    """Load a local .env when present; containers may inject the same values."""
    if PROJECT_ENV_PATH.is_file():
        load_dotenv(PROJECT_ENV_PATH, override=False)

    # Normalize repo-relative credential paths so services still work when
    # launched from nested directories like "agent/".
    credentials_path = os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
    if credentials_path:
        resolved = _resolve_project_relative_path(credentials_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    return PROJECT_ENV_PATH


def required_env(name: str) -> str:
    """Return one explicitly configured environment value or fail clearly."""
    value = os.getenv(name)
    if value is None or not value.strip():
        raise RuntimeError(f"Missing required environment variable: {name}")
    return value.strip()
