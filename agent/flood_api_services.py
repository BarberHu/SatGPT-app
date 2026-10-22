import json
import re
from datetime import date, timedelta
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional
from urllib.error import HTTPError
from urllib.request import urlopen

import ee
import openai
try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - old openai SDK
    OpenAI = None
from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.pdfgen import canvas
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from project_env import load_project_env, required_env


load_project_env()


ROOT_DIR = Path(__file__).resolve().parents[1]
LAYER_CATALOG_PATH = ROOT_DIR / "frontend" / "src" / "config" / "layerCatalog.json"
AGENT_RASTER_LAYER_KEYS = {
    "singleInundationEvent",
    "inundationHotspot",
    "wildfireRisk",
    "landslideRisk",
    "activeFireDetections",
    "burnHistory",
    "slopeSteepness",
    "lclu",
    "populationDensity",
    "soilTexture",
}
JRC_YEARLY_HISTORY_MIN_YEAR = 1984
JRC_YEARLY_HISTORY_MAX_YEAR = 2021
DEFAULT_RISK_WINDOW_DAYS = 60
WILDFIRE_RISK_PALETTE = ["#2E7D32", "#FDD835", "#FF8F00", "#E53935", "#B71C1C"]
LANDSLIDE_RISK_PALETTE = ["#1565C0", "#42A5F5", "#FFC107", "#FF6F00", "#D84315"]

def _load_layer_catalog() -> Dict[str, Any]:
    with LAYER_CATALOG_PATH.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def get_basic_layer_catalog() -> Dict[str, Any]:
    return _load_layer_catalog()["basic"]


def _deserialize_payload_value(value: Any) -> Any:
    if isinstance(value, str):
        stripped = value.strip()
        if stripped.startswith("{") or stripped.startswith("["):
            return json.loads(stripped)
    return value


def get_bounds_from_ring(coordinates: list[list[float]]) -> Dict[str, float]:
    lngs = [point[0] for point in coordinates]
    lats = [point[1] for point in coordinates]
    return {
        "west": min(lngs),
        "south": min(lats),
        "east": max(lngs),
        "north": max(lats),
    }


def build_aoi_from_coordinate_ring(coordinates: list[list[float]]) -> Dict[str, Any]:
    return {
        "version": 1,
        "source": "coordinate_ring",
        "kind": "polygon",
        "bounds": get_bounds_from_ring(coordinates),
        "geojson": {
            "type": "Polygon",
            "coordinates": [coordinates],
        },
    }


def extract_geojson_geometry(geojson: Any) -> Optional[Dict[str, Any]]:
    if not isinstance(geojson, dict):
        return None

    geo_type = geojson.get("type")
    if geo_type == "FeatureCollection":
        features = geojson.get("features") or []
        return extract_geojson_geometry(features[0]) if features else None
    if geo_type == "Feature":
        return geojson.get("geometry")
    return geojson


def is_valid_bounds(bounds: Any) -> bool:
    if not isinstance(bounds, dict):
        return False
    return {"west", "south", "east", "north"}.issubset(bounds.keys())


def parse_aoi_from_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    serialized_aoi = _deserialize_payload_value(payload.get("aoi"))
    if isinstance(serialized_aoi, dict):
        return serialized_aoi

    coordinate_ring = _deserialize_payload_value(payload.get("coordinates"))
    if isinstance(coordinate_ring, list) and coordinate_ring:
        return build_aoi_from_coordinate_ring(coordinate_ring)

    raise ValueError("Missing AOI definition. Expected 'aoi' or 'coordinates'.")


def aoi_to_ee_geometry(aoi: Dict[str, Any]) -> ee.Geometry:
    geometry = extract_geojson_geometry(aoi.get("geojson"))
    if geometry:
        return ee.Geometry(geometry)

    bounds = aoi.get("bounds")
    if is_valid_bounds(bounds):
        return ee.Geometry.Rectangle([
            bounds["west"],
            bounds["south"],
            bounds["east"],
            bounds["north"],
        ])

    raise ValueError("AOI payload does not include geojson or bounds.")


# Earth Engine rejects download requests whose serialized payload exceeds ~48 MB
# ("Total request size (X bytes) must be less than or equal to Y bytes."). Complex AOI
# polygons (uploaded boundaries, basin outlines) dominate that payload and are embedded
# twice for downloads (once by .clip(), once as the region parameter), so thin oversized
# geometries on the client before handing them to Earth Engine.
DOWNLOAD_GEOMETRY_BUDGET_BYTES = 2_000_000
_GEOJSON_BYTES_PER_POINT = 48


def _geojson_geometry_byte_size(geometry: Dict[str, Any]) -> int:
    try:
        return len(json.dumps(geometry, separators=(",", ":")))
    except (TypeError, ValueError):
        return 0


def _decimate_ring(ring: list, keep_every: int) -> list:
    if keep_every <= 1 or len(ring) <= 4:
        return ring
    thinned = ring[::keep_every]
    if ring and ring[0] == ring[-1] and (not thinned or thinned[-1] != thinned[0]):
        thinned.append(thinned[0])
    # GEE 要求闭合环至少 4 个点（3 个独立点 + 闭合点），否则报
    # "GeometryConstructors.MultiPolygon: At least 4 points are required ..."。
    # 混合大小的环统一按 keep_every 抽稀时，小环可能被抽到不足 4 点，保留原环。
    if len(thinned) < 4:
        return ring
    return thinned


def _thin_polygon_rings(rings: list, keep_every: int) -> list:
    return [_decimate_ring(ring, keep_every) for ring in rings if isinstance(ring, list)]


def _thin_geojson_geometry(geometry: Dict[str, Any], keep_every: int) -> Dict[str, Any]:
    geo_type = geometry.get("type")
    coords = geometry.get("coordinates")
    if geo_type == "Polygon" and isinstance(coords, list):
        return {**geometry, "coordinates": _thin_polygon_rings(coords, keep_every)}
    if geo_type == "MultiPolygon" and isinstance(coords, list):
        return {
            **geometry,
            "coordinates": [
                _thin_polygon_rings(polygon, keep_every)
                for polygon in coords
                if isinstance(polygon, list)
            ],
        }
    return geometry


