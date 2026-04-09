from __future__ import annotations

import csv
import json
import re
import time
from dataclasses import asdict, dataclass, field
from datetime import datetime
from html import unescape
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

OFFICIAL_WATER_TAG_URL = "https://developers.google.com/earth-engine/datasets/tags/water?hl=zh-cn"
OFFICIAL_DATASET_URL_TEMPLATE = "https://developers.google.com/earth-engine/datasets/catalog/{slug}?hl=zh-cn"
USER_AGENT = "SatGPT-Water-Asset-Agent/0.1"
CACHE_SCHEMA_VERSION = 2


@dataclass
class AssetRecord:
    slug: str
    title: str
    asset_id: str
    asset_type: str
    summary: str
    official_url: str
    themes: List[str]
    spatial_scope: str
    temporal_type: str
    query_keywords: List[str]
    default_vis_params: Dict[str, Any]
    constraints: List[str]
    priority: int
    status: str = "active"
    band_metadata: List[Dict[str, Any]] = field(default_factory=list)
    official_example_code: str = ""
    official_example_vis: Dict[str, Any] = field(default_factory=dict)
    default_map_view: Dict[str, Any] = field(default_factory=dict)
    collection_processing_hints: Dict[str, Any] = field(default_factory=dict)


def _strip_tags(value: str) -> str:
    text = re.sub(r"<[^>]+>", " ", value)
    return re.sub(r"\s+", " ", unescape(text)).strip()


def _strip_code_markup(value: str) -> str:
    cleaned = re.sub(r"</span>", "", value)
    cleaned = re.sub(r"<span[^>]*>", "", cleaned)
    cleaned = re.sub(r"<br\s*/?>", "\n", cleaned)
    cleaned = re.sub(r"</?(pre|code)[^>]*>", "", cleaned)
    return unescape(cleaned).strip()


def _http_get(url: str, **kwargs: Any) -> requests.Response:
    headers = kwargs.pop("headers", {})
    response = requests.get(
        url,
        headers={"User-Agent": USER_AGENT, **headers},
        timeout=kwargs.pop("timeout", 30),
        **kwargs,
    )
    response.raise_for_status()
    return response


def _coerce_float(raw: Optional[str]) -> Optional[float]:
    if raw is None:
        return None
    text = raw.strip().replace(",", "")
    if not text:
        return None
    try:
        return float(text)
    except ValueError:
        return None


def _infer_themes(text: str) -> List[str]:
    lowered = text.lower()
    mapping = {
        "flood": ["flood", "洪水", "inundation"],
        "surface_water": ["surface water", "water", "水体", "surfacewater", "wetland"],
        "watershed": ["watershed", "basin", "流域", "hydroatlas", "hydrosheds", "huc"],
        "ocean": ["ocean", "sea", "marine", "海洋", "salinity", "temperature", "velocity"],
        "groundwater": ["grace", "mass grids", "mascon", "groundwater"],
        "evapotranspiration": ["openet", "evapotranspiration", "wapor", "aeti", "ret", "蒸散"],
        "soil_water": ["soil", "soilgrids"],
    }
    themes = [theme for theme, keywords in mapping.items() if any(keyword in lowered for keyword in keywords)]
    return themes or ["surface_water"]


def _infer_spatial_scope(text: str) -> str:
    lowered = text.lower()
    if any(keyword in lowered for keyword in ["conus", "usgs", "huc"]):
        return "regional"
    if any(keyword in lowered for keyword in ["global", "world", "wwf", "jrc", "grace", "hydrosheds"]):
        return "global"
    return "global"


def _infer_temporal_type(asset_type: str, text: str) -> str:
    lowered = text.lower()
    if asset_type == "FeatureCollection":
        return "static"
    if "daily" in lowered:
        return "daily"
    if "monthly" in lowered:
        return "monthly"
    if "yearly" in lowered or "annual" in lowered:
        return "yearly"
    if asset_type == "ImageCollection":
        return "time_series"
    return "static"


def _tokenize_keywords(*parts: str) -> List[str]:
    tokens: List[str] = []
    for part in parts:
        lowered = part.lower().replace("/", " ").replace("-", " ")
        tokens.extend(re.findall(r"[\w\u4e00-\u9fff]+", lowered))
    seen: set[str] = set()
    ordered: List[str] = []
    for token in tokens:
        if len(token) <= 1 or token in seen:
            continue
        seen.add(token)
        ordered.append(token)
    return ordered[:40]


