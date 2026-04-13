import hashlib
import json
import sys
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

import ee

from flood_aoi import resolve_location_aoi
from gee_service import gee_service


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from experiments.water_asset_agent.catalog import AssetRecord, WaterAssetCatalogBuilder  # noqa: E402
from experiments.water_asset_agent.tile_service import GEETileService  # noqa: E402


CATALOG_CACHE_PATH = PROJECT_ROOT / "experiments" / "water_asset_agent" / "cache" / "water_asset_catalog.json"
FLOOD_DATASET_REGISTRY_PATH = PROJECT_ROOT / "agent" / "config" / "flood_dataset_registry.json"
FLOOD_RELEVANT_THEMES = {"flood", "surface_water", "watershed"}
EXCLUDED_THEMES = {"ocean"}
REGIONAL_ALLOWLIST = ("usgs/wbd", "wwf/hydroatlas", "wwf/hydrosheds")
RECOMMENDED_RENDER_CACHE_TTL_SECONDS = 15 * 60
RECOMMENDED_RENDER_CACHE_MAX_ENTRIES = 128


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
    {
        "id": "core:population",
        "asset_id": "core:population",
        "title": "Population Impact",
        "summary": "Population exposed inside the detected flood mask.",
        "themes": ["flood", "hydromet_support"],
        "temporal_type": "event_window",
        "spatial_scope": "global",
        "has_official_example_code": False,
        "has_official_recipe": True,
        "official_url": None,
        "default_selected": False,
        "layer_family": "core",
        "render_strategy": "core_population",
    },
    {
        "id": "core:urban",
        "asset_id": "core:urban",
        "title": "Built-up Impact",
        "summary": "Built-up exposure inside the detected flood mask.",
        "themes": ["flood", "hydromet_support"],
        "temporal_type": "event_window",
        "spatial_scope": "global",
        "has_official_example_code": False,
        "has_official_recipe": True,
        "official_url": None,
        "default_selected": False,
        "layer_family": "core",
        "render_strategy": "core_urban",
    },
    {
        "id": "core:landcover",
        "asset_id": "core:landcover",
        "title": "Land Cover Impact",
        "summary": "Affected land cover types inside the detected flood mask.",
        "themes": ["flood", "hydromet_support"],
        "temporal_type": "event_window",
        "spatial_scope": "global",
        "has_official_example_code": False,
        "has_official_recipe": True,
        "official_url": None,
        "default_selected": False,
        "layer_family": "core",
        "render_strategy": "core_landcover",
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


def _build_asset_descriptor(asset: AssetRecord, score: int, registry_entry: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    layer_id = _hash_to_layer_id(asset.asset_id)
    return {
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
        "legend_spec": deepcopy(asset.legend_spec),
        "default_selected": False,
        "layer_family": "catalog",
        "render_strategy": "catalog_asset",
        "score": score,
        "product_group": (registry_entry or {}).get("product_group"),
        "selection_profile": deepcopy((registry_entry or {}).get("selection_profile") or {}),
        "render_profile": deepcopy((registry_entry or {}).get("render_profile") or {}),
        "execution_profile": deepcopy((registry_entry or {}).get("execution_profile") or {}),
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
        for score, asset, entry in ranked_assets[:6]
    ]

    default_selected_ids = [item["id"] for item in descriptors if item.get("default_selected")]
    default_selected_ids.extend(
        descriptor["id"]
        for descriptor in catalog_descriptors
        if descriptor.get("selection_profile", {}).get("default_selected")
    )

    return {
        "recommended_layers": descriptors + catalog_descriptors,
        "selected_layer_ids": default_selected_ids,
    }


def build_confirmation_context(
    *,
    event: Optional[str],
    event_description: Optional[str],
    location: Optional[str],
    pre_date: Optional[str],
    peek_date: Optional[str],
    after_date: Optional[str],
    confirmation_version: int = 1,
) -> Dict[str, Any]:
    aoi_context = resolve_location_aoi(location or "")
    recommendation_context = recommend_flood_layers(
        location=location,
        dates={
            "pre_date": pre_date,
            "peek_date": peek_date,
            "after_date": after_date,
        },
    )
    return {
        "event": event,
        "event_description": event_description,
        "location": location,
        "pre_date": pre_date,
        "peek_date": peek_date,
        "after_date": after_date,
        "resolved_aoi": aoi_context["resolved_aoi"],
        "confirmed_aoi": aoi_context["resolved_aoi"],
        "aoi_resolution_meta": aoi_context["aoi_resolution_meta"],
        "recommended_layers": recommendation_context["recommended_layers"],
        "selected_layer_ids": recommendation_context["selected_layer_ids"],
        "confirmation_version": confirmation_version,
        "coordinates": aoi_context["coordinates"],
        "bounds": aoi_context["bounds"],
        "geojson": aoi_context["geojson"],
        "geo_data": aoi_context["geo_data"],
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
                "asset_id": asset.asset_id,
                "title": asset.title,
                "summary": asset.summary,
                "asset_type": asset.asset_type,
                "themes": asset.themes,
                "temporal_type": asset.temporal_type,
                "spatial_scope": asset.spatial_scope,
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

        asset = _get_catalog_asset_by_layer_id(layer_id, recommended_layers)
        if not asset:
            raise ValueError(f"Unknown recommended layer: {layer_id}")

        return self._render_catalog_asset(
            asset=asset,
            aoi=confirmed_aoi,
            start_date=pre_date or peek_date,
            end_date=after_date or peek_date,
        )


renderer = FloodDatasetRenderer()
