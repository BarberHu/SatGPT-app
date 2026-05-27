"""
HYDRAFloods integration helpers for the SatGPT flood agent.

The public hydrafloods package is an Earth Engine based SDK. This module keeps
imports lazy so the agent can still start in environments where the optional
package has not been installed yet.
"""
from __future__ import annotations

import importlib
import os
from datetime import datetime
from typing import Any, Callable, Dict, Optional

import ee

from flood_api_services import aoi_to_ee_geometry, parse_aoi_from_payload
from gee_service import gee_service


HYDRAFLOODS_DOCS_URL = "https://servir-mekong.github.io/hydra-floods/"


def _ensure_gee_ready() -> None:
    if not gee_service.initialized:
        raise RuntimeError(
            "Google Earth Engine is not initialized. Configure Earth Engine "
            "credentials before using HYDRAFloods tools."
        )


def _load_hydrafloods():
    try:
        return importlib.import_module("hydrafloods")
    except ImportError as exc:
        raise RuntimeError(
            "The hydrafloods package is not installed. Install agent requirements "
            "or run `pip install hydrafloods` in the backend environment."
        ) from exc


def _get_hf_attr(hf: Any, module_name: str, attr_name: str) -> Any:
    module = getattr(hf, module_name, None)
    if module and hasattr(module, attr_name):
        return getattr(module, attr_name)
    if hasattr(hf, attr_name):
        return getattr(hf, attr_name)
    raise RuntimeError(f"hydrafloods does not expose {module_name}.{attr_name}.")


def _normalize_reference(reference: str) -> str:
    value = str(reference or "seasonal").strip().lower()
    if value not in {"seasonal", "occurrence", "yearly"}:
        raise ValueError("reference must be one of: seasonal, occurrence, yearly.")
    return value


def _normalize_algorithm(algorithm: str) -> str:
    value = str(algorithm or "edge_otsu").strip().lower().replace("-", "_")
    aliases = {
        "edgeotsu": "edge_otsu",
        "edge_otsu": "edge_otsu",
        "bmaxotsu": "bmax_otsu",
        "bmax_otsu": "bmax_otsu",
        "kmeans": "kmeans_extent",
        "kmeans_extent": "kmeans_extent",
    }
    if value not in aliases:
        raise ValueError("algorithm must be one of: edge_otsu, bmax_otsu, kmeans_extent.")
    return aliases[value]


def _normalize_segmentation(segmentation: Optional[str]) -> Optional[str]:
    if segmentation is None:
        return None
    value = str(segmentation).strip().lower().replace("-", "")
    aliases = {
        "none": None,
        "edgeotsu": "edgeotsu",
        "edge_otsu": "edgeotsu",
        "bmaxotsu": "bmaxotsu",
        "bmax_otsu": "bmaxotsu",
    }
    if value not in aliases:
        raise ValueError("segmentation must be one of: edgeotsu, bmaxotsu, none.")
    return aliases[value]


def _validate_date(value: str, field_name: str) -> str:
    text = str(value or "").strip()
    try:
        datetime.strptime(text, "%Y-%m-%d")
    except ValueError as exc:
        raise ValueError(f"{field_name} must use YYYY-MM-DD format.") from exc
    return text


def _resolve_region(aoi: Optional[Dict[str, Any]], bounds: Optional[Dict[str, float]]) -> ee.Geometry:
    payload: Dict[str, Any] = {}
    if aoi:
        payload["aoi"] = aoi
    elif bounds:
        payload["aoi"] = {"version": 1, "source": "bounds", "kind": "rectangle", "bounds": bounds}
    else:
        raise ValueError("Provide either aoi or bounds.")

    return aoi_to_ee_geometry(parse_aoi_from_payload(payload))


def _dataset_class(hf: Any, dataset: str) -> Callable[..., Any]:
    key = str(dataset or "sentinel1").strip().lower().replace("-", "").replace("_", "")
    class_names = {
        "sentinel1": "Sentinel1",
        "s1": "Sentinel1",
        "sentinel2": "Sentinel2",
        "s2": "Sentinel2",
        "landsat8": "Landsat8",
        "lc8": "Landsat8",
        "landsat7": "Landsat7",
    }
    class_name = class_names.get(key)
    if not class_name:
        raise ValueError("dataset must be one of: sentinel1, sentinel2, landsat8, landsat7.")
    return _get_hf_attr(hf, "datasets", class_name)


def _dataset_water_band(dataset: str, requested_band: Optional[str]) -> str:
    if requested_band:
        return str(requested_band)
    key = str(dataset or "sentinel1").lower()
    if "sentinel1" in key or key == "s1":
        return "VV"
    return "mndwi"


def _image_dates(collection: ee.ImageCollection, limit: int = 12) -> list[str]:
    try:
        dates = (
            collection.aggregate_array("system:time_start")
            .map(lambda ts: ee.Date(ts).format("YYYY-MM-dd"))
            .slice(0, limit)
            .getInfo()
        )
        return [str(date) for date in dates]
    except Exception:
        return []


