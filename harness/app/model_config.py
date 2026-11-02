"""Select the model route and prepare a non-secret Harness provider patch."""

from __future__ import annotations

import json
import os
from pathlib import Path
from urllib.parse import urlparse


def selected_provider() -> str:
    provider = os.getenv("DSH_PROVIDER", "deepseek-official").strip().lower()
    if provider not in {"aihubmix", "deepseek-official"}:
        raise ValueError("DSH_PROVIDER 只能是 aihubmix 或 deepseek-official")
    return provider


def model_key_configured() -> bool:
    key_name = "AIHUBMIX_API_KEY" if selected_provider() == "aihubmix" else "DEEPSEEK_API_KEY"
    return bool(os.getenv(key_name, "").strip())


def selected_reasoning_effort(model: str | None = None) -> str | None:
    model = model or os.getenv("DSH_MODEL", "deepseek-v4-flash")
    value = os.getenv("DSH_REASONING_EFFORT", "").strip().lower()
    if not value:
        value = "high" if "deepseek" in model.lower() else "default"
    if value not in {"default", "off", "low", "high", "max"}:
        raise ValueError("DSH_REASONING_EFFORT 只能是 default、off、low、high 或 max")
    return None if value == "default" else value


def selected_max_tokens() -> int:
    raw = os.getenv("DSH_MAX_TOKENS", "32768").strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise ValueError("DSH_MAX_TOKENS 必须是整数") from exc
    if not 1024 <= value <= 131072:
        raise ValueError("DSH_MAX_TOKENS 必须在 1024–131072 之间")
    return value


def harness_model_options(home: Path) -> dict:
    provider = selected_provider()
    model = os.getenv("DSH_MODEL", "deepseek-v4-flash").strip()
    if not model:
        raise ValueError("DSH_MODEL 不能为空")
    effort = selected_reasoning_effort(model)
    effort_option = {"reasoning_effort": effort} if effort else {}
    if provider == "deepseek-official":
        return {"provider": provider, "model": model, **effort_option}

    base_url = os.getenv("AIHUBMIX_BASE_URL", "https://aihubmix.com/v1").strip().rstrip("/")
    parsed = urlparse(base_url)
    if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password:
        raise ValueError("AIHUBMIX_BASE_URL 必须是 HTTPS 地址，且不能包含账号或密钥")
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
