"""
会话级业务图层缓存

用于承接前端上传/绘制 AOI 的轻量同步，
让 agent 可以通过 mention 引用找到对应的几何对象。
"""
from __future__ import annotations

from copy import deepcopy
from typing import Any, Dict, Iterable, List, Optional


_BUSINESS_LAYER_NAMESPACES: Dict[str, Dict[str, Dict[str, Any]]] = {}


def _namespace_key(store_namespace: Optional[str], store_key: Optional[str]) -> str:
    namespace = str(store_namespace or "business_layer_store").strip() or "business_layer_store"
    key = str(store_key or "default").strip() or "default"
    return f"{namespace}::{key}"


def upsert_business_layers(
    *,
    store_namespace: Optional[str],
    store_key: Optional[str],
    layers: Iterable[Dict[str, Any]],
) -> List[Dict[str, Any]]:
    namespace_key = _namespace_key(store_namespace, store_key)
    namespace_store = _BUSINESS_LAYER_NAMESPACES.setdefault(namespace_key, {})

    saved_layers: List[Dict[str, Any]] = []
    for raw_layer in layers:
      # defensive copy to avoid accidental mutation from caller references
        layer = deepcopy(raw_layer or {})
        layer_id = str(layer.get("id") or "").strip()
        if not layer_id:
            continue
        namespace_store[layer_id] = layer
        saved_layers.append(deepcopy(layer))

    return saved_layers


def get_business_layer(
    *,
    layer_id: str,
    store_namespace: Optional[str],
    store_key: Optional[str],
) -> Optional[Dict[str, Any]]:
    namespace_key = _namespace_key(store_namespace, store_key)
    layer = _BUSINESS_LAYER_NAMESPACES.get(namespace_key, {}).get(layer_id)
    return deepcopy(layer) if layer else None


def resolve_business_layers(
    *,
    layer_ids: Iterable[str],
    store_namespace: Optional[str],
    store_key: Optional[str],
) -> List[Dict[str, Any]]:
    namespace_key = _namespace_key(store_namespace, store_key)
    namespace_store = _BUSINESS_LAYER_NAMESPACES.get(namespace_key, {})
    resolved: List[Dict[str, Any]] = []

    for layer_id in layer_ids:
        layer = namespace_store.get(str(layer_id))
        if layer:
            resolved.append(deepcopy(layer))

    return resolved
