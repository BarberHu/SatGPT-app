import hashlib
import json
import os
import sys
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import ee
from langchain_core.messages import HumanMessage, SystemMessage
from langchain_openai import ChatOpenAI

from flood_aoi import _center_from_bounds, resolve_location_aoi
from gee_service import gee_service


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from experiments.water_asset_agent.catalog import (  # noqa: E402
    OFFICIAL_WATER_TAG_URL,
    AssetRecord,
    WaterAssetCatalogBuilder,
)
from experiments.water_asset_agent.tile_service import GEETileService  # noqa: E402


CATALOG_CACHE_PATH = PROJECT_ROOT / "experiments" / "water_asset_agent" / "cache" / "water_asset_catalog.json"
FLOOD_DATASET_REGISTRY_PATH = PROJECT_ROOT / "agent" / "config" / "flood_dataset_registry.json"
FLOOD_RELEVANT_THEMES = {"flood", "surface_water", "watershed"}
EXCLUDED_THEMES = {"ocean"}
REGIONAL_ALLOWLIST = ("usgs/wbd", "wwf/hydroatlas", "wwf/hydrosheds")
RECOMMENDED_RENDER_CACHE_TTL_SECONDS = 15 * 60
RECOMMENDED_RENDER_CACHE_MAX_ENTRIES = 128
MAX_RECOMMENDED_CATALOG_LAYERS = 9
PRODUCT_GROUP_LABELS = {
    "flood_event_classification": "Flood Classification",
    "flood_event_archive": "Flood Archive",
    "surface_water_history": "Surface Water History",
    "surface_water_frequency": "Surface Water Frequency",
    "basin_context": "Basin Context",
    "river_context": "River Context",
}
PRODUCT_GROUP_ORDER = {
    "flood_event_classification": 10,
    "flood_event_archive": 20,
    "surface_water_history": 30,
    "surface_water_frequency": 40,
    "basin_context": 50,
    "river_context": 60,
}
REGISTRY_SEMANTIC_KEYS = (
    "task_roles",
    "when_to_use",
    "when_not_to_use",
    "llm_recommendation_hint",
    "analysis_value",
    "risk_notes",
)


CORE_LAYER_DEFS = [
    {
        "id": "core:flood_detection",
        "asset_id": "core:flood_detection",
        "title": "Flood Detection",
        "summary": "Derived flood extent based on Sentinel-1 change detection.",
        "themes": ["flood"],
        "temporal_type": "event_window",
        "spatial_scope": "global",
        "has_official_example_code": False,
        "has_official_recipe": False,
        "official_url": None,
        "default_selected": True,
        "layer_family": "core",
        "render_strategy": "core_flood_detection",
    },
]


def _hash_to_layer_id(value: str) -> str:
    digest = hashlib.md5(value.encode("utf-8")).hexdigest()[:10]
    return f"asset:{digest}"


def _build_catalog_builder() -> WaterAssetCatalogBuilder:
    return WaterAssetCatalogBuilder(CATALOG_CACHE_PATH)


def _catalog_assets() -> List[AssetRecord]:
    return _build_catalog_builder().load(force_refresh=False)


def _load_flood_registry() -> Dict[str, Any]:
    if not FLOOD_DATASET_REGISTRY_PATH.exists():
        return {"selection_mode": "catalog_fallback", "assets": []}
    return json.loads(FLOOD_DATASET_REGISTRY_PATH.read_text(encoding="utf-8"))


def _registry_asset_entries() -> Dict[str, Dict[str, Any]]:
    payload = _load_flood_registry()
    assets = payload.get("assets", [])
    return {
        str(item.get("asset_id")): item
        for item in assets
        if item.get("asset_id")
    }


def _merge_render_profile(entry: Dict[str, Any]) -> Dict[str, Any]:
    render_profile = entry.get("render_profile") or {}
    if not render_profile:
        return {}

    if render_profile.get("mode") == "styled_vector":
        return {"style": deepcopy(render_profile.get("style") or {})}

    merged = {}
    for key in ("bands", "min", "max", "palette", "opacity", "gamma", "gain", "bias"):
        if key in render_profile:
            merged[key] = deepcopy(render_profile[key])
    return merged


