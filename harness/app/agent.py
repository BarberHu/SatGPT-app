"Shared Harness prompt and result adapters."

from __future__ import annotations

import json


def describe_run_failure(result, provider: str) -> str:
    for event in reversed(result.events):
        if event.get("type") != "turn/end":
            continue
        error = event.get("data", {}).get("reason", {}).get("error", {})
        code = error.get("code", "UNKNOWN")
        if code == "AUTH":
            service = "AIHubMix" if provider == "aihubmix" else "Model provider"
            return f"{service} rejected the API key (401). Check the key and provider."
        return f"Harness run did not complete: {result.finish_reason} ({code})"
    return f"Harness run did not complete: {result.finish_reason}"


def conversation_prompt(request: str, bounds: list[float], catalog: list[dict], analysis_region=None,
                        *, created_at: str | None = None,
                        published_floods=None, area_ref=None, recovered_context=None) -> str:
    context = []
    if created_at:
        context.append(f"Request submitted at {created_at} (UTC).")
    scope = "the explicitly confirmed analysis polygon" if analysis_region else "the map viewport captured when this message was sent"
    context.extend((
        f"Current scope: {scope}.",
        f"Bounds [west,south,east,north]: {json.dumps(bounds)}.",
        f"Confirmed study area index reference: {json.dumps(area_ref)}.",
    ))
    if published_floods:
        context.append(f"Recent flood references for legacy tool compatibility: {json.dumps(published_floods, ensure_ascii=False)}.")
    if recovered_context:
        context.append(f"Prior conversation excerpts recovered from a legacy session: {json.dumps(recovered_context, ensure_ascii=False)}.")
    if catalog:
        context.append(f"Reference catalog: {json.dumps(catalog, ensure_ascii=False)}.")
    return "\n".join([*context, f"User request: {request}"])
