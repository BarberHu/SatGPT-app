from __future__ import annotations

import json
from typing import Any, Dict, Optional


TRACE_MARKER = "SATGPT_TRACE_DELETE_ME"


def new_debug_trace(enabled: bool = False) -> Dict[str, Any]:
    return {
        "enabled": enabled,
        "step": 0,
    }


def trace_event(
    debug_trace: Optional[Dict[str, Any]],
    *,
    node: str,
    phase: str,
    payload: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    state = dict(debug_trace or {})
    state.setdefault("enabled", False)
    state["step"] = int(state.get("step", 0)) + 1

    if not state["enabled"]:
        return state

    event = {
        "marker": TRACE_MARKER,
        "step": state["step"],
        "node": node,
        "phase": phase,
        "payload": _to_safe_value(payload or {}),
    }
    print("[HYDRAFLOODS_TRACE] " + json.dumps(event, ensure_ascii=False))
    return state


def summarize_tool_result(result: Dict[str, Any]) -> Dict[str, Any]:
    artifacts = result.get("artifacts", {})
    primary_layer = artifacts.get("primary_layer", {})
    metadata = result.get("metadata", {})
    return {
        "status": result.get("status"),
        "tool_name": result.get("tool_name"),
        "summary": result.get("summary"),
        "has_tile_url": bool(primary_layer.get("tile_url")),
        "artifact_keys": sorted(list(artifacts.keys())),
        "metadata_keys": sorted(list(metadata.keys())),
    }


def _to_safe_value(value: Any) -> Any:
    if value is None:
        return None
    if isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, list):
        return [_to_safe_value(item) for item in value[:10]]
    if isinstance(value, tuple):
        return [_to_safe_value(item) for item in value[:10]]
    if isinstance(value, dict):
        safe: Dict[str, Any] = {}
        for index, (key, item) in enumerate(value.items()):
            if index >= 20:
                safe["..."] = "truncated"
                break
            safe[str(key)] = _to_safe_value(item)
        return safe
    return repr(value)