def _build_ui_profile(asset: AssetRecord, entry: Dict[str, Any]) -> Dict[str, Any]:
    product_group = str(entry.get("product_group") or "other")
    selection = entry.get("selection_profile") or {}
    render_profile = entry.get("render_profile") or {}
    legend_spec = entry.get("legend_spec") or {}
    ui_profile = deepcopy(entry.get("ui_profile") or {})

    default_opacity = ui_profile.get("default_opacity")
    if default_opacity is None:
        default_opacity = 0.9 if render_profile.get("mode") == "styled_vector" or legend_spec.get("type") == "vector" else 0.82

    ui_profile.setdefault("group", product_group)
    ui_profile.setdefault("group_label", PRODUCT_GROUP_LABELS.get(product_group, "Other Context"))
    ui_profile.setdefault("group_order", PRODUCT_GROUP_ORDER.get(product_group, 999))
    ui_profile.setdefault("order", int(selection.get("priority", 0)))
    ui_profile.setdefault("default_visible", bool(selection.get("default_selected", False)))
    ui_profile["default_opacity"] = max(0.0, min(1.0, float(default_opacity)))

    if not ui_profile.get("badge_label") and product_group in {"basin_context", "river_context"}:
        ui_profile["badge_label"] = "Context"

    accent_color = ui_profile.get("accent_color")
    if accent_color is None:
        if legend_spec.get("type") == "categorical" and legend_spec.get("items"):
            accent_color = legend_spec["items"][-1].get("color")
        elif legend_spec.get("type") == "continuous" and legend_spec.get("palette"):
            accent_color = legend_spec["palette"][-1]
        elif legend_spec.get("type") == "vector":
            accent_color = (legend_spec.get("style") or {}).get("color")
    if accent_color:
        ui_profile["accent_color"] = accent_color

    return ui_profile


def _apply_registry_entry(asset: AssetRecord, entry: Dict[str, Any]) -> AssetRecord:
    merged = deepcopy(asset)
    if entry.get("title"):
        merged.title = str(entry["title"])
    if entry.get("summary"):
        merged.summary = str(entry["summary"])

    merged_vis = _merge_render_profile(entry)
    if merged_vis:
        merged.default_vis_params = deepcopy(merged_vis)
        merged.official_example_vis = deepcopy(merged_vis)

    if entry.get("legend_spec"):
        merged.legend_spec = deepcopy(entry["legend_spec"])

    execution_profile = entry.get("execution_profile") or {}
    hints = dict(merged.collection_processing_hints or {})
    if execution_profile.get("reducer"):
        hints["reducer"] = execution_profile["reducer"]
    if execution_profile.get("select_bands"):
        hints["select_bands"] = list(execution_profile["select_bands"])
    merged.collection_processing_hints = hints
    return merged


def _curated_catalog_assets() -> List[tuple[AssetRecord, Dict[str, Any]]]:
    catalog_by_id = {asset.asset_id: asset for asset in _catalog_assets()}
    entries = _registry_asset_entries()
    curated: List[tuple[AssetRecord, Dict[str, Any]]] = []
    for asset_id, entry in entries.items():
        if not entry.get("enabled", True):
            continue
        asset = catalog_by_id.get(asset_id)
        if not asset:
            continue
        curated.append((_apply_registry_entry(asset, entry), entry))
    return curated


def _is_stable_flood_candidate(asset: AssetRecord, location: Optional[str]) -> bool:
    theme_set = set(asset.themes or [])
    if not theme_set.intersection(FLOOD_RELEVANT_THEMES):
        return False
    if theme_set.intersection(EXCLUDED_THEMES):
        return False

    asset_id = (asset.asset_id or "").lower()
    if "deprecated" in (asset.title or "").lower():
        return False

    if asset.spatial_scope == "regional":
        if not any(prefix in asset_id for prefix in REGIONAL_ALLOWLIST):
            return False
        location_text = (location or "").lower()
        if not location_text and "usgs/wbd" in asset_id:
            return False

    return True


def _is_registry_candidate(entry: Dict[str, Any], location: Optional[str]) -> bool:
    selection = entry.get("selection_profile") or {}
    if not selection.get("recommendable", True):
        return False

    location_scope = str(selection.get("location_scope") or "global").lower()
    if location_scope == "us_only":
        location_text = (location or "").lower()
        if not any(token in location_text for token in ("united states", "usa", "us ", "u.s.", "america")):
            return False

    return True


def _temporal_score(asset: AssetRecord, dates: Dict[str, Optional[str]]) -> int:
    has_dates = any(dates.get(key) for key in ("pre_date", "peek_date", "after_date"))
    if not has_dates:
        return 0
    if asset.temporal_type in {"daily", "monthly", "yearly", "time_series"}:
        return 3
    if asset.temporal_type == "static":
        return 1
    return 0


