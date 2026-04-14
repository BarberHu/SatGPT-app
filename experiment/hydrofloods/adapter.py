from __future__ import annotations

from datetime import date
from typing import Any, Dict, List, Optional

import ee
import hydrafloods as hf

from assets_library import get_asset_spec, get_recommendable_assets
from ee_utils import init_gee


def _ensure_gee() -> Dict[str, Any]:
    return init_gee()


def _build_region(bbox: List[float]) -> ee.Geometry:
    return ee.Geometry.Rectangle(bbox)


def _build_dataset(dataset_name: str, region: ee.Geometry, start_date: str, end_date: str):
    dataset_cls = getattr(hf, dataset_name)
    return dataset_cls(region, start_date, end_date)


def _native_layer_profile(layer_kind: str, region: ee.Geometry) -> Dict[str, Any]:
    profiles: Dict[str, Dict[str, Any]] = {
        "water_extent": {
            "title": "HYDRAFloods Water Extent",
            "vis_params": {
                "min": 0,
                "max": 1,
                "palette": ["#ffffff", "#1d4ed8"],
                "dimensions": 1024,
                "region": region,
            },
            "legend_spec": {
                "type": "categorical",
                "label": "Water extent",
                "items": [
                    {"value": 0, "label": "Not water", "color": "#ffffff"},
                    {"value": 1, "label": "Water", "color": "#1d4ed8"},
                ],
            },
        },
        "flood_extent": {
            "title": "HYDRAFloods Flood Extent",
            "vis_params": {
                "min": 0,
                "max": 1,
                "palette": ["#ffffff", "#ef4444"],
                "dimensions": 1024,
                "region": region,
            },
            "legend_spec": {
                "type": "categorical",
                "label": "Flood extent",
                "items": [
                    {"value": 0, "label": "No flood", "color": "#ffffff"},
                    {"value": 1, "label": "Flooded", "color": "#ef4444"},
                ],
            },
        },
        "flood_depth": {
            "title": "HYDRAFloods Flood Depth",
            "vis_params": {
                "min": 0,
                "max": 5,
                "palette": ["#ffffff", "#67e8f9", "#2563eb", "#172554"],
                "dimensions": 1024,
                "region": region,
            },
            "legend_spec": {
                "type": "continuous",
                "label": "Flood depth",
                "palette": ["#ffffff", "#67e8f9", "#2563eb", "#172554"],
                "min": 0,
                "max": 5,
            },
        },
    }
    return profiles[layer_kind]


def _default_index(dataset_name: str) -> str:
    if dataset_name == "Sentinel1":
        return "vv_vh_ratio"
    return "mndwi"


def _apply_water_workflow(
    dataset_name: str,
    dataset_obj,
    algorithm: str,
    region: ee.Geometry,
    index_name: Optional[str] = None,
):
    index_name = index_name or _default_index(dataset_name)

    if dataset_name in {"Sentinel2", "Landsat7", "Landsat8", "Modis", "Viirs"}:
        working_ds = dataset_obj.apply_func(getattr(hf, index_name))
        if algorithm == "edge_otsu":
            water_ds = working_ds.apply_func(
                hf.edge_otsu,
                initial_threshold=0,
                edge_buffer=300,
                scale=150,
                invert=True,
            )
        elif algorithm == "bmax_otsu":
            water_ds = working_ds.apply_func(
                hf.bmax_otsu,
                initial_threshold=0,
                scale=150,
                invert=True,
            )
        else:
            raise NotImplementedError(f"Unsupported water-mapping algorithm: {algorithm}")

        vis_params = _native_layer_profile("water_extent", region)["vis_params"]
        return working_ds, water_ds, vis_params, index_name

    working_ds = dataset_obj.apply_func(hf.vv_vh_ratio)
    # Sentinel-1 在某些区域会出现空 histogram，这里用工具层参数兜住算法输入。
    base_kwargs = {
        "band": "ratio",
        "initial_threshold": -16,
        "scale": 150,
        "invert": False,
        "thresh_no_data": -16,
    }
    if algorithm == "edge_otsu":
        water_ds = working_ds.apply_func(hf.edge_otsu, **base_kwargs)
    elif algorithm == "bmax_otsu":
        water_ds = working_ds.apply_func(hf.bmax_otsu, **base_kwargs)
    else:
        raise NotImplementedError(f"Unsupported water-mapping algorithm: {algorithm}")

    vis_params = _native_layer_profile("water_extent", region)["vis_params"]
    return working_ds, water_ds, vis_params, "vv_vh_ratio"


