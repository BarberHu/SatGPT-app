"""Small, display-safe projection of durable Harness session events."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone


PRIVATE_KEY = re.compile(r"-----BEGIN [^-]*PRIVATE KEY-----.*?-----END [^-]*PRIVATE KEY-----", re.S)
BEARER = re.compile(r"(?i)\bBearer\s+[A-Za-z0-9._~+/=-]{12,}")


def clean_text(value, secrets: tuple[str, ...] = (), limit: int = 16000) -> str:
    text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, default=str)
    for secret in secrets:
        if secret:
            text = text.replace(secret, "[已隐藏密钥]")
    text = PRIVATE_KEY.sub("[已隐藏私钥]", text)
    text = BEARER.sub("Bearer [已隐藏令牌]", text)
    if len(text) > limit:
        return text[:limit] + f"\n…（已截断，原始长度 {len(text)} 字符）"
    return text


def _time(event: dict) -> str:
    stamp = event.get("time")
    if isinstance(stamp, (int, float)):
        return datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat()
    return datetime.now(timezone.utc).isoformat()


def _content_text(blocks: list, secrets: tuple[str, ...]) -> str:
    parts = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        if block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append(block["text"])
    return clean_text("\n".join(parts), secrets)


def add_harness_event(trace: list[dict], event: dict, secrets: tuple[str, ...] = ()) -> bool:
    """Append committed reasoning and tool activity, never provisional attempts."""
    if not isinstance(event, dict):
        return False
    kind = event.get("type")
    data = event.get("data") or {}
    when = _time(event)
    step = data.get("step")
    if kind == "assistant/message":
        # Keep committed reasoning in the process trace, separate from answer text.
        blocks = (data.get("message") or {}).get("content") or []
        changed = False
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "reasoning" and block.get("text"):
                trace.append({"kind": "analysis", "source": "reasoning",
                              "text": clean_text(block["text"], secrets),
                              "turn": data.get("turn"), "step": step, "time": when})
                changed = True
        return changed
    elif kind == "tool/call":
        call_id = str(data.get("callId") or "")
        trace.append({
            "kind": "tool", "call_id": call_id,
            "name": clean_text(data.get("name") or "工具", secrets, 120),
            "arguments": clean_text(data.get("arguments") or "", secrets),
            "result": "", "status": "running", "step": step, "time": when,
        })
        return True
    elif kind == "tool/result":
        message = data.get("message") or {}
        call_id = str(message.get("toolCallId") or (message.get("source") or {}).get("callId") or "")
        result = _content_text(message.get("content") or [], secrets)
        for item in reversed(trace):
            if item.get("kind") == "tool" and item.get("call_id") == call_id:
                item["result"] = result
                item["status"] = "error" if message.get("isError") else "done"
                item["finished_at"] = when
                return True
        trace.append({
            "kind": "tool", "call_id": call_id, "name": "工具", "arguments": "",
            "result": result, "status": "error" if message.get("isError") else "done",
            "step": step, "time": when, "finished_at": when,
        })
        return True
    elif kind == "llm/retry":
        failure = data.get("failure") or {}
        detail = failure.get("message") or failure.get("code")
        if not detail:
            return False
        trace.append({
            "kind": "status", "text": clean_text(detail, secrets, 300),
            "step": step, "time": when,
        })
        return True
    return False


def remove_final_answer(trace: list[dict], answer: str) -> None:
    """The final assistant message is rendered separately below the process."""
    for index in range(len(trace) - 1, -1, -1):
        item = trace[index]
        if (item.get("kind") == "analysis" and item.get("source", "text") == "text"
                and item.get("text", "").strip() == answer.strip()):
            del trace[index]
            return
