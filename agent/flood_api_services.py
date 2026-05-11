import json
import os
import threading
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Optional

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


ROOT_DIR = Path(__file__).resolve().parents[1]
LAYER_CATALOG_PATH = ROOT_DIR / "frontend" / "src" / "config" / "layerCatalog.json"

_LATEST_SCRIPT_LOCK = threading.Lock()
_LATEST_SCRIPT: Optional[str] = None


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


def get_historical_map_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    basic_layer_catalog = get_basic_layer_catalog()
    historical_catalog = basic_layer_catalog["historical"]
    supplementary_catalog = basic_layer_catalog["supplementary"]

    time_start = str(payload.get("time_start"))
    time_end = str(payload.get("time_end"))
    start_year = int(time_start.split("-")[0])
    end_year = int(time_end.split("-")[0])

    jrc_surface_water = (
        ee.ImageCollection(historical_catalog["jrcYearlyHistory"]["dataset"])
        .filter(ee.Filter.calendarRange(start_year, end_year, "year"))
        .map(
            lambda image: image.select(historical_catalog["water"]["band"]).eq(
                historical_catalog["water"]["matchValue"]
            )
        )
        .sum()
        .clip(region)
    )
    jrc_surface_water = jrc_surface_water.updateMask(jrc_surface_water.gt(0))
    jrc_surface_water = visualize_image(
        jrc_surface_water, historical_catalog["water"]["visualization"]
    )

    jrc_surface_flood = (
        ee.ImageCollection(historical_catalog["jrcYearlyHistory"]["dataset"])
        .filter(ee.Filter.calendarRange(start_year, end_year, "year"))
        .map(
            lambda image: image.select(historical_catalog["flood"]["band"]).eq(
                historical_catalog["flood"]["matchValue"]
            )
        )
        .sum()
        .clip(region)
    )
    jrc_surface_flood = jrc_surface_flood.updateMask(jrc_surface_flood.gt(0))
    jrc_surface_flood = visualize_image(
        jrc_surface_flood, historical_catalog["flood"]["visualization"]
    )

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

    content: Dict[str, Any] = {}
    attach_map_id(content, "Flood", jrc_surface_flood.getMapId())
    attach_map_id(content, "Water", jrc_surface_water.getMapId())
    attach_map_id(content, "LCLU", lclu.getMapId())
    attach_map_id(content, "PopulationDensity", population_density.getMapId())
    attach_map_id(content, "SoilTexture", soil_texture.getMapId())
    attach_map_id(content, "HealthCareAccess", healthcare_access.getMapId())
    return content


def get_agent_raster_layers_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
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
    content: Dict[str, Any] = {}
    attach_map_id(content, "LCLU", lclu.getMapId())
    attach_map_id(content, "PopulationDensity", population_density.getMapId())
    attach_map_id(content, "SoilTexture", soil_texture.getMapId())
    return content


def get_flood_hotspot_map_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    aoi = parse_aoi_from_payload(payload)
    region = aoi_to_ee_geometry(aoi)
    basic_layer_catalog = get_basic_layer_catalog()
    hotspot_catalog = basic_layer_catalog["hotspot"]
    supplementary_catalog = basic_layer_catalog["supplementary"]
    year_from = int(payload.get("year_from"))
    year_count = int(payload.get("year_count"))
    year_to = year_from + year_count

    water_esa2 = ee.ImageCollection(hotspot_catalog["worldCoverPrimaryWater"]["dataset"]).first().eq(
        hotspot_catalog["worldCoverPrimaryWater"]["classValue"]
    ).selfMask()
    water_esa1 = ee.ImageCollection(hotspot_catalog["worldCoverLegacyWater"]["dataset"]).first().eq(
        hotspot_catalog["worldCoverLegacyWater"]["classValue"]
    ).selfMask()
    water_history = ee.ImageCollection(hotspot_catalog["jrcYearlyHistory"]["dataset"]).filter(
        ee.Filter.calendarRange(year_from, year_to, "year")
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

    permanent_water_layer = visualize_image(
        permanent_water_layer.select("waterClass"), hotspot_catalog["water"]["visualization"]
    )
    flood_layer = visualize_image(
        flood_frequency_map.select("waterClass"), hotspot_catalog["floodFrequency"]["visualization"]
    )

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

    content: Dict[str, Any] = {}
    attach_map_id(content, "Flood", flood_layer.getMapId())
    attach_map_id(content, "Water", permanent_water_layer.getMapId())
    attach_map_id(content, "LCLU", lclu.getMapId())
    attach_map_id(content, "PopulationDensity", population_density.getMapId())
    attach_map_id(content, "SoilTexture", soil_texture.getMapId())
    attach_map_id(content, "HealthCareAccess", healthcare_access.getMapId())
    return content


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

    content: Dict[str, Any] = {}
    attach_map_id(content, "RegimeChange", regime_change.getMapId())
    attach_map_id(content, "Seasonality", seasonality.getMapId())
    attach_map_id(content, "LCLU", lclu.getMapId())
    attach_map_id(content, "PopulationDensity", population_density.getMapId())
    attach_map_id(content, "SoilTexture", soil_texture.getMapId())
    attach_map_id(content, "HealthCareAccess", healthcare_access.getMapId())
    return content


def _configure_openai() -> None:
    openai.api_key = os.getenv("OPENAI_API_KEY")
    api_base = os.getenv("OPENAI_API_BASE")
    if api_base:
        openai.api_base = api_base


def _get_llm_model() -> str:
    return os.getenv("LLM_MODEL", "gpt-4o-mini")


def _create_chat_completion(model: str, messages: list[dict[str, str]], functions: Optional[list[dict[str, Any]]] = None):
    api_key = os.getenv("OPENAI_API_KEY")
    api_base = os.getenv("OPENAI_API_BASE")

    if OpenAI is not None:
        client_kwargs: Dict[str, Any] = {}
        if api_key:
            client_kwargs["api_key"] = api_key
        if api_base:
            client_kwargs["base_url"] = api_base

        client = OpenAI(**client_kwargs)
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


def remember_latest_script(script: str) -> None:
    global _LATEST_SCRIPT
    with _LATEST_SCRIPT_LOCK:
        _LATEST_SCRIPT = script


def get_latest_script() -> Optional[str]:
    with _LATEST_SCRIPT_LOCK:
        return _LATEST_SCRIPT


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
