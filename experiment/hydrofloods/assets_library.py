from __future__ import annotations

import json
from pathlib import Path
from copy import deepcopy
from typing import Any, Dict, List, Optional


BASE_DIR = Path(__file__).resolve().parent
DEFAULT_ASSETS_REGISTRY_PATH = BASE_DIR / "flood_dataset_registry.json"

ASSET_RUNTIME_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "OPERA/DSWX/L3_V1/S1": {
        "availability": {"start_date": "2022-01-01"},
        "execution_profile": {"time_filter_mode": "date_range"},
    },
    "OPERA/DSWX/L3_V1/HLS": {
        "availability": {"start_date": "2022-01-01"},
        "execution_profile": {"time_filter_mode": "date_range"},
    },
    "GLOBAL_FLOOD_DB/MODIS_EVENTS/V1": {
        "availability": {"start_date": "2000-02-17", "end_date": "2018-12-10"},
        "execution_profile": {"time_filter_mode": "date_range"},
    },
    "JRC/GSW1_4/MonthlyHistory": {
        "availability": {"start_date": "1984-03-16", "end_date": "2022-01-01"},
        "execution_profile": {"time_filter_mode": "calendar_month"},
    },
    "JRC/GSW1_4/MonthlyRecurrence": {
        "execution_profile": {"time_filter_mode": "calendar_month"},
    },
    "JRC/GSW1_4/YearlyHistory": {
        "availability": {"start_date": "1984-01-01", "end_date": "2022-01-01"},
        "execution_profile": {"time_filter_mode": "calendar_year"},
    },
    "USGS/WBD/2017/HUC08": {
        "execution_profile": {"time_filter_mode": "none"},
    },
    "WWF/HydroATLAS/v1/Basins/level06": {
        "execution_profile": {"time_filter_mode": "none"},
    },
    "WWF/HydroSHEDS/v1/FreeFlowingRivers": {
        "execution_profile": {"time_filter_mode": "none"},
    },
}


def _deep_merge(base: Dict[str, Any], extra: Dict[str, Any]) -> Dict[str, Any]:
    merged = deepcopy(base)
    for key, value in extra.items():
        if isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = deepcopy(value)
    return merged


def _apply_runtime_overrides(registry: Dict[str, Any]) -> Dict[str, Any]:
    updated = deepcopy(registry)
    merged_assets = []
    for asset in updated.get("assets", []):
        overrides = ASSET_RUNTIME_OVERRIDES.get(asset["asset_id"])
        merged_assets.append(_deep_merge(asset, overrides) if overrides else asset)
    updated["assets"] = merged_assets
    return updated


def load_assets_registry(path: Optional[Path] = None) -> Dict[str, Any]:
    registry_path = path or DEFAULT_ASSETS_REGISTRY_PATH
    raw_registry = json.loads(registry_path.read_text(encoding="utf-8"))
    return _apply_runtime_overrides(raw_registry)


ASSETS_REGISTRY = load_assets_registry()
ASSETS_LIBRARY: List[Dict[str, Any]] = ASSETS_REGISTRY["assets"]


def get_enabled_assets() -> List[Dict[str, Any]]:
    return [asset for asset in ASSETS_LIBRARY if asset.get("enabled")]


def get_recommendable_assets() -> List[Dict[str, Any]]:
    return [
        asset
        for asset in get_enabled_assets()
        if asset.get("selection_profile", {}).get("recommendable", False)
    ]


def get_asset_spec(asset_id: str) -> Dict[str, Any]:
    for asset in ASSETS_LIBRARY:
        if asset["asset_id"] == asset_id:
            return asset
    raise KeyError(f"Unknown asset: {asset_id}")


def shortlist_assets(asset_ids: Optional[List[str]] = None) -> List[Dict[str, Any]]:
    if not asset_ids:
        return get_enabled_assets()
    allowed = set(asset_ids)
    return [asset for asset in get_enabled_assets() if asset["asset_id"] in allowed]


def render_assets_catalog_for_llm(asset_ids: Optional[List[str]] = None) -> str:
    lines: List[str] = []
    for asset in shortlist_assets(asset_ids):
        selection_profile = asset.get("selection_profile", {})
        execution_profile = asset.get("execution_profile", {})
        lines.append(f"- {asset['asset_id']}")
        lines.append(f"  title: {asset['title']}")
        lines.append(f"  group: {asset['product_group']}")
        lines.append(f"  summary: {asset['summary']}")
        lines.append(f"  priority: {selection_profile.get('priority', 0)}")
        lines.append(f"  location_scope: {selection_profile.get('location_scope', 'global')}")
        lines.append(f"  requires_aoi: {execution_profile.get('requires_aoi', False)}")
        lines.append(f"  requires_date_range: {execution_profile.get('requires_date_range', False)}")
        lines.append(f"  supports_tile: {execution_profile.get('supports_tile', False)}")
    return "\n".join(lines)


def build_assets_registry_summary() -> Dict[str, Any]:
    groups: Dict[str, int] = {}
    for asset in get_enabled_assets():
        group = asset["product_group"]
        groups[group] = groups.get(group, 0) + 1

    return {
        "schema_version": ASSETS_REGISTRY.get("schema_version", 1),
        "selection_mode": ASSETS_REGISTRY.get("selection_mode", "curated_only"),
        "asset_count": len(get_enabled_assets()),
        "product_groups": groups,
        "assets": [
            {
                "asset_id": asset["asset_id"],
                "title": asset["title"],
                "product_group": asset["product_group"],
            }
            for asset in get_enabled_assets()
        ],
    }