def _thin_geojson_geometry_to_budget(geometry: Dict[str, Any], budget_bytes: int) -> Dict[str, Any]:
    """Uniformly thin polygon rings until the serialized geometry fits the byte budget."""
    if _geojson_geometry_byte_size(geometry) <= budget_bytes:
        return geometry

    coordinates = geometry.get("coordinates")
    geo_type = geometry.get("type")
    if geo_type not in ("Polygon", "MultiPolygon") or not isinstance(coordinates, list):
        return geometry

    if geo_type == "Polygon":
        point_total = sum(len(ring) for ring in coordinates if isinstance(ring, list))
    else:
        point_total = sum(
            len(ring)
            for polygon in coordinates
            if isinstance(polygon, list)
            for ring in polygon
            if isinstance(ring, list)
        )
    target_points = max(256, budget_bytes // _GEOJSON_BYTES_PER_POINT)
    keep_every = max(2, -(-point_total // target_points))

    thinned = _thin_geojson_geometry(geometry, keep_every)
    attempts = 0
    while _geojson_geometry_byte_size(thinned) > budget_bytes and attempts < 6:
        keep_every *= 2
        thinned = _thin_geojson_geometry(geometry, keep_every)
        attempts += 1
    return thinned


def build_download_region(aoi: Dict[str, Any]) -> ee.Geometry:
    """AOI geometry for GeoTIFF downloads, thinned when it would blow up the request size."""
    geometry = extract_geojson_geometry(aoi.get("geojson"))
    if geometry:
        thinned = _thin_geojson_geometry_to_budget(geometry, DOWNLOAD_GEOMETRY_BUDGET_BYTES)
        return ee.Geometry(thinned)

    bounds = aoi.get("bounds")
    if is_valid_bounds(bounds):
        return ee.Geometry.Rectangle([
            bounds["west"],
            bounds["south"],
            bounds["east"],
            bounds["north"],
        ])

    raise ValueError("AOI payload does not include geojson or bounds.")


# 影像场景的几何预算：约 2500 个顶点。流域尺度下显示无差别，
# 但能避免数万顶点的 AOI 拖慢 GEE 检索与每片瓦片的 clip 计算。
IMAGERY_GEOMETRY_BUDGET_BYTES = 64 * 1024


def thin_geojson_geometry(
    geometry: Dict[str, Any],
    budget_bytes: int = IMAGERY_GEOMETRY_BUDGET_BYTES,
) -> Dict[str, Any]:
    """公开接口：把 GeoJSON geometry 均匀抽稀到字节预算内。

    影像/瓦片场景对边界精度要求低，但超大 AOI（如流域边界，动辄数万顶点）
    会让 GEE 的 filterBounds/clip 每次瓦片请求都显著变慢，统一抽稀可大幅加速。

    会先把 Feature / FeatureCollection 解包成纯几何（ee.Geometry 不接受
    Feature 包裹结构，否则报 "Invalid GeoJSON geometry"），非多边形类型原样返回。
    """
    unpacked = extract_geojson_geometry(geometry) or geometry
    return _thin_geojson_geometry_to_budget(unpacked, budget_bytes)


def visualize_image(image: ee.Image, vis_params: Dict[str, Any]) -> ee.Image:
    return image.visualize(
        min=vis_params["min"],
        max=vis_params["max"],
        palette=vis_params["palette"],
    )


def attach_map_id(content: Dict[str, Any], key: str, map_id: Dict[str, Any]) -> None:
    content[f"eeMapId{key}"] = map_id["mapid"]
    content[f"eeToken{key}"] = map_id["token"]
    content[f"eeMapURL{key}"] = map_id["tile_fetcher"].url_format


def surface_water_tool_style(image: ee.Image) -> ee.Image:
    water_style = (
        "<RasterSymbolizer>"
        '<ColorMap extended="true">'
        '<ColorMapEntry color="#FD0303" quantity="2.0" label="-1"/>'
        '<ColorMapEntry color="#00008B" quantity="3.0" label="-1"/>'
        "</ColorMap>"
        "</RasterSymbolizer>"
    )
    return image.sldStyle(water_style)


def get_default_map_payload() -> Dict[str, Any]:
    default = surface_water_tool_style(
        ee.Image("users/arjenhaag/SERVIR-Mekong/SWMT_default_2017_2")
    ).getMapId()
    return {
        "eeMapId": default["mapid"],
        "eeToken": default["token"],
        "eeMapURL": default["tile_fetcher"].url_format,
    }


def get_unsupervised_map_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    unsupervised_catalog = get_basic_layer_catalog()["unsupervised"]
    permanent_water_catalog = unsupervised_catalog["globalSurfaceWater"]

    collection = (
        ee.ImageCollection("LANDSAT/LE07/C01/T1_SR")
        .filterBounds(region)
        .filterDate(payload.get("time_start"), payload.get("time_end"))
    )

    def compute_ndwi(image: ee.Image) -> ee.Image:
        ndwi = image.normalizedDifference(["B2", "B4"]).rename("NDWI")
        return image.addBands(ndwi)

    landsat_ndwi = collection.map(compute_ndwi)
    median_ndwi = landsat_ndwi.median().clip(region)
    gsw = ee.Image(permanent_water_catalog["dataset"])
    occurrence = gsw.select(permanent_water_catalog["band"])
    water_mask = occurrence.gte(permanent_water_catalog["threshold"])
    masked_result = median_ndwi.updateMask(water_mask)
    training = masked_result.select("NDWI").sample(
        region=region,
        scale=30,
        numPixels=5000,
    )

    clusterer = ee.Clusterer.wekaKMeans(3).train(training)
    result = masked_result.cluster(clusterer)
    color_image = result.visualize(min=0, max=1, palette=["blue", "green", "red"])
    mapid = color_image.getMapId()
    return {
        "eeMapId": mapid["mapid"],
        "eeToken": mapid["token"],
        "eeMapURL": mapid["tile_fetcher"].url_format,
    }


def _attach_supplementary_map_layers(content: Dict[str, Any], region: ee.Geometry) -> None:
    supplementary_catalog = get_basic_layer_catalog()["supplementary"]
    lclu = ee.ImageCollection(supplementary_catalog["landcover"]["dataset"]).first().clip(region)
    population_density = ee.Image(
        supplementary_catalog["populationDensity"]["dataset"]
    ).clip(region)
    population_density = visualize_image(
        population_density, supplementary_catalog["populationDensity"]["visualization"]
    )
    soil_texture = ee.Image(supplementary_catalog["soilTexture"]["dataset"]).clip(region).select(
        supplementary_catalog["soilTexture"]["band"]
    )
    soil_texture = visualize_image(
        soil_texture, supplementary_catalog["soilTexture"]["visualization"]
    )
    healthcare_access = ee.Image(
        supplementary_catalog["healthCareAccess"]["dataset"]
    ).select(supplementary_catalog["healthCareAccess"]["band"]).clip(region)
    healthcare_access = visualize_image(
        healthcare_access, supplementary_catalog["healthCareAccess"]["visualization"]
    )

    attach_map_id(content, "LCLU", lclu.getMapId())
    attach_map_id(content, "PopulationDensity", population_density.getMapId())
    attach_map_id(content, "SoilTexture", soil_texture.getMapId())
    attach_map_id(content, "HealthCareAccess", healthcare_access.getMapId())


def get_historical_map_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    jrc_surface_water, jrc_surface_flood, jrc_surface_water_visual, jrc_surface_flood_visual = (
        _build_single_inundation_images(payload, region)
    )
    content: Dict[str, Any] = {}
    attach_map_id(content, "Flood", jrc_surface_flood_visual.getMapId())
    attach_map_id(content, "Water", jrc_surface_water_visual.getMapId())
    _attach_supplementary_map_layers(content, region)
    return content


def _build_single_inundation_images(payload: Dict[str, Any], region: ee.Geometry) -> tuple[ee.Image, ee.Image, ee.Image, ee.Image]:
    basic_layer_catalog = get_basic_layer_catalog()
    historical_catalog = basic_layer_catalog["historical"]

    time_start = str(payload.get("time_start") or "2010-01-01")
    time_end = str(payload.get("time_end") or "2024-12-31")
    start_year = int(time_start.split("-")[0])
    end_year = int(time_end.split("-")[0])

    water_band = historical_catalog["water"]["band"]
    flood_band = historical_catalog["flood"]["band"]

    if end_year < JRC_YEARLY_HISTORY_MIN_YEAR or start_year > JRC_YEARLY_HISTORY_MAX_YEAR:
        jrc_surface_water = ee.Image.constant(0).rename(water_band).clip(region)
        jrc_surface_flood = ee.Image.constant(0).rename(flood_band).clip(region)
    else:
        start_year = max(start_year, JRC_YEARLY_HISTORY_MIN_YEAR)
        end_year = min(end_year, JRC_YEARLY_HISTORY_MAX_YEAR)
        jrc_surface_water = (
            ee.ImageCollection(historical_catalog["jrcYearlyHistory"]["dataset"])
            .filter(ee.Filter.calendarRange(start_year, end_year, "year"))
            .map(lambda image: image.select(water_band).eq(historical_catalog["water"]["matchValue"]))
            .sum()
            .rename(water_band)
            .clip(region)
        )
        jrc_surface_flood = (
            ee.ImageCollection(historical_catalog["jrcYearlyHistory"]["dataset"])
            .filter(ee.Filter.calendarRange(start_year, end_year, "year"))
            .map(lambda image: image.select(flood_band).eq(historical_catalog["flood"]["matchValue"]))
            .sum()
            .rename(flood_band)
            .clip(region)
        )

    jrc_surface_water = jrc_surface_water.updateMask(jrc_surface_water.gt(0))
    jrc_surface_water_visual = visualize_image(
        jrc_surface_water, historical_catalog["water"]["visualization"]
    )
    jrc_surface_flood = jrc_surface_flood.updateMask(jrc_surface_flood.gt(0))
    jrc_surface_flood_visual = visualize_image(
        jrc_surface_flood, historical_catalog["flood"]["visualization"]
    )

    return jrc_surface_water, jrc_surface_flood, jrc_surface_water_visual, jrc_surface_flood_visual


def _blend_visual_layers(*images: ee.Image) -> ee.Image:
    image_list = [image for image in images if image is not None]
    if not image_list:
        raise ValueError("At least one visual layer is required.")
    blended = image_list[0]
    for image in image_list[1:]:
        blended = blended.blend(image)
    return blended


def _visualize_single_inundation(water: ee.Image, flood: ee.Image) -> ee.Image:
    classified = (
        water.unmask(0)
        .where(flood.unmask(0).gt(0), 2)
        .rename("inundation_class")
        .selfMask()
    )
    return classified.visualize(
        min=1,
        max=2,
        palette=["#00008B", "#FD0303"],
    )


def _visualize_hotspot(permanent_water_visual: ee.Image, flood_frequency_visual: ee.Image) -> ee.Image:
    return _blend_visual_layers(permanent_water_visual, flood_frequency_visual)


def _build_active_fire_detection_image(payload: Dict[str, Any], region: ee.Geometry) -> ee.Image:
    time_start = str(payload.get("time_start") or "2024-01-01")
    time_end = str(payload.get("time_end") or "2024-12-31")
    active_fire_collection = (
        ee.ImageCollection("FIRMS")
        .filterDate(time_start, time_end)
        .select("T21")
    )
    active_fire = ee.Image(
        ee.Algorithms.If(
            active_fire_collection.size().gt(0),
            active_fire_collection.max().rename("T21").clip(region),
            ee.Image.constant(0).rename("T21").clip(region),
        )
    )
    return active_fire.updateMask(active_fire.gt(0))


def _get_burn_history_date_window(payload: Dict[str, Any]) -> tuple[str, str]:
    default_start, default_end = _get_recent_date_window(365)
    return (
        str(payload.get("time_start") or default_start),
        str(payload.get("time_end") or default_end),
    )


def _build_burn_history_image(payload: Dict[str, Any], region: ee.Geometry) -> ee.Image:
    time_start, time_end = _get_burn_history_date_window(payload)
    burned_area_collection = (
        ee.ImageCollection("MODIS/061/MCD64A1")
        .filterDate(time_start, time_end)
        .filterBounds(region)
        .select("BurnDate")
    )
    burned_area = ee.Image(
        ee.Algorithms.If(
            burned_area_collection.size().gt(0),
            burned_area_collection.max().gt(0).rename("burn_history").clip(region),
            ee.Image.constant(0).rename("burn_history").clip(region),
        )
    )
    return burned_area.updateMask(burned_area.gt(0))


def _build_slope_steepness_image(region: ee.Geometry) -> ee.Image:
    elevation = ee.Image("USGS/SRTMGL1_003").select("elevation")
    return ee.Terrain.slope(elevation).rename("slope").clip(region)


def _build_worldcover_fuel_land_cover_image(region: ee.Geometry) -> ee.Image:
    class_values = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 100]
    remapped_values = list(range(len(class_values)))
    return (
        ee.ImageCollection(get_basic_layer_catalog()["supplementary"]["landcover"]["dataset"])
        .first()
        .select("Map")
        .remap(class_values, remapped_values)
        .rename("fuel_land_cover")
        .clip(region)
    )


def _visualize_worldcover_fuel_land_cover(image: ee.Image) -> ee.Image:
    return image.visualize(
        min=0,
        max=10,
        palette=[
            "#006400",
            "#ffbb22",
            "#ffff4c",
            "#f096ff",
            "#fa0000",
            "#b4b4b4",
            "#f0f0f0",
            "#0064c8",
            "#0096a0",
            "#00cf75",
            "#fae6a0",
        ],
    )


def _get_recent_date_window(day_count: int = DEFAULT_RISK_WINDOW_DAYS) -> tuple[str, str]:
    safe_day_count = max(1, int(day_count or DEFAULT_RISK_WINDOW_DAYS))
    end = date.today()
    start = end - timedelta(days=safe_day_count - 1)
    return start.isoformat(), end.isoformat()


def _get_risk_date_context(payload: Dict[str, Any]) -> tuple[str, str, ee.Date, ee.Date, ee.Date, ee.Date]:
    default_start, default_end = _get_recent_date_window()
    time_start = str(payload.get("time_start") or default_start)
    time_end = str(payload.get("time_end") or default_end)
    start_date = ee.Date(time_start)
    end_date = ee.Date(time_end)
    historical_start = end_date.advance(-3, "year")
    historical_end = start_date
    return time_start, time_end, start_date, end_date, historical_start, historical_end


def _get_cloud_threshold(payload: Dict[str, Any], default_value: float = 50) -> float:
    raw_value = payload.get("cloud_threshold", payload.get("cloudthre", default_value))
    try:
        return float(raw_value)
    except (TypeError, ValueError):
        return default_value


def _safe_collection_reduction_image(
    collection: ee.ImageCollection,
    reducer: str,
    band_name: str,
    fallback_value: float = 0,
) -> ee.Image:
    if reducer == "median":
        reduced = collection.median()
    elif reducer == "mean":
        reduced = collection.mean()
    elif reducer == "sum":
        reduced = collection.sum()
    elif reducer == "max":
        reduced = collection.max()
    else:
        raise ValueError(f"Unsupported image collection reducer: {reducer}")

    return ee.Image(
        ee.Algorithms.If(
            collection.size().gt(0),
            reduced.rename(band_name),
            ee.Image.constant(fallback_value).rename(band_name),
        )
    )


def _mask_sentinel2_scl(image: ee.Image) -> ee.Image:
    scl = image.select("SCL")
    mask = (
        scl.neq(3)
        .multiply(scl.neq(8))
        .multiply(scl.neq(9))
        .multiply(scl.neq(10))
        .multiply(scl.neq(1))
    )
    return image.updateMask(mask).copyProperties(image, ["system:time_start"])


def _add_sentinel2_indices(image: ee.Image) -> ee.Image:
    ndvi = image.normalizedDifference(["B8", "B4"]).rename("NDVI")
    ndwi = image.normalizedDifference(["B3", "B8"]).rename("NDWI")
    return image.addBands([ndvi, ndwi])


def _build_sentinel2_index_images(
    region: ee.Geometry,
    start_date: ee.Date,
    end_date: ee.Date,
    cloud_threshold: float,
) -> tuple[ee.Image, ee.Image]:
    collection = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterBounds(region)
        .filterDate(start_date, end_date)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", cloud_threshold))
        .map(_mask_sentinel2_scl)
        .map(_add_sentinel2_indices)
    )
    ndvi = _safe_collection_reduction_image(collection.select("NDVI"), "median", "NDVI", 0).clip(region)
    ndwi = _safe_collection_reduction_image(collection.select("NDWI"), "median", "NDWI", 0).clip(region)
    return ndvi, ndwi


def _build_land_mask_image(region: ee.Geometry) -> ee.Image:
    land_in_roi = ee.FeatureCollection("USDOS/LSIB_SIMPLE/2017").filterBounds(region)
    return ee.Image.constant(1).clip(land_in_roi).rename("land_mask")


def _build_forest_mask_image(region: ee.Geometry) -> ee.Image:
    landcover = (
        ee.ImageCollection(get_basic_layer_catalog()["supplementary"]["landcover"]["dataset"])
        .first()
        .select("Map")
        .clip(region)
    )
    return landcover.eq(10).add(landcover.eq(20)).add(landcover.eq(30)).gt(0).rename("forest_mask")


def _build_modis_lst_image(start_date: ee.Date, end_date: ee.Date, region: ee.Geometry, band_name: str) -> ee.Image:
    raw_lst = _safe_collection_reduction_image(
        ee.ImageCollection("MODIS/061/MOD11A2")
        .filterDate(start_date, end_date)
        .select("LST_Day_1km"),
        "mean",
        f"{band_name}_raw",
        15000,
    )
    return raw_lst.multiply(0.02).subtract(273.15).rename(band_name).clip(region)


def _build_precip_sum_image(start_date: ee.Date, end_date: ee.Date, region: ee.Geometry, band_name: str) -> ee.Image:
    return _safe_collection_reduction_image(
        ee.ImageCollection("UCSB-CHG/CHIRPS/DAILY")
        .filterDate(start_date, end_date)
        .select("precipitation"),
        "sum",
        band_name,
        0,
    ).clip(region)


def _build_sentinel1_vh_image(region: ee.Geometry, start_date: ee.Date, end_date: ee.Date, band_name: str) -> ee.Image:
    collection = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterBounds(region)
        .filterDate(start_date, end_date)
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VH"))
        .select("VH")
    )
    return _safe_collection_reduction_image(collection, "mean", band_name, -18).clip(region)