def _tile_artifact(
    image: ee.Image,
    vis_params: Dict[str, Any],
    name: str,
    region: Optional[ee.Geometry] = None,
    title: Optional[str] = None,
    legend_spec: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    clipped_image = image.clip(region) if region is not None else image
    serializable_vis = {k: v for k, v in vis_params.items() if k != "region"}
    artifact = {
        "name": name,
        "title": title or name,
        "tile_url": clipped_image.getMapId(vis_params)["tile_fetcher"].url_format,
        "thumbnail_url": clipped_image.getThumbURL(vis_params),
        "vis_params": serializable_vis,
    }
    if legend_spec:
        artifact["legend_spec"] = legend_spec
    return artifact


def _observation_image(water_ds, observation_date: str) -> ee.Image:
    return water_ds.collection.mode().set("system:time_start", ee.Date(observation_date).millis())


def _is_us_bbox(bbox: Optional[List[float]]) -> bool:
    if not bbox or len(bbox) != 4:
        return False
    west, south, east, north = bbox
    return -170 <= west <= -60 and -170 <= east <= -60 and 18 <= south <= 72 and 18 <= north <= 72


def _base_asset_reason(asset: Dict[str, Any]) -> str:
    return asset.get("summary", asset["title"])


def _parse_iso_date(value: Optional[str]) -> Optional[date]:
    if not value:
        return None
    return date.fromisoformat(value)


def _availability_penalty(asset: Dict[str, Any], start_date: Optional[str], end_date: Optional[str]) -> float:
    availability = asset.get("availability", {})
    request_start = _parse_iso_date(start_date)
    request_end = _parse_iso_date(end_date)
    available_start = _parse_iso_date(availability.get("start_date"))
    available_end = _parse_iso_date(availability.get("end_date"))

    if request_end and available_start and request_end < available_start:
        return 60.0
    if request_start and available_end and request_start > available_end:
        return 60.0
    return 0.0


def _recommend_assets_for_request(
    *,
    query: str,
    parsed_request: Dict[str, Any],
    limit: int = 3,
) -> List[Dict[str, Any]]:
    action = parsed_request.get("action")
    dataset = parsed_request.get("dataset")
    bbox = parsed_request.get("bbox")
    normalized_query = query.lower()
    recommendations: List[Dict[str, Any]] = []
    aoi_is_us = _is_us_bbox(bbox)
    dates = parsed_request.get("dates") or []
    start_date = dates[0] if dates else None
    end_date = dates[1] if len(dates) > 1 else start_date

    for asset in get_recommendable_assets():
        selection_profile = asset.get("selection_profile", {})
        execution_profile = asset.get("execution_profile", {})
        location_scope = selection_profile.get("location_scope", "global")

        if location_scope == "us_only" and not aoi_is_us:
            continue
        if not execution_profile.get("supports_tile", False):
            continue

        score = float(selection_profile.get("priority", 0))
        reasons: List[str] = [_base_asset_reason(asset)]
        group = asset["product_group"]
        asset_id = asset["asset_id"]
        score -= _availability_penalty(asset, start_date, end_date)

        if action in {"water_mapping", "flood_extent", "depth_estimation"}:
            if group == "flood_event_classification":
                score += 24
                reasons.append("event-scale dynamic water product")
            if group in {"surface_water_history", "surface_water_frequency"}:
                score += 14
                reasons.append("useful baseline water context")
            if group in {"basin_context", "river_context"}:
                score += 4
                reasons.append("hydrologic context layer")

        if dataset == "Sentinel1" and asset_id == "OPERA/DSWX/L3_V1/S1":
            score += 18
            reasons.append("matches Sentinel-1 flood workflow")
        if dataset in {"Sentinel2", "Landsat8", "Landsat7"} and asset_id == "OPERA/DSWX/L3_V1/HLS":
            score += 18
            reasons.append("matches optical flood workflow")
        if "history" in normalized_query or "archive" in normalized_query or "historical" in normalized_query:
            if group == "flood_event_archive":
                score += 20
                reasons.append("query asks for historical context")
        if "basin" in normalized_query or "watershed" in normalized_query or "river" in normalized_query:
            if group in {"basin_context", "river_context"}:
                score += 12
                reasons.append("query asks for hydrologic context")
        if action == "depth_estimation" and group in {"surface_water_history", "surface_water_frequency"}:
            score += 8
            reasons.append("helps interpret flood depth context")

        recommendations.append(
            {
                "asset_id": asset_id,
                "title": asset["title"],
                "product_group": group,
                "score": round(score, 2),
                "reason": "; ".join(dict.fromkeys(reasons)),
                "default_selected": selection_profile.get("default_selected", False),
            }
        )

    recommendations.sort(key=lambda item: item["score"], reverse=True)
    return recommendations[:limit]


def _reduce_collection(collection: ee.ImageCollection, reducer_name: str) -> ee.Image:
    if reducer_name == "first":
        return ee.Image(collection.first())
    reducer = getattr(collection, reducer_name)
    return ee.Image(reducer())


def _collection_from_asset(
    asset_spec: Dict[str, Any],
    region: Optional[ee.Geometry],
    start_date: Optional[str],
    end_date: Optional[str],
):
    execution_profile = asset_spec.get("execution_profile", {})
    asset_id = asset_spec["asset_id"]
    mode = asset_spec.get("render_profile", {}).get("mode")

    if mode == "styled_vector":
        feature_collection = ee.FeatureCollection(asset_id)
        if execution_profile.get("requires_aoi") and region is not None:
            feature_collection = feature_collection.filterBounds(region)
        return feature_collection

    image_collection = ee.ImageCollection(asset_id)
    if execution_profile.get("requires_aoi") and region is not None:
        image_collection = image_collection.filterBounds(region)
    time_filter_mode = execution_profile.get("time_filter_mode", "date_range")
    if execution_profile.get("requires_date_range") and start_date and end_date and time_filter_mode == "date_range":
        image_collection = image_collection.filterDate(start_date, end_date)
    elif execution_profile.get("requires_date_range") and start_date and time_filter_mode == "calendar_month":
        month = ee.Date(start_date).get("month")
        image_collection = image_collection.filter(ee.Filter.calendarRange(month, month, "month"))
    elif execution_profile.get("requires_date_range") and start_date and time_filter_mode == "calendar_year":
        year = ee.Date(start_date).get("year")
        image_collection = image_collection.filter(ee.Filter.calendarRange(year, year, "year"))
    select_bands = execution_profile.get("select_bands") or []
    if select_bands:
        image_collection = image_collection.select(select_bands)
    return image_collection


def render_asset_layer(
    asset_id: str,
    *,
    bbox: Optional[List[float]] = None,
    start_date: Optional[str] = None,
    end_date: Optional[str] = None,
) -> Dict[str, Any]:
    _ensure_gee()
    asset_spec = get_asset_spec(asset_id)
    region = _build_region(bbox) if bbox else None
    render_profile = asset_spec.get("render_profile", {})
    execution_profile = asset_spec.get("execution_profile", {})
    mode = render_profile.get("mode")

    collection_or_fc = _collection_from_asset(asset_spec, region, start_date, end_date)

    if mode == "styled_vector":
        style = render_profile.get("style", {})
        image = ee.FeatureCollection(collection_or_fc).style(**style)
        vis_params: Dict[str, Any] = {"dimensions": 1024}
        if region is not None:
            vis_params["region"] = region
    elif mode == "image_collection_reducer":
        reducer_name = execution_profile.get("reducer", "first")
        image = _reduce_collection(ee.ImageCollection(collection_or_fc), reducer_name)
        vis_params = {
            "dimensions": 1024,
            "min": render_profile.get("min", 0),
            "max": render_profile.get("max", 1),
        }
        palette = render_profile.get("palette")
        if palette:
            vis_params["palette"] = palette
        if region is not None:
            vis_params["region"] = region
    else:
        raise NotImplementedError(f"Unsupported asset render mode: {mode}")

    artifact = _tile_artifact(image, vis_params, asset_spec["title"], region)
    artifact["asset_id"] = asset_spec["asset_id"]
    artifact["legend_spec"] = asset_spec.get("legend_spec")
    artifact["product_group"] = asset_spec.get("product_group")
    return artifact


def recommend_asset_layers(
    *,
    query: str,
    parsed_request: Dict[str, Any],
    limit: int = 3,
) -> Dict[str, Any]:
    recommendations = _recommend_assets_for_request(query=query, parsed_request=parsed_request, limit=limit)
    layers: List[Dict[str, Any]] = []

    for index, item in enumerate(recommendations):
        try:
            layer = render_asset_layer(
                item["asset_id"],
                bbox=parsed_request.get("bbox"),
                start_date=(parsed_request.get("dates") or [None, None])[0],
                end_date=(parsed_request.get("dates") or [None, None])[-1],
            )
        except Exception:
            continue
        layer["visible"] = len(layers) == 0
        layer["recommendation"] = item
        layers.append(layer)

    return {
        "status": "ok",
        "tool_name": "recommend_flood_asset_layers",
        "summary": "完成数据产品推荐并生成资产图层。",
        "inputs": {
            "query": query,
            "bbox": parsed_request.get("bbox"),
            "dates": parsed_request.get("dates", []),
            "action": parsed_request.get("action"),
            "dataset": parsed_request.get("dataset"),
        },
        "recommendations": recommendations,
        "artifacts": {
            "primary_layer": layers[0] if layers else None,
            "layers": layers,
        },
        "metadata": {
            "recommended_asset_count": len(layers),
        },
    }


def _repro_code(
    dataset_name: str,
    bbox: List[float],
    start_date: str,
    end_date: str,
    algorithm: str,
    action: str,
    reference: str = "seasonal",
) -> str:
    transform_line = (
        "working = dataset.apply_func(hf.vv_vh_ratio)"
        if dataset_name == "Sentinel1"
        else "working = dataset.apply_func(hf.mndwi)"
    )
    threshold_line = (
        f"water = working.apply_func(hf.{algorithm}, band='ratio', initial_threshold=-16, scale=150, invert=False, thresh_no_data=-16)"
        if dataset_name == "Sentinel1"
        else f"water = working.apply_func(hf.{algorithm}, initial_threshold=0, edge_buffer=300, scale=150, invert=True)"
    )

    lines = [
        "import ee",
        "import hydrafloods as hf",
        "from ee_utils import init_gee",
        "",
        "init_gee()",
        f"region = ee.Geometry.Rectangle({bbox})",
        f"dataset = hf.{dataset_name}(region, '{start_date}', '{end_date}')",
        transform_line,
        threshold_line,
        f"water_img = water.collection.mode().set('system:time_start', ee.Date('{end_date}').millis())",
        "water_img = water_img.clip(region)",
    ]

    if action in {"flood_extent", "depth_estimation"}:
        lines.append(f"flood = hf.extract_flood(water_img, reference='{reference}', permanent_threshold=75)")
        lines.append("flood = flood.clip(region)")
    if action == "depth_estimation":
        lines.extend(
            [
                'dem = ee.Image("USGS/SRTMGL1_003")',
                "depth = hf.fwdet(flood, dem)",
                "print(depth.getMapId({'min': 0, 'max': 5, 'palette': 'white,cyan,blue,navy'})['tile_fetcher'].url_format)",
            ]
        )
    elif action == "flood_extent":
        lines.append("print(flood.getMapId({'min': 0, 'max': 1, 'palette': 'white,red'})['tile_fetcher'].url_format)")
    else:
        lines.append("print(water_img.getMapId({'min': 0, 'max': 1, 'palette': 'white,blue'})['tile_fetcher'].url_format)")
    return "\n".join(lines)


def get_water_extent_tile(
    dataset: str,
    start_date: str,
    end_date: str,
    bbox: List[float],
    algorithm: str = "edge_otsu",
) -> Dict[str, Any]:
    init_result = _ensure_gee()
    region = _build_region(bbox)
    dataset_obj = _build_dataset(dataset, region, start_date, end_date)
    working_ds, water_ds, vis_params, index_name = _apply_water_workflow(
        dataset, dataset_obj, algorithm, region
    )
    layer_profile = _native_layer_profile("water_extent", region)
    water_img = _observation_image(water_ds, end_date)
    image_count = dataset_obj.collection.size().getInfo()

    return {
        "status": "ok",
        "tool_name": "get_water_extent_tile",
        "summary": "完成水体提取并生成在线地图图层。",
        "inputs": {
            "dataset": dataset,
            "start_date": start_date,
            "end_date": end_date,
            "bbox": bbox,
            "algorithm": algorithm,
        },
        "artifacts": {
            "primary_layer": _tile_artifact(
                water_img,
                vis_params,
                "water_extent",
                region,
                title=layer_profile["title"],
                legend_spec=layer_profile["legend_spec"],
            ),
        },
        "metadata": {
            "gee_project_id": init_result["project_id"],
            "index_name": index_name,
            "image_count": image_count,
            "working_collection_size": working_ds.collection.size().getInfo(),
        },
        "repro_code": _repro_code(dataset, bbox, start_date, end_date, algorithm, "water_mapping"),
    }


def get_flood_extent_tile(
    dataset: str,
    start_date: str,
    end_date: str,
    bbox: List[float],
    algorithm: str = "edge_otsu",
    reference: str = "seasonal",
) -> Dict[str, Any]:
    base = get_water_extent_tile(dataset, start_date, end_date, bbox, algorithm)
    region = _build_region(bbox)
    dataset_obj = _build_dataset(dataset, region, start_date, end_date)
    _, water_ds, _, _ = _apply_water_workflow(dataset, dataset_obj, algorithm, region)
    water_img = _observation_image(water_ds, end_date)
    flood_img = hf.extract_flood(water_img, reference=reference, permanent_threshold=75)
    layer_profile = _native_layer_profile("flood_extent", region)
    flood_vis = layer_profile["vis_params"]

    base.update(
        {
            "tool_name": "get_flood_extent_tile",
            "summary": "完成洪水范围提取并生成在线地图图层。",
            "inputs": {
                **base["inputs"],
                "reference": reference,
            },
            "artifacts": {
                **base["artifacts"],
                "primary_layer": _tile_artifact(
                    flood_img,
                    flood_vis,
                    "flood_extent",
                    region,
                    title=layer_profile["title"],
                    legend_spec=layer_profile["legend_spec"],
                ),
            },
            "metadata": {
                **base["metadata"],
                "reference": reference,
            },
            "repro_code": _repro_code(
                dataset, bbox, start_date, end_date, algorithm, "flood_extent", reference=reference
            ),
        }
    )
    return base


def estimate_flood_depth_tile(
    dataset: str,
    start_date: str,
    end_date: str,
    bbox: List[float],
    algorithm: str = "edge_otsu",
    reference: str = "seasonal",
    dem_asset: str = "USGS/SRTMGL1_003",
) -> Dict[str, Any]:
    base = get_flood_extent_tile(dataset, start_date, end_date, bbox, algorithm, reference)
    region = _build_region(bbox)
    dataset_obj = _build_dataset(dataset, region, start_date, end_date)
    _, water_ds, _, _ = _apply_water_workflow(dataset, dataset_obj, algorithm, region)
    water_img = _observation_image(water_ds, end_date)
    flood_img = hf.extract_flood(water_img, reference=reference, permanent_threshold=75)
    dem = ee.Image(dem_asset)
    depth_img = hf.fwdet(flood_img, dem)
    layer_profile = _native_layer_profile("flood_depth", region)
    depth_vis = layer_profile["vis_params"]

    base.update(
        {
            "tool_name": "estimate_flood_depth_tile",
            "summary": "完成 FwDET 水深估算并生成在线地图图层。",
            "inputs": {
                **base["inputs"],
                "dem_asset": dem_asset,
            },
            "artifacts": {
                **base["artifacts"],
                "primary_layer": _tile_artifact(
                    depth_img,
                    depth_vis,
                    "flood_depth",
                    region,
                    title=layer_profile["title"],
                    legend_spec=layer_profile["legend_spec"],
                ),
            },
            "metadata": {
                **base["metadata"],
                "dem_asset": dem_asset,
            },
            "repro_code": _repro_code(
                dataset, bbox, start_date, end_date, algorithm, "depth_estimation", reference=reference
            ),
        }
    )
    return base