def _spatial_score(asset: AssetRecord, location: Optional[str]) -> int:
    asset_id = (asset.asset_id or "").lower()
    if asset.spatial_scope == "global":
        return 2
    if "hydroatlas" in asset_id or "hydrosheds" in asset_id:
        return 2
    if "usgs/wbd" in asset_id:
        location_text = (location or "").lower()
        return 2 if any(token in location_text for token in ("united states", "usa", "us ", "u.s.")) else -3
    return 0


def _relevance_score(asset: AssetRecord) -> int:
    themes = set(asset.themes or [])
    score = 0
    if "flood" in themes:
        score += 8
    if "surface_water" in themes:
        score += 5
    if "watershed" in themes:
        score += 3
    return score


def _build_catalog_source_meta(asset: AssetRecord) -> Dict[str, Any]:
    return {
        "asset_id": asset.asset_id,
        "title": asset.title,
        "summary": asset.summary,
        "asset_type": asset.asset_type,
        "themes": list(asset.themes or []),
        "temporal_type": asset.temporal_type,
        "spatial_scope": asset.spatial_scope,
        "constraints": list(asset.constraints or []),
        "band_metadata": deepcopy(asset.band_metadata or []),
        "default_map_view": deepcopy(asset.default_map_view or {}),
        "official_url": asset.official_url,
        "catalog_source_label": "Google Earth Engine Water datasets",
        "catalog_source_url": OFFICIAL_WATER_TAG_URL,
        "has_official_example_code": bool(asset.official_example_code),
        "has_official_recipe": bool(asset.official_example_vis),
    }