def _classify_risk_image(risk: ee.Image, band_name: str) -> ee.Image:
    clamped = risk.clamp(0, 100)
    return (
        ee.Image.constant(1)
        .where(clamped.gte(20), 2)
        .where(clamped.gte(40), 3)
        .where(clamped.gte(60), 4)
        .where(clamped.gte(80), 5)
        .updateMask(clamped.mask())
        .rename(band_name)
    )


def _build_wildfire_risk_class_image(payload: Dict[str, Any], region: ee.Geometry) -> ee.Image:
    _time_start, _time_end, start_date, end_date, historical_start, historical_end = _get_risk_date_context(payload)
    cloud_threshold = _get_cloud_threshold(payload)
    ndvi_current, ndwi_current = _build_sentinel2_index_images(region, start_date, end_date, cloud_threshold)
    _ndvi_historical, ndwi_historical = _build_sentinel2_index_images(
        region,
        historical_start,
        historical_end,
        cloud_threshold,
    )
    lst_current = _build_modis_lst_image(start_date, end_date, region, "LST")
    lst_historical = _build_modis_lst_image(historical_start, historical_end, region, "LST_Historical")
    precip_current = _build_precip_sum_image(start_date, end_date, region, "Precip_Current")
    precip_historical_sum = _build_precip_sum_image(historical_start, historical_end, region, "Precip_Historical")

    current_days = ee.Number(end_date.difference(start_date, "day")).max(1)
    historical_days = ee.Number(historical_end.difference(historical_start, "day")).max(1)
    precip_historical = precip_historical_sum.divide(historical_days).multiply(current_days)

    dem = ee.Image("USGS/SRTMGL1_003").select("elevation")
    slope = ee.Terrain.slope(dem).rename("Slope").clip(region)
    aspect = ee.Terrain.aspect(dem).rename("Aspect").clip(region)
    land_mask = _build_land_mask_image(region)
    forest_mask = _build_forest_mask_image(region)

    fuel_dryness = ndvi_current.subtract(ndwi_current).multiply(50).clamp(0, 100)
    water_deficit = ndwi_historical.subtract(ndwi_current).multiply(50).clamp(0, 100)
    temp_anomaly = lst_current.subtract(lst_historical).add(5).multiply(5).clamp(0, 100)
    precip_denominator = precip_historical.max(ee.Image.constant(1))
    precip_deficit = precip_historical.subtract(precip_current).divide(precip_denominator).multiply(100).clamp(0, 100)
    slope_risk = slope.divide(45).multiply(50).clamp(0, 50)
    aspect_risk = aspect.subtract(180).abs().divide(180).multiply(-50).add(50)
    topo_vulnerability = slope_risk.add(aspect_risk).clamp(0, 100)

    wildfire_risk = (
        fuel_dryness.multiply(0.2)
        .add(water_deficit.multiply(0.3))
        .add(temp_anomaly.multiply(0.25))
        .add(precip_deficit.multiply(0.15))
        .add(topo_vulnerability.multiply(0.1))
        .rename("wildfire_risk")
        .updateMask(forest_mask)
        .updateMask(land_mask)
        .clip(region)
    )
    return _classify_risk_image(wildfire_risk, "wildfire_risk_class")


