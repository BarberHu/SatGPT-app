import os
from pathlib import Path

from dotenv import dotenv_values, load_dotenv


PROJECT_ROOT = Path(__file__).resolve().parent.parent
PROJECT_ENV_PATH = PROJECT_ROOT / ".env"
AGENT_ENV_PATH = PROJECT_ROOT / "agent" / ".env"

FALLBACK_SECRET_KEYS = (
    "TAVILY_API_KEY",
    "OPENAI_API_KEY",
    "CHATGPT_API_KEY",
)


def _is_missing_or_placeholder(value: str | None) -> bool:
    if not value:
        return True

    normalized = value.strip().lower()
    if normalized in {"", "none", "null"}:
        return True

    placeholder_markers = (
        "your-",
        "your_",
        "replace",
        "changeme",
        "example",
    )
    return any(marker in normalized for marker in placeholder_markers)


def _resolve_project_relative_path(raw_value: str | None) -> str | None:
    if not raw_value:
        return raw_value

    candidate = Path(raw_value.strip())
    if candidate.is_absolute():
        return str(candidate)

    return str((PROJECT_ROOT / candidate).resolve())


def load_project_env() -> Path:
    """Load the repository root .env as the single source of truth."""
    load_dotenv(PROJECT_ENV_PATH, override=False)

    # Backward-compatible fallback: if root .env keeps some keys blank,
    # reuse local agent/.env values without overriding explicitly provided env.
    if AGENT_ENV_PATH.exists():
        agent_env_values = dotenv_values(AGENT_ENV_PATH)
        for key in FALLBACK_SECRET_KEYS:
            current_value = os.getenv(key)
            fallback_value = agent_env_values.get(key)
            if _is_missing_or_placeholder(current_value) and fallback_value:
                os.environ[key] = str(fallback_value)

    # Normalize repo-relative credential paths so services still work when
    # launched from nested directories like "agent/".
    credentials_path = (
        os.getenv("GOOGLE_APPLICATION_CREDENTIALS")
        or os.getenv("EE_PRIVATE_KEY_FILE")
    )
    if credentials_path:
        resolved = _resolve_project_relative_path(credentials_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved
        if os.getenv("EE_PRIVATE_KEY_FILE"):
            os.environ["EE_PRIVATE_KEY_FILE"] = resolved

    return PROJECT_ENV_PATH
