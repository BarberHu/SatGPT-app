from __future__ import annotations

import csv
import json
import re
import time
from copy import deepcopy
from dataclasses import asdict, dataclass, field
from datetime import datetime
from html import unescape
from pathlib import Path
from typing import Any, Dict, List, Optional

import requests

OFFICIAL_WATER_TAG_URL = "https://developers.google.com/earth-engine/datasets/tags/water?hl=zh-cn"
OFFICIAL_DATASET_URL_TEMPLATE = "https://developers.google.com/earth-engine/datasets/catalog/{slug}?hl=zh-cn"
USER_AGENT = "SatGPT-Water-Asset-Agent/0.1"
CACHE_SCHEMA_VERSION = 3


LEGEND_SPEC_OVERRIDES: Dict[str, Dict[str, Any]] = {
    "JRC/GSW1_2/MonthlyHistory": {
        "type": "categorical",
        "label": "Monthly water class",
        "items": [
            {"value": 0, "label": "No data", "color": "#ffffff"},
            {"value": 1, "label": "Land", "color": "#fffcb8"},
            {"value": 2, "label": "Water", "color": "#0905ff"},
        ],
    },
    "JRC/GSW1_2/YearlyHistory": {
        "type": "categorical",
        "label": "Yearly water class",
        "items": [
            {"value": 0, "label": "No data", "color": "#cccccc"},
            {"value": 1, "label": "Land", "color": "#ffffff"},
            {"value": 2, "label": "Seasonal water", "color": "#99d9ea"},
            {"value": 3, "label": "Permanent water", "color": "#0000ff"},
        ],
    },
    "JRC/GSW1_4/MonthlyHistory": {
        "type": "categorical",
        "label": "Monthly water class",
        "items": [
            {"value": 0, "label": "No data", "color": "#ffffff"},
            {"value": 1, "label": "Land", "color": "#fffcb8"},
            {"value": 2, "label": "Water", "color": "#0905ff"},
        ],
    },
    "JRC/GSW1_4/YearlyHistory": {
        "type": "categorical",
        "label": "Yearly water class",
        "items": [
            {"value": 0, "label": "No data", "color": "#cccccc"},
            {"value": 1, "label": "Land", "color": "#ffffff"},
            {"value": 2, "label": "Seasonal water", "color": "#99d9ea"},
            {"value": 3, "label": "Permanent water", "color": "#0000ff"},
        ],
    },
}

CATEGORICAL_HINT_TOKENS = (
    "class",
    "classification",
    "history",
    "extent",
    "mask",
    "transition",
    "seasonal",
    "monthlyhistory",
    "yearlyhistory",
    "waterclass",
)


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
    legend_spec: Dict[str, Any] = field(default_factory=dict)
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


def _normalize_color(raw: Any, fallback: str = "#0ea5e9") -> str:
    if not isinstance(raw, str):
        return fallback
    value = raw.strip()
    if not value:
        return fallback
    if value.startswith("#") or re.fullmatch(r"[a-zA-Z]+", value):
        return value
    if re.fullmatch(r"[0-9a-fA-F]{3,8}", value):
        return f"#{value}"
    return value


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


def _legend_label(asset: AssetRecord) -> str:
    vis = asset.official_example_vis or asset.default_vis_params or {}
    if vis.get("bands"):
        return ", ".join(str(item) for item in vis["bands"])
    primary_band = next(
        (
            band.get("name")
            for band in asset.band_metadata
            if isinstance(band, dict) and band.get("name")
        ),
        None,
    )
    if primary_band and len(asset.band_metadata) == 1:
        return primary_band
    return asset.title


def _categorical_text(asset: AssetRecord, vis: Dict[str, Any]) -> str:
    return " ".join(
        [
            asset.asset_id.lower(),
            asset.title.lower(),
            asset.summary.lower(),
            " ".join(str(item).lower() for item in vis.get("bands", [])),
            " ".join(
                f"{band.get('name', '')} {band.get('description', '')}".lower()
                for band in asset.band_metadata
                if isinstance(band, dict)
            ),
        ]
    )


def _should_use_categorical(asset: AssetRecord, vis: Dict[str, Any], palette: List[str]) -> bool:
    min_value = vis.get("min")
    max_value = vis.get("max")
    if min_value is None or max_value is None:
        return False
    if not isinstance(min_value, (int, float)) or not isinstance(max_value, (int, float)):
        return False
    if not float(min_value).is_integer() or not float(max_value).is_integer():
        return False

    span = int(max_value - min_value)
    if span < 0 or span > 12 or len(palette) != span + 1:
        return False

    text = _categorical_text(asset, vis)
    if any(token in text for token in CATEGORICAL_HINT_TOKENS):
        return True

    return asset.asset_id in LEGEND_SPEC_OVERRIDES


def _generic_category_label(value: int) -> str:
    return f"Class {value}"


