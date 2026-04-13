from __future__ import annotations

from typing import Any, Dict


def _extract_usage(raw_response: Any) -> Dict[str, int]:
    if raw_response is None:
        return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}

    usage_metadata = getattr(raw_response, "usage_metadata", None) or {}
    if usage_metadata:
        prompt_tokens = int(usage_metadata.get("input_tokens", 0))
        completion_tokens = int(usage_metadata.get("output_tokens", 0))
        total_tokens = int(usage_metadata.get("total_tokens", prompt_tokens + completion_tokens))
        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        }

    response_metadata = getattr(raw_response, "response_metadata", None) or {}
    token_usage = response_metadata.get("token_usage", {}) if isinstance(response_metadata, dict) else {}
    if token_usage:
        prompt_tokens = int(token_usage.get("prompt_tokens", 0))
        completion_tokens = int(token_usage.get("completion_tokens", 0))
        total_tokens = int(token_usage.get("total_tokens", prompt_tokens + completion_tokens))
        return {
            "prompt_tokens": prompt_tokens,
            "completion_tokens": completion_tokens,
            "total_tokens": total_tokens,
        }

    return {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def empty_token_usage(enabled: bool) -> Dict[str, Any]:
    return {
        "enabled": enabled,
        "llm_calls": [],
        "totals": {
            "prompt_tokens": 0,
            "completion_tokens": 0,
            "total_tokens": 0,
        },
    }


def record_llm_usage(
    token_usage: Dict[str, Any],
    phase: str,
    model: str,
    raw_response: Any,
) -> Dict[str, Any]:
    usage = _extract_usage(raw_response)
    token_usage["llm_calls"].append(
        {
            "phase": phase,
            "model": model,
            **usage,
        }
    )
    token_usage["totals"]["prompt_tokens"] += usage["prompt_tokens"]
    token_usage["totals"]["completion_tokens"] += usage["completion_tokens"]
    token_usage["totals"]["total_tokens"] += usage["total_tokens"]
    return token_usage