def _build_asset_descriptor(asset: AssetRecord, score: int, registry_entry: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    layer_id = _hash_to_layer_id(asset.asset_id)
    registry_entry = registry_entry or {}
    ui_profile = _build_ui_profile(asset, registry_entry)
    descriptor = {
        "id": layer_id,
        "asset_id": asset.asset_id,
        "title": asset.title,
        "summary": asset.summary,
        "themes": list(asset.themes or []),
        "temporal_type": asset.temporal_type,
        "spatial_scope": asset.spatial_scope,
        "has_official_example_code": bool(asset.official_example_code),
        "has_official_recipe": bool(asset.official_example_vis),
        "official_url": asset.official_url,
        "source_meta": _build_catalog_source_meta(asset),
        "legend_spec": deepcopy(asset.legend_spec),
        "default_selected": False,
        "layer_family": "catalog",
        "render_strategy": "catalog_asset",
        "score": score,
        "product_group": registry_entry.get("product_group"),
        "selection_profile": deepcopy(registry_entry.get("selection_profile") or {}),
        "render_profile": deepcopy(registry_entry.get("render_profile") or {}),
        "execution_profile": deepcopy(registry_entry.get("execution_profile") or {}),
        "ui_profile": ui_profile,
    }
    for key in REGISTRY_SEMANTIC_KEYS:
        if key in registry_entry:
            descriptor[key] = deepcopy(registry_entry[key])
    return descriptor


def _get_recommendation_model() -> Optional[ChatOpenAI]:
    if not os.getenv("OPENAI_API_KEY"):
        return None
    try:
        return ChatOpenAI(
            model=os.getenv("LLM_MODEL", "gpt-4o-mini"),
            api_key=os.getenv("OPENAI_API_KEY", ""),
            base_url=os.getenv("OPENAI_API_BASE"),
            temperature=0.1,
            request_timeout=20,
        )
    except Exception:
        return None


def _extract_json_object(content: str) -> Dict[str, Any]:
    text = str(content or "").strip()
    if "```json" in text:
        text = text.split("```json", 1)[1].split("```", 1)[0].strip()
    elif "```" in text:
        text = text.split("```", 1)[1].split("```", 1)[0].strip()
    return json.loads(text)


def _fallback_recommendation_reason(layer: Dict[str, Any]) -> str:
    if layer.get("when_to_use"):
        return str(layer["when_to_use"])
    if layer.get("llm_recommendation_hint"):
        return str(layer["llm_recommendation_hint"])
    if layer.get("summary"):
        return str(layer["summary"])
    return "Recommended as a relevant flood-analysis context layer."


def _build_layer_recommendation_briefs(layers: Sequence[Dict[str, Any]]) -> List[Dict[str, Any]]:
    briefs: List[Dict[str, Any]] = []
    for layer in layers:
        if layer.get("layer_family") != "catalog":
            continue
        briefs.append({
            "id": layer.get("id"),
            "asset_id": layer.get("asset_id"),
            "title": layer.get("title"),
            "product_group": layer.get("product_group"),
            "summary": layer.get("summary"),
            "task_roles": layer.get("task_roles") or [],
            "temporal_type": layer.get("temporal_type"),
            "spatial_scope": layer.get("spatial_scope"),
            "when_to_use": layer.get("when_to_use"),
            "when_not_to_use": layer.get("when_not_to_use"),
            "llm_recommendation_hint": layer.get("llm_recommendation_hint"),
            "risk_notes": layer.get("risk_notes"),
            "priority": (layer.get("selection_profile") or {}).get("priority"),
            "default_selected": (layer.get("selection_profile") or {}).get("default_selected", False),
        })
    return briefs


def _recommend_layers_with_llm(
    *,
    location: Optional[str],
    dates: Dict[str, Optional[str]],
    layers: Sequence[Dict[str, Any]],
) -> Optional[Dict[str, Any]]:
    model = _get_recommendation_model()
    if not model:
        return None

    layer_briefs = _build_layer_recommendation_briefs(layers)
    if not layer_briefs:
        return None

    prompt = {
        "task": "Select and explain recommended geospatial layers for flood analysis.",
        "constraints": [
            "Only choose from the provided layer candidates.",
            "Prefer a compact, explainable set of 3 to 5 selected catalog layers.",
            "Do not select layers marked unsuitable by their when_not_to_use text.",
            "Always return JSON only.",
        ],
        "event_context": {
            "location": location,
            "pre_date": dates.get("pre_date"),
            "peek_date": dates.get("peek_date"),
            "after_date": dates.get("after_date"),
        },
        "layer_candidates": layer_briefs,
        "output_schema": {
            "overall_strategy": "short strategy sentence",
            "selected_asset_ids": ["asset_id values from candidates"],
            "layer_reasons": {
                "asset_id": "one concise reason grounded in event/date/AOI and layer role"
            },
        },
    }

    try:
        response = model.invoke([
            SystemMessage(content=(
                "You are a strict geospatial flood-analysis reviewer. "
                "Recommend only useful layers from a curated Earth Engine whitelist. "
                "Be concise and operational, not promotional."
            )),
            HumanMessage(content=json.dumps(prompt, ensure_ascii=False)),
        ])
        payload = _extract_json_object(str(response.content))
    except Exception as error:
        print(f"[WARN] LLM layer recommendation failed; using rule fallback: {error}")
        return None

    selected_asset_ids = [
        str(asset_id)
        for asset_id in payload.get("selected_asset_ids", [])
        if asset_id
    ]
    layer_reasons = payload.get("layer_reasons") or {}
    if not isinstance(layer_reasons, dict):
        layer_reasons = {}

    return {
        "overall_strategy": payload.get("overall_strategy"),
        "selected_asset_ids": selected_asset_ids,
        "layer_reasons": {
            str(key): str(value)
            for key, value in layer_reasons.items()
            if key and value
        },
    }


def _apply_recommendation_explanations(
    *,
    layers: List[Dict[str, Any]],
    llm_recommendation: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    selected_layer_ids = [
        layer["id"]
        for layer in layers
        if layer.get("default_selected")
        or (layer.get("selection_profile") or {}).get("default_selected")
    ]

    selected_asset_ids = llm_recommendation.get("selected_asset_ids", []) if llm_recommendation else []
    selected_asset_order = {
        asset_id: index
        for index, asset_id in enumerate(selected_asset_ids)
    }
    if selected_asset_order:
        selected_layer_ids.extend(
            layer["id"]
            for layer in layers
            if layer.get("asset_id") in selected_asset_order
        )

    seen: set[str] = set()
    selected_layer_ids = [
        layer_id
        for layer_id in selected_layer_ids
        if not (layer_id in seen or seen.add(layer_id))
    ]

    reason_by_asset = (llm_recommendation or {}).get("layer_reasons") or {}
    for index, layer in enumerate(layers):
        asset_id = layer.get("asset_id")
        layer["recommendation_reason"] = reason_by_asset.get(asset_id) or _fallback_recommendation_reason(layer)
        layer["recommendation_strategy"] = (llm_recommendation or {}).get("overall_strategy")
        layer["llm_selected"] = asset_id in selected_asset_order
        if asset_id in selected_asset_order:
            layer["llm_recommendation_rank"] = selected_asset_order[asset_id]
        else:
            layer["llm_recommendation_rank"] = index + 100

    return {
        "recommended_layers": layers,
        "selected_layer_ids": selected_layer_ids,
        "recommendation_strategy": (llm_recommendation or {}).get("overall_strategy"),
        "recommendation_source": "llm" if llm_recommendation else "rules",
    }


def recommend_flood_layers(
    *,
    location: Optional[str],
    dates: Dict[str, Optional[str]],
) -> Dict[str, Any]:
    descriptors: List[Dict[str, Any]] = [dict(item) for item in CORE_LAYER_DEFS]

    ranked_assets: List[tuple[int, AssetRecord, Dict[str, Any]]] = []
    curated_assets = _curated_catalog_assets()
    if curated_assets:
        for asset, entry in curated_assets:
            if not _is_registry_candidate(entry, location):
                continue
            selection = entry.get("selection_profile") or {}
            score = int(selection.get("priority", 0))
            score += _temporal_score(asset, dates)
            score += _spatial_score(asset, location)
            if asset.official_example_code:
                score += 1
            if asset.legend_spec.get("type") != "text":
                score += 2
            ranked_assets.append((score, asset, entry))
    else:
        for asset in _catalog_assets():
            if not _is_stable_flood_candidate(asset, location):
                continue
            score = _relevance_score(asset)
            score += _temporal_score(asset, dates)
            score += _spatial_score(asset, location)
            if asset.official_example_code:
                score += 2
            if asset.official_example_vis:
                score += 2
            if asset.asset_type in {"Image", "ImageCollection", "FeatureCollection"}:
                score += 2
            if score > 0:
                ranked_assets.append((score, asset, {}))

    ranked_assets.sort(key=lambda item: (-item[0], item[1].title.lower()))
    catalog_descriptors = [
        _build_asset_descriptor(asset, score, entry)
        for score, asset, entry in ranked_assets[:MAX_RECOMMENDED_CATALOG_LAYERS]
    ]
    all_descriptors = descriptors + catalog_descriptors
    llm_recommendation = _recommend_layers_with_llm(
        location=location,
        dates=dates,
        layers=all_descriptors,
    )

    return _apply_recommendation_explanations(
        layers=all_descriptors,
        llm_recommendation=llm_recommendation,
    )


def build_confirmation_context(
    *,
    event: Optional[str],
    event_description: Optional[str],
    location: Optional[str],
    pre_date: Optional[str],
    peek_date: Optional[str],
    after_date: Optional[str],
    mention_context: Optional[Dict[str, Any]] = None,
    confirmation_version: int = 1,
) -> Dict[str, Any]:
    mentioned_aoi = (mention_context or {}).get("mentioned_aoi")
    mentioned_aoi_source = (mention_context or {}).get("mentioned_aoi_source")
    effective_location = location or mentioned_aoi_source

    if mentioned_aoi:
        aoi_context = {
            "resolved_aoi": deepcopy(mentioned_aoi),
            "aoi_resolution_meta": {
                "location": effective_location or "Mention-derived AOI",
                "source": "mentioned_business_layer",
                "confidence": 1.0,
                "status": "resolved",
                "bounds": mentioned_aoi.get("bounds"),
                "resolution_rank": 0,
            },
            "coordinates": (
                [mentioned_aoi["center"]["lng"], mentioned_aoi["center"]["lat"]]
                if isinstance(mentioned_aoi.get("center"), dict)
                and mentioned_aoi["center"].get("lng") is not None
                and mentioned_aoi["center"].get("lat") is not None
                else _center_from_bounds(mentioned_aoi.get("bounds")) if mentioned_aoi.get("bounds") else [0.0, 0.0]
            ),
            "bounds": mentioned_aoi.get("bounds"),
            "geojson": mentioned_aoi.get("geojson"),
            "geo_data": {
                "source": "mentioned_business_layer",
                "label": mentioned_aoi.get("label"),
            },
        }
    else:
        aoi_context = resolve_location_aoi(location or "")

    recommendation_context = recommend_flood_layers(
        location=effective_location,
        dates={
            "pre_date": pre_date,
            "peek_date": peek_date,
            "after_date": after_date,
        },
    )
    return {
        "event": event,
        "event_description": event_description,
        "location": effective_location,
        "pre_date": pre_date,
        "peek_date": peek_date,
        "after_date": after_date,
        "resolved_aoi": aoi_context["resolved_aoi"],
        "confirmed_aoi": aoi_context["resolved_aoi"],
        "aoi_resolution_meta": aoi_context["aoi_resolution_meta"],
        "recommended_layers": recommendation_context["recommended_layers"],
        "selected_layer_ids": recommendation_context["selected_layer_ids"],
        "recommendation_strategy": recommendation_context.get("recommendation_strategy"),
        "recommendation_source": recommendation_context.get("recommendation_source"),
        "confirmation_version": confirmation_version,
        "coordinates": aoi_context["coordinates"],
        "bounds": aoi_context["bounds"],
        "geojson": aoi_context["geojson"],
        "geo_data": aoi_context["geo_data"],
        "mentioned_aoi": deepcopy(mentioned_aoi) if mentioned_aoi else None,
        "mentioned_aoi_source": mentioned_aoi_source,
        "mentioned_layer_refs": deepcopy((mention_context or {}).get("mentioned_layer_refs", [])),
    }


def build_aoi_from_business_layer(layer_record: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not layer_record or not isinstance(layer_record, dict):
        return None

    geojson = layer_record.get("geojson")
    bounds = layer_record.get("bounds")
    center = layer_record.get("center")
    label = layer_record.get("label") or layer_record.get("id") or "Mentioned AOI"
    source = layer_record.get("source") or "business_layer"

    if not isinstance(geojson, dict) or not bounds:
        return None

    geometry = geojson.get("geometry") if geojson.get("type") == "Feature" else geojson
    if not geometry:
        return None

    return {
        "id": layer_record.get("id"),
        "source": source,
        "kind": "multipolygon" if geometry.get("type") == "MultiPolygon" else "polygon",
        "label": label,
        "bounds": bounds,
        "center": center,
        "geojson": geojson,
        "origin": layer_record.get("origin"),
        "created_at": layer_record.get("created_at"),
        "updated_at": layer_record.get("updated_at"),
    }


def _get_catalog_asset_by_layer_id(layer_id: str, layers: Sequence[Dict[str, Any]]) -> Optional[AssetRecord]:
    layer = next((item for item in layers if item["id"] == layer_id and item["layer_family"] == "catalog"), None)
    if not layer:
        return None
    asset_id = layer["asset_id"]
    for asset, _ in _curated_catalog_assets():
        if asset.asset_id == asset_id:
            return asset
    for asset in _catalog_assets():
        if asset.asset_id == asset_id:
            return asset
    return None


def _get_requested_layer_descriptor(layer_id: str, layers: Sequence[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    return next((item for item in layers if item.get("id") == layer_id), None)


def _aoi_geometry_payload(aoi: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if not aoi:
        return None
    geojson = aoi.get("geojson")
    if isinstance(geojson, dict) and geojson.get("type") == "Feature":
        return geojson.get("geometry")
    if isinstance(geojson, dict):
        return geojson
    return None


def _aoi_bounds(aoi: Optional[Dict[str, Any]]) -> Optional[Dict[str, float]]:
    if not aoi:
        return None
    return aoi.get("bounds")


def _aoi_to_region(aoi: Dict[str, Any]) -> ee.Geometry:
    geometry = _aoi_geometry_payload(aoi)
    if geometry:
        return ee.Geometry(geometry)
    bounds = _aoi_bounds(aoi)
    if not bounds:
        raise ValueError("AOI geometry is required to render a layer")
    return ee.Geometry.Rectangle([bounds["west"], bounds["south"], bounds["east"], bounds["north"]])


def _build_legend(vis_recipe: Dict[str, Any], fallback: str) -> Dict[str, Any]:
    palette = vis_recipe.get("palette") or []
    if palette:
        return {
            "type": "palette",
            "palette": palette,
            "min": vis_recipe.get("min"),
            "max": vis_recipe.get("max"),
            "label": fallback,
        }
    return {
        "type": "text",
        "label": fallback,
    }


class FloodDatasetRenderer:
    def __init__(self) -> None:
        self.tile_service = GEETileService(PROJECT_ROOT)
        self._catalog_render_cache: Dict[str, Dict[str, Any]] = {}

    def _build_catalog_render_cache_key(
        self,
        *,
        layer_id: str,
        asset_id: str,
        aoi: Dict[str, Any],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> str:
        payload = {
            "layer_id": layer_id,
            "asset_id": asset_id,
            "start_date": start_date,
            "end_date": end_date,
            "bounds": _aoi_bounds(aoi),
            "geometry": _aoi_geometry_payload(aoi),
        }
        serialized = json.dumps(payload, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
        return hashlib.sha1(serialized.encode("utf-8")).hexdigest()

    def _prune_catalog_render_cache(self) -> None:
        now = time.time()
        expired_keys = [
            key
            for key, entry in self._catalog_render_cache.items()
            if now - entry.get("created_at", 0) > RECOMMENDED_RENDER_CACHE_TTL_SECONDS
        ]
        for key in expired_keys:
            self._catalog_render_cache.pop(key, None)

        if len(self._catalog_render_cache) <= RECOMMENDED_RENDER_CACHE_MAX_ENTRIES:
            return

        overflow = len(self._catalog_render_cache) - RECOMMENDED_RENDER_CACHE_MAX_ENTRIES
        oldest_keys = sorted(
            self._catalog_render_cache.items(),
            key=lambda item: item[1].get("created_at", 0),
        )[:overflow]
        for key, _ in oldest_keys:
            self._catalog_render_cache.pop(key, None)

    def _get_cached_catalog_render(self, cache_key: str) -> Optional[Dict[str, Any]]:
        self._prune_catalog_render_cache()
        cached = self._catalog_render_cache.get(cache_key)
        if not cached:
            return None
        return deepcopy(cached["payload"])

    def _store_cached_catalog_render(self, cache_key: str, payload: Dict[str, Any]) -> None:
        self._catalog_render_cache[cache_key] = {
            "created_at": time.time(),
            "payload": deepcopy(payload),
        }
        self._prune_catalog_render_cache()

    def _derive_catalog_vis_from_metadata(
        self,
        asset: AssetRecord,
    ) -> Optional[tuple[Dict[str, Any], str, List[str]]]:
        band_names = [str(item.get("name")) for item in asset.band_metadata if item.get("name")]
        if not band_names:
            return None

        vis_recipe, vis_source, validator_notes = self.tile_service._derive_vis_params(asset, band_names)
        if not vis_recipe or not vis_recipe.get("bands"):
            return None
        return vis_recipe, vis_source, validator_notes

    def _render_catalog_asset(
        self,
        *,
        asset: AssetRecord,
        aoi: Dict[str, Any],
        start_date: Optional[str],
        end_date: Optional[str],
    ) -> Dict[str, Any]:
        cache_key = self._build_catalog_render_cache_key(
            layer_id=_hash_to_layer_id(asset.asset_id),
            asset_id=asset.asset_id,
            aoi=aoi,
            start_date=start_date,
            end_date=end_date,
        )
        cached = self._get_cached_catalog_render(cache_key)
        if cached:
            return cached

        self.tile_service.initialize()
        if not self.tile_service.initialized:
            raise RuntimeError(self.tile_service.init_error or "Earth Engine initialization failed")

        region = _aoi_to_region(aoi)
        bounds = _aoi_bounds(aoi)
        center = (
            ((bounds["south"] + bounds["north"]) / 2, (bounds["west"] + bounds["east"]) / 2)
            if bounds
            else (20.0, 0.0)
        )

        if asset.asset_type == "FeatureCollection":
            collection = ee.FeatureCollection(asset.asset_id)
            collection = collection.filterBounds(region)
            style = asset.official_example_vis.get("style") or asset.default_vis_params.get("style") or {
                "color": "#00bcd4",
                "fillColor": "00000000",
                "width": 2,
            }
            image = collection.style(
                color=style.get("color", "#00bcd4"),
                fillColor=style.get("fillColor", "00000000"),
                width=style.get("width", 2),
            )
            map_id = image.getMapId({})
            vis_recipe = {"style": style}
            legend = deepcopy(asset.legend_spec) or {"type": "text", "label": asset.title}
            vis_source = "official_example" if asset.official_example_vis.get("style") else "catalog_default"
        else:
            image, collection_strategy, collection_notes = self.tile_service._prepare_image(
                asset,
                region,
                start_date,
                end_date,
            )
            metadata_vis = self._derive_catalog_vis_from_metadata(asset)
            if metadata_vis:
                vis_recipe, vis_source, validator_notes = metadata_vis
                collection_notes = collection_notes + validator_notes + [f"strategy:{collection_strategy}", "vis_derivation:catalog_metadata"]
            else:
                band_names = image.bandNames().getInfo()
                vis_recipe, vis_source, validator_notes = self.tile_service._derive_vis_params(
                    asset,
                    band_names,
                )
                collection_notes = collection_notes + validator_notes + [f"strategy:{collection_strategy}", "vis_derivation:ee_band_query"]
            map_id = image.getMapId(vis_recipe)
            legend = deepcopy(asset.legend_spec) or _build_legend(vis_recipe, asset.title)

        tile_url = map_id["tile_fetcher"].url_format
        payload = {
            "layer_id": _hash_to_layer_id(asset.asset_id),
            "tile_url": tile_url,
            "vis_recipe": vis_recipe,
            "legend": legend,
            "source_meta": {
                **_build_catalog_source_meta(asset),
                "legend_spec": deepcopy(asset.legend_spec),
            },
            "official_url": asset.official_url,
            "vis_source": vis_source,
        }
        self._store_cached_catalog_render(cache_key, payload)
        return payload

    def _render_core_layer(
        self,
        *,
        layer_id: str,
        aoi: Dict[str, Any],
        pre_date: Optional[str],
        peek_date: Optional[str],
        after_date: Optional[str],
    ) -> Dict[str, Any]:
        geometry = _aoi_geometry_payload(aoi)
        bounds = _aoi_bounds(aoi)

        if layer_id == "core:flood_detection":
            payload = gee_service.get_flood_change_detection_by_geojson(pre_date, peek_date, geometry) if geometry else gee_service.get_flood_change_detection(pre_date, peek_date, bounds)
            return {
                "layer_id": layer_id,
                "tile_url": payload.get("tile_url"),
                "vis_recipe": {"palette": ["ff0000"], "min": 0, "max": 1},
                "legend": {"type": "palette", "palette": ["ff0000"], "label": "Flood extent"},
                "source_meta": {"asset_id": "core:flood_detection", "title": "Flood Detection"},
                "official_url": None,
                "stats": payload.get("stats"),
            }

        impact = gee_service.get_flood_impact_by_geojson(pre_date, peek_date, geometry) if geometry else gee_service.get_flood_impact_by_bounds(pre_date, peek_date, bounds)
        layers = impact.get("layers", {}) if isinstance(impact, dict) else {}
        mapping = {
            "core:population": ("population", {"palette": ["yellow", "orange", "red", "darkred"], "min": 0, "max": 1000}),
            "core:urban": ("urban", {"palette": ["ffeda0", "feb24c", "f03b20"], "min": 0, "max": 10000}),
            "core:landcover": ("landcover", {}),
        }
        layer_key, vis_recipe = mapping[layer_id]
        payload = layers.get(layer_key, {})
        return {
            "layer_id": layer_id,
            "tile_url": payload.get("tile_url"),
            "vis_recipe": vis_recipe,
            "legend": {"type": "text", "label": payload.get("legend") or CORE_LAYER_DEFS[0]["title"]},
            "source_meta": {"asset_id": layer_id, "title": payload.get("name") or layer_key},
            "official_url": None,
        }

    def render_layer(
        self,
        *,
        layer_id: str,
        recommended_layers: Sequence[Dict[str, Any]],
        confirmed_aoi: Dict[str, Any],
        pre_date: Optional[str],
        peek_date: Optional[str],
        after_date: Optional[str],
    ) -> Dict[str, Any]:
        if layer_id.startswith("core:"):
            return self._render_core_layer(
                layer_id=layer_id,
                aoi=confirmed_aoi,
                pre_date=pre_date,
                peek_date=peek_date,
                after_date=after_date,
            )

        requested_layer = _get_requested_layer_descriptor(layer_id, recommended_layers)
        asset = _get_catalog_asset_by_layer_id(layer_id, recommended_layers)
        if not asset:
            raise ValueError(f"Unknown recommended layer: {layer_id}")

        rendered = self._render_catalog_asset(
            asset=asset,
            aoi=confirmed_aoi,
            start_date=pre_date or peek_date,
            end_date=after_date or peek_date,
        )

        if requested_layer:
            rendered["product_group"] = requested_layer.get("product_group")
            rendered["legend_spec"] = deepcopy(requested_layer.get("legend_spec") or {})
            rendered["ui_profile"] = deepcopy(requested_layer.get("ui_profile") or {})
            rendered["source_meta"]["product_group"] = requested_layer.get("product_group")
            rendered["source_meta"]["ui_profile"] = deepcopy(requested_layer.get("ui_profile") or {})

        return rendered


renderer = FloodDatasetRenderer()