def _extract_band_metadata(html: str) -> List[Dict[str, Any]]:
    table_match = re.search(
        r'<h3[^>]+id="bands"[^>]*>[\s\S]*?</h3>[\s\S]*?<table class="eecat">([\s\S]*?)</table>',
        html,
        flags=re.IGNORECASE,
    )
    if not table_match:
        return []
    rows = re.findall(r"<tr>([\s\S]*?)</tr>", table_match.group(1), flags=re.IGNORECASE)
    band_rows: List[Dict[str, Any]] = []
    for row in rows:
        if "<th" in row.lower():
            continue
        columns = re.findall(r"<td[^>]*>([\s\S]*?)</td>", row, flags=re.IGNORECASE)
        if len(columns) < 6:
            continue
        name = _strip_tags(columns[0])
        unit = _strip_tags(columns[1])
        min_raw = _strip_tags(columns[2])
        max_raw = _strip_tags(columns[3])
        pixel_size = _strip_tags(columns[4])
        description = _strip_tags(columns[5])
        if not name:
            continue
        band_rows.append(
            {
                "name": name,
                "unit": unit,
                "min": _coerce_float(min_raw),
                "max": _coerce_float(max_raw),
                "pixel_size": pixel_size,
                "description": description,
            }
        )
    return band_rows


def _extract_code_editor_block(html: str) -> str:
    block_match = re.search(
        r'<h3[^>]+id="code-editor-javascript"[^>]*>[\s\S]*?<devsite-code><pre[^>]*>([\s\S]*?)</pre>',
        html,
        flags=re.IGNORECASE,
    )
    if not block_match:
        return ""
    return _strip_code_markup(block_match.group(1))


def _extract_object_literal(source: str) -> Optional[str]:
    patterns = [
        r"var\s+visualization\s*=\s*({[\s\S]*?});",
        r"var\s+visParams\s*=\s*({[\s\S]*?});",
        r"Map\.addLayer\([^,]+,\s*({[\s\S]*?})\s*,",
    ]
    for pattern in patterns:
        match = re.search(pattern, source, flags=re.IGNORECASE)
        if match:
            return match.group(1)
    return None


def _parse_js_string_list(raw: str) -> List[str]:
    return re.findall(r"['\"]([^'\"]+)['\"]", raw)


def _extract_visualization_recipe(example_code: str) -> Dict[str, Any]:
    object_literal = _extract_object_literal(example_code)
    if not object_literal:
        return {}

    recipe: Dict[str, Any] = {}
    bands_match = re.search(r"bands\s*:\s*\[([^\]]+)\]", object_literal, flags=re.IGNORECASE)
    if bands_match:
        recipe["bands"] = _parse_js_string_list(bands_match.group(1))

    palette_match = re.search(r"palette\s*:\s*\[([^\]]+)\]", object_literal, flags=re.IGNORECASE)
    if palette_match:
        recipe["palette"] = _parse_js_string_list(palette_match.group(1))

    for key in ["min", "max", "opacity", "gamma", "gain", "bias"]:
        number_match = re.search(rf"{key}\s*:\s*(-?\d+(?:\.\d+)?)", object_literal, flags=re.IGNORECASE)
        if number_match:
            recipe[key] = float(number_match.group(1))

    return recipe


def _extract_map_view(example_code: str) -> Dict[str, Any]:
    center_match = re.search(
        r"Map\.setCenter\(\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+)\s*\)",
        example_code,
    )
    if not center_match:
        return {}
    lon, lat, zoom = center_match.groups()
    return {"lon": float(lon), "lat": float(lat), "zoom": int(zoom)}


def _infer_collection_processing_hints(asset_type: str, example_code: str, temporal_type: str) -> Dict[str, Any]:
    hints: Dict[str, Any] = {}
    if asset_type != "ImageCollection":
        return hints

    reducer = "median"
    for candidate in ["mosaic", "mean", "median", "first", "max", "min", "sum"]:
        if re.search(rf"\.{candidate}\s*\(", example_code):
            reducer = candidate
            break
    hints["reducer"] = reducer
    hints["needs_time_filter"] = temporal_type != "static"
    if "filterDate" in example_code:
        hints["example_uses_date_filter"] = True
    if "filterBounds" in example_code:
        hints["example_uses_bounds_filter"] = True
    return hints


