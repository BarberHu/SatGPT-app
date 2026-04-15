"""
解析用户消息中的 SATGPT mention metadata，
并将引用解析成可用于 AOI 优先级决策的上下文。
"""
from __future__ import annotations

import json
import re
from copy import deepcopy
from typing import Any, Dict, List, Optional

from business_layer_store import get_business_layer
from flood_dataset_service import build_aoi_from_business_layer


MENTION_CONTEXT_START = "<<SATGPT_MENTION_CONTEXT>>"
MENTION_CONTEXT_END = "<<END_SATGPT_MENTION_CONTEXT>>"
MENTION_BLOCK_PATTERN = re.compile(
    rf"{re.escape(MENTION_CONTEXT_START)}\s*(.*?)\s*{re.escape(MENTION_CONTEXT_END)}",
    re.DOTALL,
)

def extract_mention_payload(message_content: Any) -> Dict[str, Any]:
    if message_content is None:
      return {}

    content = str(message_content)
    match = MENTION_BLOCK_PATTERN.search(content)
    if not match:
        return {}

    try:
        payload = json.loads(match.group(1).strip())
    except json.JSONDecodeError:
        return {}

    return payload if isinstance(payload, dict) else {}


def _has_resolvable_spatial_ref(ref: Dict[str, Any], thread_id: Optional[str]) -> bool:
    layer_id = str(ref.get("id") or "").strip()
    store_key = ref.get("store_key") or thread_id
    return bool(layer_id and store_key)


def _build_ref_summary(ref: Dict[str, Any], layer_record: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    source = layer_record if isinstance(layer_record, dict) else ref
    return {
        "label": source.get("label"),
        "center": deepcopy(source.get("center")),
        "bounds": deepcopy(source.get("bounds")),
    }


def resolve_mention_context(message_content: Any, thread_id: Optional[str] = None) -> Dict[str, Any]:
    payload = extract_mention_payload(message_content)
    mentions = payload.get("mentions") if isinstance(payload.get("mentions"), list) else []

    resolved_refs: List[Dict[str, Any]] = []
    mentioned_aoi: Optional[Dict[str, Any]] = None
    mentioned_aoi_source: Optional[str] = None

    for raw_ref in mentions:
        if not isinstance(raw_ref, dict):
            continue

        ref = deepcopy(raw_ref)
        layer_id = str(ref.get("id") or "").strip()
        store_namespace = ref.get("store_namespace") or "business_layer_store"
        store_key = ref.get("store_key") or thread_id

        if not layer_id:
            resolved_refs.append(ref)
            continue

        if not _has_resolvable_spatial_ref(ref, thread_id):
            resolved_refs.append(ref)
            continue

        layer_record = get_business_layer(
            layer_id=layer_id,
            store_namespace=store_namespace,
            store_key=store_key,
        )
        if not layer_record:
            ref["resolution_status"] = "missing"
            ref["summary"] = _build_ref_summary(ref)
            resolved_refs.append(ref)
            continue

        candidate_aoi = build_aoi_from_business_layer(layer_record)
        if candidate_aoi is None:
            ref["resolution_status"] = "invalid_geometry"
            ref["summary"] = _build_ref_summary(ref, layer_record)
            resolved_refs.append(ref)
            continue

        ref["resolution_status"] = "resolved"
        ref["summary"] = _build_ref_summary(ref, layer_record)
        ref["resolved_layer"] = layer_record
        resolved_refs.append(ref)

        if mentioned_aoi is None:
            mentioned_aoi = candidate_aoi
            mentioned_aoi_source = layer_record.get("label") or layer_record.get("id")

    return {
        "mentions": mentions,
        "mentioned_layer_refs": resolved_refs,
        "mentioned_aoi": mentioned_aoi,
        "mentioned_aoi_source": mentioned_aoi_source,
    }