def _build_landslide_risk_class_image(payload: Dict[str, Any], region: ee.Geometry) -> ee.Image:
    _time_start, _time_end, start_date, end_date, historical_start, historical_end = _get_risk_date_context(payload)
    cloud_threshold = _get_cloud_threshold(payload)
    ndvi_current, _ndwi_current = _build_sentinel2_index_images(region, start_date, end_date, cloud_threshold)
    precip_3days = _build_precip_sum_image(end_date.advance(-3, "day"), end_date, region, "Precip_3days")
    slope = _build_slope_steepness_image(region)
    dem = ee.Image("USGS/SRTMGL1_003").select("elevation").clip(region)
    rugosity = dem.reduceNeighborhood(
        reducer=ee.Reducer.stdDev(),
        kernel=ee.Kernel.circle(3, "pixels"),
    ).rename("Rugosity")
    s1_current = _build_sentinel1_vh_image(region, start_date, end_date, "SAR_VH")
    s1_historical = _build_sentinel1_vh_image(region, historical_start, historical_end, "SAR_VH_Historical")
    land_mask = _build_land_mask_image(region)

    rain_trigger = precip_3days.clamp(0, 100)
    slope_hazard = slope.subtract(15).divide(30).multiply(100).clamp(0, 100)
    terrain_roughness = rugosity.unitScale(0, 50).multiply(100).clamp(0, 100)
    soil_saturation = s1_historical.subtract(s1_current).add(3).divide(6).multiply(100).clamp(0, 100)
    vegetation_instability = ndvi_current.multiply(-100).add(100).clamp(0, 100)

    landslide_risk = (
        rain_trigger.multiply(0.35)
        .add(slope_hazard.multiply(0.25))
        .add(soil_saturation.multiply(0.2))
        .add(vegetation_instability.multiply(0.1))
        .add(terrain_roughness.multiply(0.1))
        .rename("landslide_risk")
        .updateMask(land_mask)
        .clip(region)
    )
    return _classify_risk_image(landslide_risk, "landslide_risk_class")


