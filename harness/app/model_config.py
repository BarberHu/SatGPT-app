"""Select the model route and prepare a non-secret Harness provider patch."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse


def selected_provider(environment=None) -> str:
    environment = os.environ if environment is None else environment
    provider = environment.get("DSH_PROVIDER", "deepseek-official").strip().lower()
    if provider not in {"aihubmix", "deepseek-official"}:
        raise ValueError("DSH_PROVIDER must be aihubmix or deepseek-official")
    return provider


def model_key_configured() -> bool:
    key_name = "AIHUBMIX_API_KEY" if selected_provider() == "aihubmix" else "DEEPSEEK_API_KEY"
    return bool(os.getenv(key_name, "").strip())


def selected_reasoning_effort(model: str | None = None, environment=None) -> str | None:
    environment = os.environ if environment is None else environment
    model = model or environment.get("DSH_MODEL", "deepseek-v4-flash")
    value = environment.get("DSH_REASONING_EFFORT", "").strip().lower()
    if not value:
        value = "high" if "deepseek" in model.lower() else "default"
    if value not in {"default", "off", "low", "high", "max"}:
        raise ValueError("DSH_REASONING_EFFORT must be default, off, low, high, or max")
    return None if value == "default" else value


def selected_max_tokens(environment=None) -> int:
    environment = os.environ if environment is None else environment
    raw = environment.get("DSH_MAX_TOKENS", "32768").strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("DSH_MAX_TOKENS must be an integer") from exc
    if not 1024 <= value <= 131072:
        raise ValueError("DSH_MAX_TOKENS must be between 1024 and 131072")
    return value


def harness_model_options(home: Path, environment=None) -> dict:
    environment = os.environ if environment is None else environment
    provider = selected_provider(environment)
    model = environment.get("DSH_MODEL", "deepseek-v4-flash").strip()
    if not model:
        raise ValueError("DSH_MODEL must not be empty")
    effort = selected_reasoning_effort(model, environment)
    effort_option = {"reasoning_effort": effort} if effort else {}
    if provider == "deepseek-official":
        return {"provider": provider, "model": model, **effort_option}

    base_url = environment.get("AIHUBMIX_BASE_URL", "https://aihubmix.com/v1").strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("AIHUBMIX_BASE_URL must be an HTTPS URL without credentials or API keys")
    is_deepseek = "deepseek" in model.lower()
    model_entry = {"id": model}
    compat = {"supportsDeveloperRole": False, "maxTokensField": "max_tokens"}
    if is_deepseek:
        compat["thinkingFormat"] = "deepseek"
        model_entry["reasoningEfforts"] = {"off": None, "low": "low", "high": "high", "max": "max"}
    patch = [{
        "id": "llm-pi-ai",
        "config": {"providers": {"aihubmix": {
            "apiKeyEnv": "AIHUBMIX_API_KEY",
            "api": "openai-completions",
            "baseURL": base_url,
            "compat": compat,
            **({"reasoning": effort} if effort else {}),
            "models": [model_entry],
        }}},
    }]
    home.mkdir(parents=True, exist_ok=True)
    patch_file = home / "aihubmix.patch.yml"
    patch_file.write_text(json.dumps(patch, ensure_ascii=False, indent=2), encoding="utf-8")
    return {"provider": provider, "model": model, "patches": (str(patch_file),), **effort_option}