def _build_categorical_legend(asset: AssetRecord, vis: Dict[str, Any], palette: List[str]) -> Optional[Dict[str, Any]]:
    override = LEGEND_SPEC_OVERRIDES.get(asset.asset_id)
    if override:
        payload = deepcopy(override)
        payload["items"] = [
            {**item, "color": _normalize_color(item.get("color"))}
            for item in payload.get("items", [])
        ]
        return payload

    min_value = vis.get("min")
    max_value = vis.get("max")
    if min_value is None or max_value is None:
        return None

    start = int(min_value)
    end = int(max_value)
    items = []
    for offset, value in enumerate(range(start, end + 1)):
        items.append(
            {
                "value": value,
                "label": _generic_category_label(value),
                "color": _normalize_color(palette[offset]),
            }
        )
    return {
        "type": "categorical",
        "label": _legend_label(asset),
        "items": items,
    }


def _build_continuous_legend(asset: AssetRecord, vis: Dict[str, Any], palette: List[str]) -> Dict[str, Any]:
    return {
        "type": "continuous",
        "label": _legend_label(asset),
        "palette": [_normalize_color(color) for color in palette],
        "min": vis.get("min"),
        "max": vis.get("max"),
        "bands": [str(item) for item in vis.get("bands", [])],
    }


def _build_vector_legend(asset: AssetRecord, style: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "type": "vector",
        "label": asset.title,
        "style": {
            "color": _normalize_color(style.get("color"), "#00bcd4"),
            "fillColor": _normalize_color(style.get("fillColor"), "#00000000"),
            "width": style.get("width", 2),
        },
    }


def _build_text_legend(asset: AssetRecord, reason: str) -> Dict[str, Any]:
    return {
        "type": "text",
        "label": _legend_label(asset),
        "reason": reason,
    }


def _infer_legend_spec(asset: AssetRecord) -> Dict[str, Any]:
    vis = asset.official_example_vis or asset.default_vis_params or {}

    if asset.asset_type == "FeatureCollection":
        style = vis.get("style") or asset.default_vis_params.get("style") or {}
        return _build_vector_legend(asset, style)

    style = vis.get("style")
    if isinstance(style, dict) and style:
        return _build_vector_legend(asset, style)

    palette = [str(item) for item in (vis.get("palette") or []) if item]
    if palette and _should_use_categorical(asset, vis, palette):
        categorical = _build_categorical_legend(asset, vis, palette)
        if categorical:
            return categorical

    if palette:
        return _build_continuous_legend(asset, vis, palette)

    return _build_text_legend(asset, "missing_palette_or_vector_style")


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
    payload.setdefault("legend_spec", {})
    payload.setdefault("default_map_view", {})
    payload.setdefault("collection_processing_hints", {})
    record = AssetRecord(**payload)
    if not record.default_vis_params:
        record.default_vis_params = _default_vis_params(
            record.asset_id,
            record.asset_type,
            record.band_metadata,
            record.official_example_vis,
        )
    if not record.legend_spec:
        record.legend_spec = _infer_legend_spec(record)
    return record


class WaterAssetCatalogBuilder:
    def __init__(self, cache_path: Path):
        self.cache_path = cache_path
        self.cache_path.parent.mkdir(parents=True, exist_ok=True)
        self.inventory_csv_path = self.cache_path.with_name("water_asset_inventory.csv")
        self.inventory_summary_path = self.cache_path.with_name("water_asset_inventory_summary.json")
        self.legend_summary_path = self.cache_path.with_name("water_asset_legend_summary.json")

    def _write_cache_payload(self, assets: List[AssetRecord], source: Optional[str] = None) -> None:
        payload = {
            "source": source or OFFICIAL_WATER_TAG_URL,
            "schema_version": CACHE_SCHEMA_VERSION,
            "refreshed_at": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "asset_count": len(assets),
            "assets": [asdict(item) for item in assets],
        }
        self.cache_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    def load(self, force_refresh: bool = False) -> List[AssetRecord]:
        if not force_refresh and self.cache_path.exists():
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            assets_payload = payload.get("assets", [])
            assets = [_coerce_asset_record(item) for item in assets_payload]
            needs_rewrite = payload.get("schema_version", 0) < CACHE_SCHEMA_VERSION or any(
                "legend_spec" not in item for item in assets_payload
            )
            if needs_rewrite:
                self._write_cache_payload(assets, source=payload.get("source"))
            self._write_inventory_files(assets)
            return assets
        assets = self.refresh()
        self._write_cache_payload(assets)
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
            legend_spec=_infer_legend_spec(
                AssetRecord(
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
                )
            ),
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
            "by_legend_type": {
                legend_type: sum(1 for asset in assets if asset.legend_spec.get("type") == legend_type)
                for legend_type in sorted({asset.legend_spec.get("type", "unknown") for asset in assets})
            },
            "text_fallback_assets": [
                {
                    "asset_id": asset.asset_id,
                    "title": asset.title,
                    "official_url": asset.official_url,
                    "reason": asset.legend_spec.get("reason"),
                }
                for asset in assets
                if asset.legend_spec.get("type") == "text"
            ],
        }
        self.inventory_summary_path.write_text(
            json.dumps(summary, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        self.legend_summary_path.write_text(
            json.dumps(
                {
                    "generated_at": summary["generated_at"],
                    "total_assets": len(assets),
                    "by_legend_type": summary["by_legend_type"],
                    "text_fallback_assets": summary["text_fallback_assets"],
                },
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
