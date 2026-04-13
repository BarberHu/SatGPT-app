from __future__ import annotations

from typing import Any, Dict, List, Optional

import ee
import hydrafloods as hf

from ee_utils import init_gee


def _ensure_gee() -> Dict[str, Any]:
    return init_gee()


def _build_region(bbox: List[float]) -> ee.Geometry:
    return ee.Geometry.Rectangle(bbox)


def _build_dataset(dataset_name: str, region: ee.Geometry, start_date: str, end_date: str):
    dataset_cls = getattr(hf, dataset_name)
    return dataset_cls(region, start_date, end_date)


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

        vis_params = {
            "min": 0,
            "max": 1,
            "palette": "white,blue",
            "dimensions": 1024,
            "region": region,
        }
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

    vis_params = {
        "min": 0,
        "max": 1,
        "palette": "white,navy",
        "dimensions": 1024,
        "region": region,
    }
    return working_ds, water_ds, vis_params, "vv_vh_ratio"


def _tile_artifact(image: ee.Image, vis_params: Dict[str, Any], name: str) -> Dict[str, Any]:
    serializable_vis = {k: v for k, v in vis_params.items() if k != "region"}
    return {
        "name": name,
        "tile_url": image.getMapId(vis_params)["tile_fetcher"].url_format,
        "thumbnail_url": image.getThumbURL(vis_params),
        "vis_params": serializable_vis,
    }


def _observation_image(water_ds, observation_date: str) -> ee.Image:
    return water_ds.collection.mode().set("system:time_start", ee.Date(observation_date).millis())


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
    ]

    if action in {"flood_extent", "depth_estimation"}:
        lines.append(f"flood = hf.extract_flood(water_img, reference='{reference}', permanent_threshold=75)")
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
            "primary_layer": _tile_artifact(water_img, vis_params, "water_extent"),
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
    flood_vis = {
        "min": 0,
        "max": 1,
        "palette": "white,red",
        "dimensions": 1024,
        "region": region,
    }

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
                "primary_layer": _tile_artifact(flood_img, flood_vis, "flood_extent"),
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
    depth_vis = {
        "min": 0,
        "max": 5,
        "palette": "white,cyan,blue,navy",
        "dimensions": 1024,
        "region": region,
    }

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
                "primary_layer": _tile_artifact(depth_img, depth_vis, "flood_depth"),
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