def _requested_agent_raster_layer_keys(payload: Dict[str, Any]) -> set[str]:
    raw_keys = payload.get("layer_keys", payload.get("layerKeys"))
    if not raw_keys:
        raise ValueError("layer_keys must include at least one layer key.")

    if isinstance(raw_keys, str):
        stripped = raw_keys.strip()
        if stripped.startswith("["):
            raw_keys = json.loads(stripped)
        else:
            raw_keys = [key.strip() for key in stripped.split(",") if key.strip()]

    if not isinstance(raw_keys, list):
        raise ValueError("layer_keys must be a list, JSON array string, or comma-separated string.")

    requested_keys = {str(key).strip() for key in raw_keys if str(key).strip()}
    unsupported_keys = requested_keys - AGENT_RASTER_LAYER_KEYS
    if unsupported_keys:
        raise ValueError(f"Unsupported agent raster layer key(s): {', '.join(sorted(unsupported_keys))}")
    if not requested_keys:
        raise ValueError("layer_keys must include at least one layer key.")
    return requested_keys


def _clamp_jrc_year(value: Any, fallback: int) -> int:
    try:
        year = int(value)
    except (TypeError, ValueError):
        year = fallback
    return max(JRC_YEARLY_HISTORY_MIN_YEAR, min(JRC_YEARLY_HISTORY_MAX_YEAR, year))


def _get_jrc_year_range_from_payload(
    payload: Dict[str, Any],
    *,
    default_start: int = 1988,
    default_count: int = 5,
) -> tuple[int, int, int]:
    if payload.get("year_start") is not None or payload.get("year_end") is not None:
        year_start = _clamp_jrc_year(payload.get("year_start"), default_start)
        year_end = _clamp_jrc_year(payload.get("year_end"), year_start)
    else:
        year_start = _clamp_jrc_year(payload.get("year_from"), default_start)
        try:
            year_count = max(1, int(payload.get("year_count") or default_count))
        except (TypeError, ValueError):
            year_count = default_count
        year_end = _clamp_jrc_year(year_start + year_count - 1, year_start)

    if year_end < year_start:
        year_start, year_end = year_end, year_start

    year_count = year_end - year_start + 1
    return year_start, year_end, year_count


def get_agent_raster_layers_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    requested_keys = _requested_agent_raster_layer_keys(payload)
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    supplementary_catalog = get_basic_layer_catalog()["supplementary"]
    content: Dict[str, Any] = {}

    if "singleInundationEvent" in requested_keys:
        water, flood, _water_visual, _flood_visual = _build_single_inundation_images(payload, region)
        attach_map_id(
            content,
            "SingleInundationEvent",
            _visualize_single_inundation(water, flood).getMapId(),
        )
        content["singleInundationEventMeta"] = {
            "time_start": str(payload.get("time_start") or "2010-01-01"),
            "time_end": str(payload.get("time_end") or "2024-12-31"),
        }

    if "inundationHotspot" in requested_keys:
        _hotspot_water, _hotspot_frequency, hotspot_water_visual, hotspot_visual = (
            _build_flood_hotspot_images(payload, region)
        )
        attach_map_id(
            content,
            "InundationHotspot",
            _visualize_hotspot(hotspot_water_visual, hotspot_visual).getMapId(),
        )
        year_start, year_end, year_count = _get_jrc_year_range_from_payload(payload)
        content["inundationHotspotMeta"] = {
            "year_start": year_start,
            "year_end": year_end,
            "year_from": year_start,
            "year_count": year_count,
            "year_to": year_end,
        }

    if "wildfireRisk" in requested_keys:
        time_start, time_end, *_date_context = _get_risk_date_context(payload)
        wildfire_risk_class = _build_wildfire_risk_class_image(payload, region)
        wildfire_risk_visual = wildfire_risk_class.visualize(
            min=1,
            max=5,
            palette=WILDFIRE_RISK_PALETTE,
        )
        attach_map_id(content, "WildfireRisk", wildfire_risk_visual.getMapId())
        content["wildfireRiskMeta"] = {
            "dataset": "Sentinel-2 SR, MODIS LST, CHIRPS, SRTM, ESA WorldCover",
            "time_start": time_start,
            "time_end": time_end,
            "classification": "1 low, 2 moderate, 3 watch, 4 warning, 5 very high",
        }

    if "landslideRisk" in requested_keys:
        time_start, time_end, *_date_context = _get_risk_date_context(payload)
        landslide_risk_class = _build_landslide_risk_class_image(payload, region)
        landslide_risk_visual = landslide_risk_class.visualize(
            min=1,
            max=5,
            palette=LANDSLIDE_RISK_PALETTE,
        )
        attach_map_id(content, "LandslideRisk", landslide_risk_visual.getMapId())
        content["landslideRiskMeta"] = {
            "dataset": "CHIRPS, SRTM, Sentinel-1 VH, Sentinel-2 NDVI",
            "time_start": time_start,
            "time_end": time_end,
            "classification": "1 low, 2 moderate, 3 watch, 4 warning, 5 very high",
        }

    if "activeFireDetections" in requested_keys:
        active_fire = _build_active_fire_detection_image(payload, region)
        active_fire_visual = visualize_image(
            active_fire,
            {
                "min": 325,
                "max": 400,
                "palette": ["#ef4444", "#f97316", "#facc15"],
            },
        )
        attach_map_id(content, "ActiveFireDetections", active_fire_visual.getMapId())
        content["activeFireDetectionsMeta"] = {
            "dataset": "FIRMS",
            "time_start": str(payload.get("time_start") or "2024-01-01"),
            "time_end": str(payload.get("time_end") or "2024-12-31"),
        }

    if "burnHistory" in requested_keys:
        time_start, time_end = _get_burn_history_date_window(payload)
        burn_history = _build_burn_history_image(payload, region)
        burn_history_visual = visualize_image(
            burn_history,
            {
                "min": 0,
                "max": 1,
                "palette": ["#111827"],
            },
        )
        attach_map_id(content, "BurnHistory", burn_history_visual.getMapId())
        content["burnHistoryMeta"] = {
            "dataset": "MODIS/061/MCD64A1",
            "band": "BurnDate",
            "time_start": time_start,
            "time_end": time_end,
        }

    if "slopeSteepness" in requested_keys:
        slope_steepness = _build_slope_steepness_image(region)
        slope_steepness_visual = visualize_image(
            slope_steepness,
            {
                "min": 0,
                "max": 60,
                "palette": ["#f7fcf5", "#c7e9c0", "#74c476", "#fd8d3c", "#bd0026"],
            },
        )
        attach_map_id(content, "SlopeSteepness", slope_steepness_visual.getMapId())
        content["slopeSteepnessMeta"] = {
            "dataset": "USGS/SRTMGL1_003",
            "derived": "ee.Terrain.slope(elevation)",
        }

    if "lclu" in requested_keys:
        lclu = ee.ImageCollection(supplementary_catalog["landcover"]["dataset"]).first().clip(region)
        attach_map_id(content, "LCLU", lclu.getMapId())

    if "populationDensity" in requested_keys:
        population_density = ee.Image(
            supplementary_catalog["populationDensity"]["dataset"]
        ).clip(region)
        population_density = visualize_image(
            population_density, supplementary_catalog["populationDensity"]["visualization"]
        )
        attach_map_id(content, "PopulationDensity", population_density.getMapId())

    if "soilTexture" in requested_keys:
        soil_texture = ee.Image(supplementary_catalog["soilTexture"]["dataset"]).clip(region).select(
            supplementary_catalog["soilTexture"]["band"]
        )
        soil_texture = visualize_image(
            soil_texture, supplementary_catalog["soilTexture"]["visualization"]
        )
        attach_map_id(content, "SoilTexture", soil_texture.getMapId())

    return content