def _add_map_payload(image: ee.Image, vis_params: Dict[str, Any]) -> Dict[str, Any]:
    map_id = image.getMapId(vis_params)
    return {
        "map_id": map_id.get("mapid"),
        "token": map_id.get("token"),
        "tile_url": map_id["tile_fetcher"].url_format,
    }


def _build_water_collection_and_image(
    *,
    hf: Any,
    region: ee.Geometry,
    start_date: str,
    end_date: str,
    dataset: str,
    algorithm: str,
    band: Optional[str],
    initial_threshold: Optional[float],
    edge_buffer: int,
) -> tuple[Any, ee.Image, str]:
    dataset_cls = _dataset_class(hf, dataset)
    water_func = _get_hf_attr(hf, "thresholding", algorithm)
    water_band = _dataset_water_band(dataset, band)

    ds = dataset_cls(region, start_date, end_date)
    if water_band == "mndwi":
        add_indices = _get_hf_attr(hf, "indices", "add_indices")
        ds = ds.apply_func(add_indices, indices=["mndwi"])

    kwargs: Dict[str, Any] = {"band": water_band, "region": region, "edge_buffer": edge_buffer}
    if initial_threshold is not None:
        kwargs["initial_threshold"] = initial_threshold
    elif water_band == "VV":
        kwargs["initial_threshold"] = -14
    else:
        kwargs["initial_threshold"] = 0
        kwargs["invert"] = True

    water_ds = ds.apply_func(water_func, **kwargs)
    water_image = (
        ee.Image(water_ds.collection.mode())
        .clip(region)
        .rename("water")
        .set("system:time_start", ee.Date(end_date).millis())
    )
    return ds, water_image, water_band


def list_hydrafloods_capabilities() -> Dict[str, Any]:
    return {
        "package": "hydrafloods",
        "docs": HYDRAFLOODS_DOCS_URL,
        "available_agent_tools": [
            "hydrafloods_surface_water_map",
            "hydrafloods_flood_extent_map",
            "hydrafloods_sar_change_detection",
            "hydrafloods_generate_example_code",
        ],
        "datasets": ["sentinel1", "sentinel2", "landsat8", "landsat7"],
        "water_mapping_algorithms": ["edge_otsu", "bmax_otsu", "kmeans_extent"],
        "flood_reference_methods": ["seasonal", "occurrence", "yearly"],
        "notes": [
            "HYDRAFloods runs on Google Earth Engine.",
            "Large AOIs and long date ranges can hit Earth Engine memory or timeout limits.",
        ],
    }


def create_surface_water_map(
    *,
    aoi: Optional[Dict[str, Any]] = None,
    bounds: Optional[Dict[str, float]] = None,
    start_date: str,
    end_date: str,
    dataset: str = "sentinel1",
    algorithm: str = "edge_otsu",
    band: Optional[str] = None,
    initial_threshold: Optional[float] = None,
    edge_buffer: int = 300,
) -> Dict[str, Any]:
    _ensure_gee_ready()
    hf = _load_hydrafloods()
    start_date = _validate_date(start_date, "start_date")
    end_date = _validate_date(end_date, "end_date")
    algorithm = _normalize_algorithm(algorithm)
    region = _resolve_region(aoi, bounds)
    ds, water_image, water_band = _build_water_collection_and_image(
        hf=hf,
        region=region,
        start_date=start_date,
        end_date=end_date,
        dataset=dataset,
        algorithm=algorithm,
        band=band,
        initial_threshold=initial_threshold,
        edge_buffer=edge_buffer,
    )
    map_payload = _add_map_payload(
        water_image.selfMask(),
        {"min": 0, "max": 1, "palette": ["d8dee9", "0057b8"]},
    )

    return {
        "success": True,
        "type": "hydrafloods_surface_water_map",
        "dataset": dataset,
        "algorithm": algorithm,
        "band": water_band,
        "start_date": start_date,
        "end_date": end_date,
        "image_count": ds.collection.size().getInfo(),
        "dates": _image_dates(ds.collection),
        **map_payload,
    }