def _default_vis_params(
    asset_id: str,
    asset_type: str,
    band_metadata: List[Dict[str, Any]],
    official_example_vis: Dict[str, Any],
) -> Dict[str, Any]:
    if asset_type == "FeatureCollection":
        return {"style": {"color": "#00bcd4", "fillColor": "00000000", "width": 2}}
    if official_example_vis:
        return dict(official_example_vis)

    lower_id = asset_id.lower()
    if "globalsurfacewater" in lower_id:
        return {"bands": ["occurrence"], "min": 0, "max": 100, "palette": ["ffffff", "9ecae1", "2171b5"]}
    if "monthlyhistory" in lower_id:
        return {"bands": ["water"], "min": 0, "max": 2, "palette": ["000000", "9ecae1", "08306b"]}
    if "yearlyhistory" in lower_id:
        return {"bands": ["waterClass"], "min": 0, "max": 3, "palette": ["000000", "ffffcc", "41b6c4", "253494"]}
    if "opera_dswx" in lower_id:
        return {"bands": ["water"], "min": 0, "max": 9, "palette": ["000000", "9ecae1", "08306b", "fed976", "e31a1c", "7a0177"]}
    if "global_flood_db" in lower_id:
        return {"bands": ["flooded"], "min": 0, "max": 1, "palette": ["000000", "ff0000"]}

    if len(band_metadata) == 1:
        band = band_metadata[0]
        vis: Dict[str, Any] = {"bands": [band["name"]]}
        if band.get("min") is not None:
            vis["min"] = band["min"]
        if band.get("max") is not None:
            vis["max"] = band["max"]
        vis["palette"] = ["f7fbff", "6baed6", "08306b"]
        return vis

    return {"min": 0, "max": 1, "palette": ["f7fbff", "6baed6", "08306b"]}


def _constraints(asset_type: str, temporal_type: str, spatial_scope: str) -> List[str]:
    constraints: List[str] = []
    if asset_type == "ImageCollection":
        constraints.append("prefer time filter")
    if asset_type == "FeatureCollection":
        constraints.append("render as styled vector overlay")
    if temporal_type == "static":
        constraints.append("time filter optional")
    if spatial_scope == "regional":
        constraints.append("check region compatibility")
    return constraints


def _coerce_asset_record(item: Dict[str, Any]) -> AssetRecord:
    payload = dict(item)
    payload.setdefault("status", "active")
    payload.setdefault("band_metadata", [])
    payload.setdefault("official_example_code", "")
    payload.setdefault("official_example_vis", {})
    payload.setdefault("default_map_view", {})
    payload.setdefault("collection_processing_hints", {})
    return AssetRecord(**payload)