def _safe_download_name(value: Any, fallback: str = "aoi") -> str:
    cleaned = re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "").strip())
    cleaned = re.sub(r"_+", "_", cleaned).strip("_")
    return cleaned[:48] or fallback


def _get_imagery_download_date_window(payload: Dict[str, Any]) -> tuple[str, str, str]:
    """Return the selected inclusive imagery window and EE's exclusive end date."""
    start_value = str(payload.get("start_date") or "").strip()
    end_value = str(payload.get("end_date") or "").strip()
    if not start_value or not end_value:
        raise ValueError("Imagery downloads require start_date and end_date.")

    try:
        start = date.fromisoformat(start_value)
        end = date.fromisoformat(end_value)
    except ValueError as error:
        raise ValueError("Imagery download dates must use YYYY-MM-DD format.") from error

    if start > end:
        raise ValueError("Imagery download start_date must not be after end_date.")

    return start.isoformat(), end.isoformat(), (end + timedelta(days=1)).isoformat()


def _build_sentinel2_rgb_download_image(region: ee.Geometry, payload: Dict[str, Any]) -> ee.Image:
    start_date, _end_date, filter_end_date = _get_imagery_download_date_window(payload)
    cloud_threshold = max(0.0, min(100.0, _get_cloud_threshold(payload, 30)))
    collection = (
        ee.ImageCollection("COPERNICUS/S2_SR_HARMONIZED")
        .filterDate(start_date, filter_end_date)
        .filterBounds(region)
        .filter(ee.Filter.lt("CLOUDY_PIXEL_PERCENTAGE", cloud_threshold))
        .sort("CLOUDY_PIXEL_PERCENTAGE")
    )
    # Keep the scientific surface-reflectance bands rather than exporting styled RGB pixels.
    # The collection/filter/mosaic order matches gee_service._get_sentinel2_by_region.
    return collection.mosaic().clip(region).select(["B4", "B3", "B2"])


def _build_sentinel1_vv_download_image(region: ee.Geometry, payload: Dict[str, Any]) -> ee.Image:
    start_date, _end_date, filter_end_date = _get_imagery_download_date_window(payload)
    collection = (
        ee.ImageCollection("COPERNICUS/S1_GRD")
        .filterDate(start_date, filter_end_date)
        .filterBounds(region)
        .filter(ee.Filter.listContains("transmitterReceiverPolarisation", "VV"))
        .filter(ee.Filter.eq("instrumentMode", "IW"))
        .select("VV")
    )
    # COPERNICUS/S1_GRD is already calibrated and stored in dB in Earth Engine.
    return collection.mosaic().clip(region)


def _get_agent_raster_download_config(layer_key: str) -> Dict[str, Any]:
    supplementary_catalog = get_basic_layer_catalog()["supplementary"]
    layer_configs = {
        "sentinel2Rgb": {
            "title": "Sentinel-2 RGB Mosaic",
            "filename": "sentinel2_rgb_mosaic",
            "scale": 10,
            "image_builder": _build_sentinel2_rgb_download_image,
        },
        "sentinel1Vv": {
            "title": "Sentinel-1 VV Mosaic",
            "filename": "sentinel1_vv_mosaic",
            "scale": 10,
            "image_builder": _build_sentinel1_vv_download_image,
        },
        "singleInundationEvent": {
            "title": "Single Inundation Event",
            "filename": "single_inundation_event",
            "scale": 30,
            "image_builder": _build_single_inundation_download_image,
        },
        "inundationHotspot": {
            "title": "Inundation Hotspot",
            "filename": "inundation_hotspot",
            "scale": 30,
            "image_builder": _build_inundation_hotspot_download_image,
        },
        "lclu": {
            "title": "Land Cover and Land Use",
            "filename": "land_cover_land_use",
            "scale": 10,
            "image_builder": lambda region, payload: ee.ImageCollection(
                supplementary_catalog["landcover"]["dataset"]
            ).first().clip(region),
        },
        "populationDensity": {
            "title": "Population Density",
            "filename": "population_density",
            "scale": 1000,
            "image_builder": lambda region, payload: ee.Image(
                supplementary_catalog["populationDensity"]["dataset"]
            ).clip(region),
        },
        "soilTexture": {
            "title": "Soil Texture",
            "filename": "soil_texture",
            "scale": 250,
            "image_builder": lambda region, payload: ee.Image(
                supplementary_catalog["soilTexture"]["dataset"]
            ).select(supplementary_catalog["soilTexture"]["band"]).clip(region),
        },
        "wildfireRisk": {
            "title": "Wildfire Risk",
            "filename": "wildfire_risk",
            "scale": 100,
            "image_builder": lambda region, payload: _build_wildfire_risk_class_image(payload, region),
        },
        "burnHistory": {
            "title": "Burn History",
            "filename": "burn_history",
            "scale": 500,
            "image_builder": lambda region, payload: _build_burn_history_image(payload, region),
        },
        "landslideRisk": {
            "title": "Landslide Risk",
            "filename": "landslide_risk",
            "scale": 100,
            "image_builder": lambda region, payload: _build_landslide_risk_class_image(payload, region),
        },
        "slopeSteepness": {
            "title": "Slope Steepness",
            "filename": "slope_steepness",
            "scale": 30,
            "image_builder": lambda region, payload: _build_slope_steepness_image(region),
        },
    }

    config = layer_configs.get(layer_key)
    if not config:
        raise ValueError(f"Unsupported agent raster layer: {layer_key}")

    return config