def create_flood_extent_map(
    *,
    aoi: Optional[Dict[str, Any]] = None,
    bounds: Optional[Dict[str, float]] = None,
    start_date: str,
    end_date: str,
    dataset: str = "sentinel1",
    algorithm: str = "edge_otsu",
    reference: str = "seasonal",
    permanent_threshold: int = 75,
    band: Optional[str] = None,
    initial_threshold: Optional[float] = None,
) -> Dict[str, Any]:
    _ensure_gee_ready()
    hf = _load_hydrafloods()
    start_date = _validate_date(start_date, "start_date")
    end_date = _validate_date(end_date, "end_date")
    algorithm = _normalize_algorithm(algorithm)
    reference = _normalize_reference(reference)
    region = _resolve_region(aoi, bounds)
    ds, water_image, _water_band = _build_water_collection_and_image(
        hf=hf,
        region=region,
        start_date=start_date,
        end_date=end_date,
        dataset=dataset,
        algorithm=algorithm,
        band=band,
        initial_threshold=initial_threshold,
        edge_buffer=300,
    )

    extract_flood = _get_hf_attr(hf, "floods", "extract_flood")
    flood_image = extract_flood(
        water_image,
        reference=reference,
        permanent_threshold=int(permanent_threshold),
    ).selfMask().clip(region)
    map_payload = _add_map_payload(
        flood_image,
        {"min": 0, "max": 1, "palette": ["ff3b30"]},
    )

    return {
        "success": True,
        "type": "hydrafloods_flood_extent_map",
        "dataset": dataset,
        "algorithm": algorithm,
        "reference": reference,
        "permanent_threshold": permanent_threshold,
        "start_date": start_date,
        "end_date": end_date,
        "image_count": ds.collection.size().getInfo(),
        "dates": _image_dates(ds.collection),
        **map_payload,
    }


def create_sar_change_detection_map(
    *,
    aoi: Optional[Dict[str, Any]] = None,
    bounds: Optional[Dict[str, float]] = None,
    pre_start_date: str,
    pre_end_date: str,
    post_start_date: str,
    post_end_date: str,
    band: str = "VV",
    segmentation: Optional[str] = "edgeotsu",
) -> Dict[str, Any]:
    _ensure_gee_ready()
    hf = _load_hydrafloods()
    pre_start_date = _validate_date(pre_start_date, "pre_start_date")
    pre_end_date = _validate_date(pre_end_date, "pre_end_date")
    post_start_date = _validate_date(post_start_date, "post_start_date")
    post_end_date = _validate_date(post_end_date, "post_end_date")
    segmentation = _normalize_segmentation(segmentation)
    region = _resolve_region(aoi, bounds)
    sentinel1_cls = _dataset_class(hf, "sentinel1")

    pre_ds = sentinel1_cls(region, pre_start_date, pre_end_date)
    post_ds = sentinel1_cls(region, post_start_date, post_end_date)
    reference = pre_ds.collection.select(band).median().clip(region)
    observation = post_ds.collection.select(band).median().clip(region)
    lar_change_detection = _get_hf_attr(hf, "floods", "lar_change_detection")
    change_image = lar_change_detection(
        observation,
        reference,
        band=band,
        in_units="dB",
        segmentation=segmentation,
        initial_threshold=-0.1,
        region=region,
        edge_buffer=300,
    ).selfMask().clip(region)
    map_payload = _add_map_payload(
        change_image,
        {"min": 0, "max": 1, "palette": ["f6c85f", "d7263d"]},
    )

    return {
        "success": True,
        "type": "hydrafloods_sar_change_detection",
        "band": band,
        "segmentation": segmentation or "none",
        "pre_date_range": [pre_start_date, pre_end_date],
        "post_date_range": [post_start_date, post_end_date],
        "pre_image_count": pre_ds.collection.size().getInfo(),
        "post_image_count": post_ds.collection.size().getInfo(),
        "pre_dates": _image_dates(pre_ds.collection),
        "post_dates": _image_dates(post_ds.collection),
        **map_payload,
    }


def generate_example_code(
    *,
    task: str = "flood_extent",
    start_date: str = "2019-10-05",
    end_date: str = "2019-10-06",
    bounds: Optional[Dict[str, float]] = None,
) -> Dict[str, Any]:
    effective_bounds = bounds or {"west": 104, "south": 11.5, "east": 106, "north": 12.5}
    region_expr = (
        f"ee.Geometry.Rectangle([{effective_bounds['west']}, {effective_bounds['south']}, "
        f"{effective_bounds['east']}, {effective_bounds['north']}])"
    )
    code = f"""import ee
import hydrafloods as hf

ee.Initialize(project="{os.getenv("GEE_PROJECT_ID", "flood-agent")}")

region = {region_expr}
start_time = "{start_date}"
end_time = "{end_date}"

s1 = hf.datasets.Sentinel1(region, start_time, end_time)
water_imgs = s1.apply_func(
    hf.thresholding.edge_otsu,
    band="VV",
    region=region,
    initial_threshold=-14,
    edge_buffer=300,
)
water_map = (
    ee.Image(water_imgs.collection.mode())
    .clip(region)
    .rename("water")
    .set("system:time_start", ee.Date(end_time).millis())
)
flood_map = hf.floods.extract_flood(
    water_map,
    reference="seasonal",
    permanent_threshold=75,
)

map_id = flood_map.selfMask().getMapId({{"min": 0, "max": 1, "palette": ["ff3b30"]}})
print(map_id["tile_fetcher"].url_format)
"""
    return {
        "success": True,
        "task": task,
        "docs": HYDRAFLOODS_DOCS_URL,
        "code": code,
    }