class WaterAssetCatalogBuilder:
    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.inventory_csv_path = self.cache_path.with_name("water_asset_inventory.csv")
        self.inventory_summary_path = self.cache_path.with_name("water_asset_inventory_summary.json")

    def load(self, force_refresh: bool = False) -> List[AssetRecord]:
        if not force_refresh and self.cache_path.exists():
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            assets_payload = payload.get("assets", [])
            needs_refresh = payload.get("schema_version", 0) < CACHE_SCHEMA_VERSION or any(
                "band_metadata" not in item or "official_example_vis" not in item for item in assets_payload
            )
            if not needs_refresh:
                assets = [_coerce_asset_record(item) for item in assets_payload]
                self._write_inventory_files(assets)
                return assets
        assets = self.refresh()
        payload = {
            "source": OFFICIAL_WATER_TAG_URL,
            "schema_version": CACHE_SCHEMA_VERSION,
            "refreshed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "asset_count": len(assets),
            "assets": [asdict(item) for item in assets],
        }
        self.cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        self._write_inventory_files(assets)
        return assets

    def refresh(self) -> List[AssetRecord]:
        html = _http_get(OFFICIAL_WATER_TAG_URL).text
        raw_slugs = re.findall(r"/earth-engine/datasets/catalog/([^\"#?]+)", html)
        seen: set[str] = set()
        assets: List[AssetRecord] = []
        for slug in raw_slugs:
            if slug in seen:
                continue
            seen.add(slug)
            asset = self._fetch_asset(slug)
            if asset:
                assets.append(asset)
            time.sleep(0.1)
        assets.sort(key=lambda item: (item.priority, item.title.lower()))
        return assets

    def _fetch_asset(self, slug: str) -> Optional[AssetRecord]:
        url = OFFICIAL_DATASET_URL_TEMPLATE.format(slug=slug)
        try:
            html = _http_get(url).text
        except requests.RequestException:
            return None

        match = re.search(r"ee\.(ImageCollection|Image|FeatureCollection)\([\"']([^\"']+)[\"']\)", html)
        if not match:
            return None

        asset_type, asset_id = match.group(1), match.group(2)
        title_match = re.search(r'<meta property="og:title" content="([^"]+)"', html)
        desc_match = re.search(r'<meta name="description" content="([^"]+)"', html)

        title = _strip_tags(title_match.group(1)) if title_match else slug
        title = title.replace(" | Google Earth Engine", "").strip()
        summary = _strip_tags(desc_match.group(1)) if desc_match else title
        band_metadata = _extract_band_metadata(html)
        example_code = _extract_code_editor_block(html)
        official_example_vis = _extract_visualization_recipe(example_code)
        default_map_view = _extract_map_view(example_code)
        collection_hints = _infer_collection_processing_hints(asset_type, example_code, summary)
        corpus = " ".join(
            [
                slug,
                title,
                asset_id,
                summary,
                " ".join(band.get("name", "") for band in band_metadata),
                " ".join(band.get("description", "") for band in band_metadata),
            ]
        )

        themes = _infer_themes(corpus)
        spatial_scope = _infer_spatial_scope(corpus)
        temporal_type = _infer_temporal_type(asset_type, corpus)
        collection_hints = _infer_collection_processing_hints(asset_type, example_code, temporal_type)
        query_keywords = _tokenize_keywords(
            slug,
            title,
            asset_id,
            summary,
            *[band.get("name", "") for band in band_metadata],
            *[band.get("description", "") for band in band_metadata],
        )
        default_vis = _default_vis_params(asset_id, asset_type, band_metadata, official_example_vis)
        constraints = _constraints(asset_type, temporal_type, spatial_scope)
        priority = 1 if "flood" in themes or "surface_water" in themes else 5

        return AssetRecord(
            slug=slug,
            title=title,
            asset_id=asset_id,
            asset_type=asset_type,
            summary=summary,
            official_url=url,
            themes=themes,
            spatial_scope=spatial_scope,
            temporal_type=temporal_type,
            query_keywords=query_keywords,
            default_vis_params=default_vis,
            constraints=constraints,
            priority=priority,
            band_metadata=band_metadata,
            official_example_code=example_code,
            official_example_vis=official_example_vis,
            default_map_view=default_map_view,
            collection_processing_hints=collection_hints,
        )

    def _write_inventory_files(self, assets: List[AssetRecord]) -> None:
        fieldnames = [
            "slug",
            "title",
            "asset_id",
            "asset_type",
            "themes",
            "spatial_scope",
            "temporal_type",
            "has_official_example_code",
            "has_official_recipe",
            "has_band_metadata",
            "band_count",
            "recipe_band_count",
            "official_url",
        ]
        with self.inventory_csv_path.open("w", encoding="utf-8-sig", newline="") as handle:
            writer = csv.DictWriter(handle, fieldnames=fieldnames)
            writer.writeheader()
            for asset in assets:
                writer.writerow(
                    {
                        "slug": asset.slug,
                        "title": asset.title,
                        "asset_id": asset.asset_id,
                        "asset_type": asset.asset_type,
                        "themes": ",".join(asset.themes),
                        "spatial_scope": asset.spatial_scope,
                        "temporal_type": asset.temporal_type,
                        "has_official_example_code": bool(asset.official_example_code),
                        "has_official_recipe": bool(asset.official_example_vis),
                        "has_band_metadata": bool(asset.band_metadata),
                        "band_count": len(asset.band_metadata),
                        "recipe_band_count": len(asset.official_example_vis.get("bands", [])),
                        "official_url": asset.official_url,
                    }
                )

        summary = {
            "source": OFFICIAL_WATER_TAG_URL,
            "generated_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "total_assets": len(assets),
            "assets_with_official_recipe": sum(1 for asset in assets if asset.official_example_vis),
            "assets_with_band_metadata": sum(1 for asset in assets if asset.band_metadata),
            "assets_with_official_example_code": sum(1 for asset in assets if asset.official_example_code),
            "by_asset_type": {
                asset_type: sum(1 for asset in assets if asset.asset_type == asset_type)
                for asset_type in sorted({asset.asset_type for asset in assets})
            },
        }
        self.inventory_summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