def _build_single_inundation_download_image(region: ee.Geometry, payload: Dict[str, Any]) -> ee.Image:
    water, flood, _water_visual, _flood_visual = _build_single_inundation_images(payload, region)
    return ee.Image.cat([
        water.unmask(0).rename("permanent_water"),
        flood.unmask(0).rename("inundation_event"),
    ]).toFloat().clip(region)


def _build_inundation_hotspot_download_image(region: ee.Geometry, payload: Dict[str, Any]) -> ee.Image:
    water, flood_frequency, _water_visual, _flood_visual = _build_flood_hotspot_images(payload, region)
    return ee.Image.cat([
        water.unmask(0).rename("permanent_water"),
        flood_frequency.unmask(0).rename("flood_frequency"),
    ]).toFloat().clip(region)


def _build_agent_raster_download_image(layer_key: str, region: ee.Geometry, payload: Dict[str, Any]) -> tuple[ee.Image, Dict[str, Any]]:
    config = _get_agent_raster_download_config(layer_key)
    return config["image_builder"](region, payload), config


def _get_agent_raster_download_payload(payload: Dict[str, Any], scale: Optional[int] = None) -> Dict[str, Any]:
    layer_key = payload.get("layer_key") or payload.get("layerKey")
    if not layer_key:
        raise ValueError("Missing layer_key.")

    aoi = parse_aoi_from_payload(payload)
    region = build_download_region(aoi)
    image, config = _build_agent_raster_download_image(str(layer_key), region, payload)
    scope_name = _safe_download_name(aoi.get("label") or aoi.get("source"), "aoi")
    filename_base = f"satgpt_{config['filename']}_{scope_name}"
    effective_scale = scale or config["scale"]
    download_url = image.getDownloadURL({
        "name": filename_base,
        "scale": effective_scale,
        "region": region,
        "format": "GEO_TIFF",
        "filePerBand": False,
    })

    return {
        "success": True,
        "data": {
            "download_url": download_url,
            "filename": f"{filename_base}.tif",
            "format": "GeoTIFF",
            "layer_key": layer_key,
            "title": config["title"],
            "scale": effective_scale,
        },
    }


def get_agent_raster_download_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    return _get_agent_raster_download_payload(payload)


def _agent_raster_download_scales(layer_key: str, base_scale: int) -> list[int]:
    if layer_key in {"sentinel2Rgb", "sentinel1Vv"}:
        return [base_scale, 20, 30, 60, 100, 250]
    if layer_key in {"singleInundationEvent", "inundationHotspot"}:
        return [base_scale, 60, 100, 250]
    if layer_key == "lclu":
        return [base_scale, 20, 30, 50, 100]
    if layer_key == "soilTexture":
        return [base_scale, 500, 1000]
    if layer_key in {"wildfireRisk", "landslideRisk"}:
        return [base_scale, 250, 500, 1000]
    if layer_key == "burnHistory":
        return [base_scale, 1000]
    if layer_key == "slopeSteepness":
        return [base_scale, 60, 100, 250]
    return [base_scale]


def _is_download_size_limit_error(error_text: Any) -> bool:
    normalized = str(error_text or "").lower()
    return any(marker in normalized for marker in (
        "total request size",
        "pixel grid dimensions",
        "must be less than or equal to 32768",
        "image is too large",
    ))


def get_agent_raster_download_file(payload: Dict[str, Any]):
    layer_key = str(payload.get("layer_key") or payload.get("layerKey") or "")
    if not layer_key:
        raise ValueError("Missing layer_key.")

    config = _get_agent_raster_download_config(layer_key)
    last_error = None
    for scale in _agent_raster_download_scales(layer_key, config["scale"]):
        try:
            download_payload = _get_agent_raster_download_payload(payload, scale=scale)
            data = download_payload.get("data") or {}
            download_url = data.get("download_url")
            filename = data.get("filename") or "satgpt_aoi_raster.tif"
            if not download_url:
                raise ValueError("Raster download URL was not returned.")

            with urlopen(download_url, timeout=120) as response:
                return response.read(), filename, scale
        except HTTPError as error:
            error_text = error.read().decode("utf-8", errors="replace")
            last_error = error_text or str(error)
            if not _is_download_size_limit_error(last_error):
                break
        except Exception as error:
            last_error = str(error)
            if not _is_download_size_limit_error(last_error):
                break

    if _is_download_size_limit_error(last_error):
        raise RuntimeError(
            "The selected AOI is too large or complex for a direct GeoTIFF download: "
            "Earth Engine rejected the request because its pixel grid or request payload "
            "still exceeded the direct-download limit at the coarsest available resolution. "
            "Try a smaller or simpler AOI."
        )

    raise RuntimeError(last_error or "Raster download failed.")


def get_flood_hotspot_map_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    permanent_water_layer, flood_frequency_map, permanent_water_visual, flood_visual = (
        _build_flood_hotspot_images(payload, region)
    )
    content: Dict[str, Any] = {}
    attach_map_id(content, "Flood", flood_visual.getMapId())
    attach_map_id(content, "Water", permanent_water_visual.getMapId())
    _attach_supplementary_map_layers(content, region)
    return content


def _build_flood_hotspot_images(payload: Dict[str, Any], region: ee.Geometry) -> tuple[ee.Image, ee.Image, ee.Image, ee.Image]:
    basic_layer_catalog = get_basic_layer_catalog()
    hotspot_catalog = basic_layer_catalog["hotspot"]
    year_start, year_end, year_count = _get_jrc_year_range_from_payload(payload)

    water_esa2 = ee.ImageCollection(hotspot_catalog["worldCoverPrimaryWater"]["dataset"]).first().eq(
        hotspot_catalog["worldCoverPrimaryWater"]["classValue"]
    ).selfMask()
    water_esa1 = ee.ImageCollection(hotspot_catalog["worldCoverLegacyWater"]["dataset"]).first().eq(
        hotspot_catalog["worldCoverLegacyWater"]["classValue"]
    ).selfMask()
    water_history = ee.ImageCollection(hotspot_catalog["jrcYearlyHistory"]["dataset"]).filter(
        ee.Filter.calendarRange(year_start, year_end, "year")
    )

    masks = water_history.map(lambda image: image.select("waterClass").eq(3))
    permanent_water = masks.sum()
    permanent_water_frequency = permanent_water.divide(year_count)
    permanent_water_frequency_map = permanent_water_frequency.gt(0).selfMask()
    permanent_water_layer = ee.ImageCollection(
        [
            water_esa1.rename("waterClass"),
            water_esa2.rename("waterClass"),
            permanent_water_frequency_map,
        ]
    ).mosaic().clip(region)

    binary_masks = water_history.map(lambda image: image.select("waterClass").eq(2))
    years_with_water = binary_masks.sum()
    flood_frequency = years_with_water.divide(year_count)
    flood_frequency_map = flood_frequency.where(permanent_water_layer.eq(1), 0).selfMask().clip(region)
    flood_frequency_map = flood_frequency_map.where(flood_frequency_map.gt(0.9), 0.90)

    permanent_water_visual = visualize_image(
        permanent_water_layer.select("waterClass"), hotspot_catalog["water"]["visualization"]
    )
    flood_visual = visualize_image(
        flood_frequency_map.select("waterClass"), hotspot_catalog["floodFrequency"]["visualization"]
    )

    return permanent_water_layer, flood_frequency_map, permanent_water_visual, flood_visual


def get_water_regime_change_map_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    basic_layer_catalog = get_basic_layer_catalog()
    regime_catalog = basic_layer_catalog["waterRegimeChange"]
    supplementary_catalog = basic_layer_catalog["supplementary"]

    transition = ee.Image(regime_catalog["jrcGlobalSurfaceWater"]["dataset"]).select(
        regime_catalog["jrcGlobalSurfaceWater"]["band"]
    ).clip(region)
    transition_classes = regime_catalog["transitionClasses"]
    regime_change = transition.remap(
        transition_classes["sourceValues"],
        transition_classes["displayValues"],
    )
    regime_change = regime_change.updateMask(regime_change.gt(0))
    regime_change = visualize_image(regime_change, regime_catalog["visualization"])

    seasonality = ee.Image(supplementary_catalog["seasonality"]["dataset"]).select(
        supplementary_catalog["seasonality"]["band"]
    ).clip(region)
    seasonality = seasonality.updateMask(seasonality.gt(0))
    seasonality = visualize_image(
        seasonality, supplementary_catalog["seasonality"]["visualization"]
    )

    content: Dict[str, Any] = {}
    attach_map_id(content, "RegimeChange", regime_change.getMapId())
    attach_map_id(content, "Seasonality", seasonality.getMapId())
    _attach_supplementary_map_layers(content, region)
    return content


def _configure_openai() -> None:
    openai.api_key = required_env("OPENAI_API_KEY")
    openai.api_base = required_env("OPENAI_API_BASE")


def _get_llm_model() -> str:
    return required_env("LLM_MODEL")


def _create_chat_completion(model: str, messages: list[dict[str, str]], functions: Optional[list[dict[str, Any]]] = None):
    api_key = required_env("OPENAI_API_KEY")
    api_base = required_env("OPENAI_API_BASE")

    if OpenAI is not None:
        client = OpenAI(api_key=api_key, base_url=api_base)
        request_kwargs: Dict[str, Any] = {
            "model": model,
            "messages": messages,
        }
        if functions:
            request_kwargs["functions"] = functions
        return client.chat.completions.create(**request_kwargs)

    _configure_openai()
    return openai.ChatCompletion.create(
        model=model,
        messages=messages,
        functions=functions,
    )


def _extract_function_call_arguments(completion: Any) -> Optional[str]:
    try:
        message = completion.choices[0].message
    except Exception:
        return None

    function_call = getattr(message, "function_call", None)
    if function_call and getattr(function_call, "arguments", None):
        return function_call.arguments

    tool_calls = getattr(message, "tool_calls", None) or []
    if tool_calls:
        function = getattr(tool_calls[0], "function", None)
        if function and getattr(function, "arguments", None):
            return function.arguments

    if isinstance(message, dict):
        function_call = message.get("function_call") or {}
        if function_call.get("arguments"):
            return function_call["arguments"]

        tool_calls = message.get("tool_calls") or []
        if tool_calls:
            function = tool_calls[0].get("function") or {}
            if function.get("arguments"):
                return function["arguments"]

    return None


def get_chatgpt_response(user_input: str) -> Optional[str]:
    prompt = f"""
    {user_input}
    Provide detailed information about the affected areas in JSON format.
    IMPORTANT: The content in your response must be totaling around 700 characters.
    Include details such as the start date, end date in 'yyyy-mm-dd' format,
    along with the country code (Two Capital Characters, e.g., 'PK') in the following structure:
    'start_date': ,
    'end_date': ,
    'CountryCode': ,
    'content':
    """
    completion = _create_chat_completion(
        model=_get_llm_model(),
        messages=[
            {"role": "system", "content": "You are a helpful GEE Assistant."},
            {"role": "user", "content": prompt},
        ],
        functions=[{
            "name": "dummy_fn_flood_response",
            "parameters": {
                "type": "object",
                "properties": {
                    "response": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "start_date": {"type": "string"},
                                "end_date": {"type": "string"},
                                "CountryCode": {"type": "string"},
                                "Content": {"type": "string"},
                            },
                        },
                    }
                },
            },
        }],
    )
    return _extract_function_call_arguments(completion)


def get_code_response(user_input: str) -> Optional[str]:
    prompt = f"""
   Provide a complete script/code in JSON Format for accessing data related to the {user_input} flood using Google Earth Engine (GEE) in the following JSON structure.
   e.g 'script':
            'content':
    """
    completion = _create_chat_completion(
        model=_get_llm_model(),
        messages=[
            {"role": "system", "content": "You are a helpful GEE Assistant."},
            {"role": "user", "content": prompt},
        ],
        functions=[{
            "name": "dummy_fn_flood_response",
            "parameters": {
                "type": "object",
                "properties": {
                    "response": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "script": {"type": "string"},
                            },
                        },
                    }
                },
            },
        }],
    )
    try:
        assistant_response = _extract_function_call_arguments(completion)
        json_data = json.loads(assistant_response)
        return json_data["response"][0]["script"]
    except Exception:
        return None


def build_script_pdf(script: str) -> bytes:
    formatted_code_lines = []
    for line in script.splitlines():
        while len(line) > 80:
            formatted_code_lines.append(line[:80])
            line = line[80:]
        formatted_code_lines.append(line)
    formatted_code = "\n".join(formatted_code_lines)

    code_chunks = [
        formatted_code[i:i + 1300]
        for i in range(0, len(formatted_code), 1300)
    ]

    buffer = BytesIO()
    document = SimpleDocTemplate(buffer, pagesize=letter)
    document.title = "GEE Script"
    story = []

    styles = getSampleStyleSheet()
    story.append(Paragraph("GEE Script", styles["Title"]))
    story.append(Spacer(1, 12))

    table_style = TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.black),
        ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 20),
        ("RIGHTPADDING", (0, 0), (-1, -1), 20),
        ("TOPPADDING", (0, 0), (-1, -1), 10),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 10),
        ("ALIGN", (0, 0), (-1, -1), "LEFT"),
    ])

    temp_canvas = canvas.Canvas(BytesIO())
    for code in code_chunks:
        code_table = Table([[code]], style=table_style, colWidths=[600])
        code_table.wrapOn(temp_canvas, 0, 0)
        story.append(code_table)
        story.append(Spacer(1, 12))

    document.build(story)
    buffer.seek(0)
    return buffer.read()
