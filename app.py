import time
from flask import Flask
from flask import Response
from flask import jsonify
from flask import request
from flask import send_from_directory
from datetime import datetime, timedelta
import uuid
## Server .py 
import json
import os

import config
import ee

import socket
import re
from flask_cors import CORS
import openai
try:
    from openai import OpenAI
except ImportError:  # pragma: no cover - old openai SDK
    OpenAI = None

"""GOOGLE DRIVE START"""
import pickle
import os.path
from googleapiclient.discovery import build
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request

from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Table, TableStyle, Spacer, Paragraph
from reportlab.lib import colors
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus.doctemplate import SimpleDocTemplate
from io import BytesIO
# https://developers.google.com/analytics/devguides/config/mgmt/v3/quickstart/service-py
from oauth2client.service_account import ServiceAccountCredentials
"""GOOGLE DRIVE END"""

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
LAYER_CATALOG_PATH = os.path.join(BASE_DIR, 'frontend', 'src', 'config', 'layerCatalog.json')
FRONTEND_BUILD_DIR = os.path.join(BASE_DIR, 'frontend', 'build')
FRONTEND_BUILD_STATIC_DIR = os.path.join(FRONTEND_BUILD_DIR, 'static')



# Initialization
# ------------------------------------------------------------------------------------ #

# Memcache is used to avoid exceeding our EE quota. Entries in the cache expire
# 24 hours after they are added. See:
# https://cloud.google.com/appengine/docs/python/memcache/
MEMCACHE_EXPIRATION = 60 * 60 * 24

# The URL fetch timeout time (seconds).
URL_FETCH_TIMEOUT = 600000

ee.Initialize(config.EE_CREDENTIALS)
ee.data.setDeadline(URL_FETCH_TIMEOUT)
socket.setdefaulttimeout(URL_FETCH_TIMEOUT)

openai.api_key = config.CHATGPT_API_KEY

## GEOMETRIES
AoI        = ee.FeatureCollection("projects/servir-mekong/SWMT/AoI")
#AoI        = ee.FeatureCollection("ft:1RUtGuo9OZU2IdLTICNc7iif4dxgOMIsvWoyPvPJa")
Adm_bounds = ee.FeatureCollection("projects/servir-mekong/SWMT/Adm_bounds")
Tiles      = ee.FeatureCollection("projects/servir-mekong/SWMT/Tiles")


# # Landsat band names
# LC457_BANDS = ['B1',    'B1',   'B2',    'B3',  'B4',  'B5',    'B7']
# LC8_BANDS   = ['B1',    'B2',   'B3',    'B4',  'B5',  'B6',    'B7']
# STD_NAMES   = ['blue2', 'blue', 'green', 'red', 'nir', 'swir1', 'swir2']

app = Flask(
    __name__,
    static_folder=FRONTEND_BUILD_STATIC_DIR,
    static_url_path='/static',
)


def get_allowed_cors_origins():
    configured = os.getenv("SATGPT_CORS_ORIGINS", "").strip()
    if configured:
        return [origin.strip() for origin in configured.split(",") if origin.strip()]

    frontend_port = os.getenv("FRONTEND_PORT", "3000")
    public_host = os.getenv("SATGPT_PUBLIC_HOST", "localhost").strip() or "localhost"
    origins = {
        f"http://localhost:{frontend_port}",
        f"http://127.0.0.1:{frontend_port}",
    }

    if public_host not in {"localhost", "127.0.0.1", "0.0.0.0"}:
        origins.add(f"http://{public_host}:{frontend_port}")

    return sorted(origins)


def create_chat_completion(model, messages, functions=None):
    api_key = os.getenv("OPENAI_API_KEY") or os.getenv("CHATGPT_API_KEY")
    api_base = os.getenv("OPENAI_API_BASE")

    if OpenAI is not None:
        client_kwargs = {}
        if api_key:
            client_kwargs["api_key"] = api_key
        if api_base:
            client_kwargs["base_url"] = api_base

        client = OpenAI(**client_kwargs)
        request_kwargs = {
            "model": model,
            "messages": messages,
        }
        if functions:
            request_kwargs["functions"] = functions
        return client.chat.completions.create(**request_kwargs)

    openai.api_key = api_key
    if api_base:
        openai.api_base = api_base
    return openai.ChatCompletion.create(
        model=model,
        messages=messages,
        functions=functions,
    )


def extract_function_call_arguments(completion):
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
        legacy_function_call = message.get("function_call") or {}
        if legacy_function_call.get("arguments"):
            return legacy_function_call["arguments"]

        legacy_tool_calls = message.get("tool_calls") or []
        if legacy_tool_calls:
            function = legacy_tool_calls[0].get("function") or {}
            if function.get("arguments"):
                return function["arguments"]

    return None
# Enable CORS for all origins（兼容本机开发与局域网访问）
CORS(app, resources={r"/*": {"origins": get_allowed_cors_origins()}})


def load_layer_catalog():
    with open(LAYER_CATALOG_PATH, 'r', encoding='utf-8') as handle:
        return json.load(handle)


LAYER_CATALOG = load_layer_catalog()
BASIC_LAYER_CATALOG = LAYER_CATALOG["basic"]


def get_basic_layer_catalog():
    return load_layer_catalog()["basic"]


def get_bounds_from_ring(coordinates):
    lngs = [point[0] for point in coordinates]
    lats = [point[1] for point in coordinates]
    return {
        "west": min(lngs),
        "south": min(lats),
        "east": max(lngs),
        "north": max(lats),
    }


def build_aoi_from_legacy_coords(coordinates):
    return {
        "version": 1,
        "source": "legacy_polygon",
        "kind": "polygon",
        "bounds": get_bounds_from_ring(coordinates),
        "geojson": {
            "type": "Polygon",
            "coordinates": [coordinates],
        },
        "legacy": {
            "AoI_cords": coordinates,
        },
    }


def extract_geojson_geometry(geojson):
    if not isinstance(geojson, dict):
        return None

    geo_type = geojson.get("type")
    if geo_type == "FeatureCollection":
        features = geojson.get("features") or []
        return extract_geojson_geometry(features[0]) if features else None
    if geo_type == "Feature":
        return geojson.get("geometry")

    return geojson


def is_valid_bounds(bounds):
    if not isinstance(bounds, dict):
        return False

    required_keys = {"west", "south", "east", "north"}
    return required_keys.issubset(bounds.keys())


def parse_aoi_from_request_args(args):
    serialized_aoi = args.get("aoi")
    if serialized_aoi:
        aoi = json.loads(serialized_aoi)
        if isinstance(aoi, dict):
            return aoi

    legacy_coords = args.get("AoI_cords")
    if legacy_coords:
        return build_aoi_from_legacy_coords(json.loads(legacy_coords))

    raise ValueError("Missing AOI definition. Expected 'aoi' or legacy 'AoI_cords'.")


def get_request_payload():
    if request.method == 'POST':
        payload = request.get_json(silent=True) or {}
        return payload if isinstance(payload, dict) else {}
    return request.args


def aoi_to_ee_geometry(aoi):
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

    legacy_coords = (aoi.get("legacy") or {}).get("AoI_cords")
    if legacy_coords:
        return ee.Geometry.Polygon(legacy_coords)

    raise ValueError("AOI payload does not include geojson, bounds, or legacy coordinates.")


def visualize_image(image, vis_params):
    return image.visualize(
        min=vis_params["min"],
        max=vis_params["max"],
        palette=vis_params["palette"],
    )


def attach_map_id(content, key, map_id):
    content[f'eeMapId{key}'] = map_id['mapid']
    content[f'eeToken{key}'] = map_id['token']
    content[f'eeMapURL{key}'] = map_id['tile_fetcher'].url_format

@app.route('/flask-health-check', methods=['GET'])
def health_check():
    return "healthy", 200

@app.route('/get_default')
def getDefaultHandler():
    default = SurfaceWaterToolStyle(ee.Image('users/arjenhaag/SERVIR-Mekong/SWMT_default_2017_2')).getMapId()
    content = {
        'eeMapId': default['mapid'],
        'eeToken': default['token'],
        'eeMapURL': default['tile_fetcher'].url_format,
    }
    response = Response()
    response.headers['Content-Type'] = 'application/json'
    response.data = json.dumps(content)
    return response

@app.route('/get_unsupervised_map', methods=['GET', 'POST'])
def getUnsupervisedHandler():
    payload = get_request_payload()
    aoi = parse_aoi_from_request_args(payload)
    region = aoi_to_ee_geometry(aoi)
    unsupervised_catalog = get_basic_layer_catalog()["unsupervised"]
    permanent_water_catalog = unsupervised_catalog["globalSurfaceWater"]

    time_start   = payload.get('time_start')
    time_end     = payload.get('time_end')
    collection = ee.ImageCollection('LANDSAT/LE07/C01/T1_SR')\
               .filterBounds(region)\
               .filterDate(time_start, time_end)
    def computeNDWI(image):
        ndwi = image.normalizedDifference(['B2', 'B4']).rename('NDWI')
        return image.addBands(ndwi)
    
    landsatNDWI = collection.map(computeNDWI)
    medianNDWI = landsatNDWI.median().clip(region)
    gsw = ee.Image(permanent_water_catalog["dataset"])
    occurrence = gsw.select(permanent_water_catalog["band"])
    waterMask = occurrence.gte(permanent_water_catalog["threshold"])
    maskedResult = medianNDWI.updateMask(waterMask)
    training = maskedResult.select('NDWI').sample(
        region=region,
        scale=30,
        numPixels=5000
    )

    clusterer = ee.Clusterer.wekaKMeans(3).train(training)
    result = maskedResult.cluster(clusterer)



    palette = ['blue','green', 'red']

    # color_palette =  [ 'green', 'red','blue']


    color_image = result.visualize(min=0, max=1, palette=palette)

    mapid = color_image.getMapId()
    content ={ 
        'eeMapId': mapid['mapid'],
        'eeToken': mapid['token'],
        'eeMapURL': mapid['tile_fetcher'].url_format,
    }
    # send content using json
    response = Response()
    response.headers['Content-Type'] = 'application/json'
    response.data = json.dumps(content)
    return response
  
@app.route('/get_historical_map', methods=['GET', 'POST'])
def getHistoricalHandler():
    payload = get_request_payload()
    aoi = parse_aoi_from_request_args(payload)
    region = aoi_to_ee_geometry(aoi)
    basic_layer_catalog = get_basic_layer_catalog()
    historical_catalog = basic_layer_catalog["historical"]
    supplementary_catalog = basic_layer_catalog["supplementary"]

    time_start   = payload.get('time_start')
    time_end     = payload.get('time_end')
    start_year = int(time_start.split("-")[0])
    end_year = int(time_end.split("-")[0])

    jrcSurfaceWater = ee.ImageCollection(historical_catalog["jrcYearlyHistory"]["dataset"]) \
        .filter(ee.Filter.calendarRange(start_year, end_year, 'year')) \
        .map(lambda image: image.select(historical_catalog["water"]["band"]).eq(historical_catalog["water"]["matchValue"])) \
        .sum() \
        .clip(region)
    jrcSurfaceWater = jrcSurfaceWater.updateMask(jrcSurfaceWater.gt(0)) 
    jrcSurfaceWater = visualize_image(jrcSurfaceWater, historical_catalog["water"]["visualization"])
                   
    jrcSurfaceFlood = ee.ImageCollection(historical_catalog["jrcYearlyHistory"]["dataset"]) \
        .filter(ee.Filter.calendarRange(start_year, end_year, 'year')) \
        .map(lambda image: image.select(historical_catalog["flood"]["band"]).eq(historical_catalog["flood"]["matchValue"])) \
        .sum() \
        .clip(region)

    jrcSurfaceFlood = jrcSurfaceFlood.updateMask(jrcSurfaceFlood.gt(0)) 
    jrcSurfaceFlood = visualize_image(jrcSurfaceFlood, historical_catalog["flood"]["visualization"])

    LCLU = ee.ImageCollection(supplementary_catalog["landcover"]["dataset"]).first().clip(region)

    PopulationDensity = ee.Image(supplementary_catalog["populationDensity"]["dataset"]).clip(region);
    PopulationDensity = visualize_image(PopulationDensity, supplementary_catalog["populationDensity"]["visualization"])

    SoilTexture = ee.Image(supplementary_catalog["soilTexture"]["dataset"]).clip(region).select(supplementary_catalog["soilTexture"]["band"])
    SoilTexture = visualize_image(SoilTexture, supplementary_catalog["soilTexture"]["visualization"])

    HealthCareAccess = ee.Image(supplementary_catalog["healthCareAccess"]["dataset"]).select(supplementary_catalog["healthCareAccess"]["band"]).clip(region)
    HealthCareAccess = visualize_image(HealthCareAccess, supplementary_catalog["healthCareAccess"]["visualization"])
    
    mapIdWater = jrcSurfaceWater.getMapId()
    mapIdFlood = jrcSurfaceFlood.getMapId()
    mapIdLCLU = LCLU.getMapId()
    mapIdPopulationDensity = PopulationDensity.getMapId()
    mapIdSoilTexture = SoilTexture.getMapId()
    mapIdHealthCareAccess = HealthCareAccess.getMapId()


    content = { 
    }
    attach_map_id(content, 'Flood', mapIdFlood)
    attach_map_id(content, 'Water', mapIdWater)
    attach_map_id(content, 'LCLU', mapIdLCLU)
    attach_map_id(content, 'PopulationDensity', mapIdPopulationDensity)
    attach_map_id(content, 'SoilTexture', mapIdSoilTexture)
    attach_map_id(content, 'HealthCareAccess', mapIdHealthCareAccess)

    # send content using json
    response = Response()
    response.headers['Content-Type'] = 'application/json'
    response.data = json.dumps(content)
    return response
  
@app.route('/get_flood_hotspot_map', methods=['GET', 'POST'])
def getFloodHotspotHandler():
    payload = get_request_payload()
    aoi = parse_aoi_from_request_args(payload)
    region = aoi_to_ee_geometry(aoi)
    basic_layer_catalog = get_basic_layer_catalog()
    hotspot_catalog = basic_layer_catalog["hotspot"]
    supplementary_catalog = basic_layer_catalog["supplementary"]
    year_from = int(payload.get('year_from'))
    year_count = int(payload.get('year_count'))
    year_to = year_from + year_count 
    
    WaterESA2 = ee.ImageCollection(hotspot_catalog["worldCoverPrimaryWater"]["dataset"]).first().eq(hotspot_catalog["worldCoverPrimaryWater"]["classValue"]).selfMask()
    WaterESA1 = ee.ImageCollection(hotspot_catalog["worldCoverLegacyWater"]["dataset"]).first().eq(hotspot_catalog["worldCoverLegacyWater"]["classValue"]).selfMask()
    waterHistory = ee.ImageCollection(hotspot_catalog["jrcYearlyHistory"]["dataset"]).filter(ee.Filter.calendarRange(year_from, year_to, 'year'))

    masks = waterHistory.map(lambda image: image.select('waterClass').eq(3))

    PermanentWater = masks.sum()
    PermanentWaterFrequency = PermanentWater.divide(year_count);
    PermanentWaterFrequencyMap = PermanentWaterFrequency.gt(0).selfMask()
    PermanentWaterLayer = ee.ImageCollection([WaterESA1.rename('waterClass'),WaterESA2.rename('waterClass'), PermanentWaterFrequencyMap]).mosaic().clip(region);

    binary_masks = waterHistory.map(lambda image: image.select('waterClass').eq(2))
    yearsWithWater = binary_masks.sum()
    floodFrequency = yearsWithWater.divide(year_count);
    floodFrequencyMap = floodFrequency.where(PermanentWaterLayer.eq(1),0).selfMask().clip(region)
    floodFrequencyMapMasked = floodFrequencyMap.updateMask(floodFrequencyMap.lte(0.91))
    minMax = floodFrequencyMap.reduceRegion(ee.Reducer.minMax(), region);
    floodFrequencyMap = floodFrequencyMap.where(floodFrequencyMap.gt(0.9),0.90)

    permanentWaterLayer = visualize_image(PermanentWaterLayer.select('waterClass'), hotspot_catalog["water"]["visualization"])
    floodLayer = visualize_image(floodFrequencyMap.select('waterClass'), hotspot_catalog["floodFrequency"]["visualization"])

    LCLU = ee.ImageCollection(supplementary_catalog["landcover"]["dataset"]).first().clip(region)

    PopulationDensity = ee.Image(supplementary_catalog["populationDensity"]["dataset"]).clip(region);
    PopulationDensity = visualize_image(PopulationDensity, supplementary_catalog["populationDensity"]["visualization"])

    SoilTexture = ee.Image(supplementary_catalog["soilTexture"]["dataset"]).clip(region).select(supplementary_catalog["soilTexture"]["band"])
    SoilTexture = visualize_image(SoilTexture, supplementary_catalog["soilTexture"]["visualization"])

    HealthCareAccess = ee.Image(supplementary_catalog["healthCareAccess"]["dataset"]).select(supplementary_catalog["healthCareAccess"]["band"]).clip(region)
    HealthCareAccess = visualize_image(HealthCareAccess, supplementary_catalog["healthCareAccess"]["visualization"])

    mapIdWater = permanentWaterLayer.getMapId()
    mapIdFlood = floodLayer.getMapId()
    mapIdLCLU = LCLU.getMapId()
    mapIdPopulationDensity = PopulationDensity.getMapId()
    mapIdSoilTexture = SoilTexture.getMapId()
    mapIdHealthCareAccess = HealthCareAccess.getMapId()

    content = {}
    attach_map_id(content, 'Flood', mapIdFlood)
    attach_map_id(content, 'Water', mapIdWater)
    attach_map_id(content, 'LCLU', mapIdLCLU)
    attach_map_id(content, 'PopulationDensity', mapIdPopulationDensity)
    attach_map_id(content, 'SoilTexture', mapIdSoilTexture)
    attach_map_id(content, 'HealthCareAccess', mapIdHealthCareAccess)

    # send content using json
    response = Response()
    response.headers['Content-Type'] = 'application/json'
    response.data = json.dumps(content)
    return response

def SurfaceWaterToolStyle(map):
    water_style = '\
    <RasterSymbolizer>\
      <ColorMap extended="true" >\
        <ColorMapEntry color="#FD0303" quantity="2.0" label="-1"/>\
        <ColorMapEntry color="#00008B" quantity="3.0" label="-1"/>\
      </ColorMap>\
    </RasterSymbolizer>'
    return map.sldStyle(water_style)


def gpt_response(user_input):
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
    completion = create_chat_completion(
        model="gpt-3.5-turbo",
        messages=[
            {"role": "system", "content": "You are a helpful GEE Assistant."},
            {"role": "user", "content": prompt},
        ],
        functions=[{"name": "dummy_fn_flood_response", "parameters": {
          "type": "object",
          "properties": {
            "response": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "start_date": {"type": "string", "description": "Start date of the flood event (yyyy-mm-dd)"},
                  "end_date": {"type": "string", "description": "End date of the flood event (yyyy-mm-dd)"},
                  "CountryCode": {"type": "string", "description": "Two-letter country code (e.g., 'CN') of the affected country"},
                  "Content": {"type": "string", "description": "The Information about the Flood"},
                }
              }
            }
          }
        }}],
    )
    try:
        generated_text = extract_function_call_arguments(completion)
        return generated_text
    except Exception as e:
        print(f"An error occurred: {e}")
        return None
      
@app.route('/chatGPT', methods=['POST'])
def chatgpt_post():
    data = request.get_json()
    message = data['message']

    chatgpt_response = gpt_response(message)
    if not chatgpt_response:
        return jsonify({'error': 'Error with ChatGPT'}), 500
    return jsonify({'message': chatgpt_response}), 200


code_snippets = None 
@app.route('/get_script', methods=['POST'])
def getGEEScript():
    global code_snippets
    data = request.get_json()
    message = data['message'] 
    code_snippets = get_code_response(message)
    if not code_snippets:
        return jsonify({'error': 'Error with ChatGPT'}), 500

    return jsonify({'message': code_snippets}), 200

@app.route('/get_pdf', methods=['GET'])
def generatePDF():
    global code_snippets
    print(code_snippets)
    if not code_snippets:
         return jsonify({'error': 'Error with ChatGPT'}), 500
    max_line_length = 80
    lines = code_snippets.splitlines()
    formatted_code = []

    for line in lines:
      while len(line) > max_line_length:
          formatted_code.append(line[:max_line_length])
          line = line[max_line_length:]
      formatted_code.append(line)
    formatted_code = "\n".join(formatted_code)
    if not code_snippets:
        return jsonify({'error': 'Error in Script'}), 500
    character_limit = 1300  # Adjust this as needed
    code_chunks = [formatted_code[i:i + character_limit] for i in range(0, len(formatted_code), character_limit)]


    buffer = BytesIO()

    # Create a list to hold the content
    document = SimpleDocTemplate(buffer, pagesize=letter)
    document.title = "GEE Script"
    # Create a list of flowables (elements to be added to the PDF)
    story = []

    styles = getSampleStyleSheet()
    code_style = styles["Code"]
    code_style.leading = 14  # Adjust line spacing as needed

    # Title
    title = "GEE Script"
    title_paragraph = Paragraph(title, styles["Title"])
    story.append(title_paragraph)
    story.append(Spacer(1, 12)) 

    # Define the container padding
    container_padding = 20  # Adjust as needed

    # Define a table style with a black background and padding
    table_style = TableStyle(
        [
            ("BACKGROUND", (0, 0), (-1, -1), colors.black),
            ("TEXTCOLOR", (0, 0), (-1, -1), colors.white),
            ("LEFTPADDING", (0, 0), (-1, -1), container_padding),
            ("RIGHTPADDING", (0, 0), (-1, -1), container_padding),
            ("TOPPADDING", (0, 0), (-1, -1), container_padding // 2),  
            ("BOTTOMPADDING", (0, 0), (-1, -1), container_padding // 2),  
            ("ALIGN", (0, 0), (-1, -1), "LEFT"),
        ]
    )
    container_width = 600
    # Create a temporary canvas to calculate the dimensions
    from reportlab.pdfgen import canvas
    temp_canvas = canvas.Canvas("temp.pdf")
    for code in code_chunks:
      # Create a table for code snippets with a dynamic width
      code_table = Table([[code]], style=table_style,colWidths=[container_width])
        
      code_table.wrapOn(temp_canvas, 0, 0)
      # Add the code table to the story
      story.append(code_table)
      story.append(Spacer(1, 12))  # Add some space between code snippets

    # Build the PDF document
    document.build(story)

    # Set up the buffer for reading
    buffer.seek(0)
    response = Response(buffer, content_type='application/pdf')
    response.headers['Content-Disposition'] = 'attachment; filename=GEE_Script.pdf'

    return response

def get_code_response(user_input):
    prompt = f"""
   Provide a complete script/code in JSON Format for accessing data related to the {user_input} flood using Google Earth Engine (GEE) in the following JSON structure.
   e.g 'script': 
            'content':
    """
    completion = create_chat_completion(
        model="gpt-3.5-turbo",
        messages=[
            {"role": "system", "content": "You are a helpful GEE Assistant."},
            {"role": "user", "content": prompt},
        ],
        functions=[{"name": "dummy_fn_flood_response", "parameters": {
          "type": "object",
          "properties": {
            "response": {
              "type": "array",
              "items": {
                "type": "object",
                "properties": {
                  "script": {"type":"string", "description": "The GEE script to visulaize the flood"},
                }
              }
            }
          }
        }}],
    )
    try:
        assistant_response = extract_function_call_arguments(completion)
        json_data = json.loads(assistant_response)
        generated_script = json_data["response"][0]["script"]
        return generated_script
    except Exception as e:
        print(f"An error occurred: {e}")
        return None

# flood layer visualization
def flood_style(map):
    water_style = '\
    <RasterSymbolizer>\
      <ColorMap extended="true" >\
        <ColorMapEntry color="#fd0303" quantity="1.0" label="1"/>\
      </ColorMap>\
    </RasterSymbolizer>'
    return map.sldStyle(water_style)
  
# water layer visualization
def water_style(map):
    water_style = '\
    <RasterSymbolizer>\
      <ColorMap extended="true" >\
        <ColorMapEntry color="#00008b" quantity="1.0" label="-1"/>\
      </ColorMap>\
    </RasterSymbolizer>'
    return map.sldStyle(water_style)

# water hotspots layer visualization
def hotspots_style(map):
    water_style = '\
    <RasterSymbolizer>\
      <ColorMap extended="true" >\
        <ColorMapEntry color="#f2e947" quantity="1.0" label="-1"/>\
      </ColorMap>\
    </RasterSymbolizer>'
    return map.sldStyle(water_style)


@app.route("/", defaults={"path": ""})
@app.route("/<path:path>")
def serve_frontend(path):
    requested_path = os.path.join(FRONTEND_BUILD_DIR, path)

    if path and os.path.isfile(requested_path):
        return send_from_directory(FRONTEND_BUILD_DIR, path)

    index_file = os.path.join(FRONTEND_BUILD_DIR, "index.html")
    if os.path.isfile(index_file):
        return send_from_directory(FRONTEND_BUILD_DIR, "index.html")

    return (
        "React build not found. Run `npm run build` in the frontend directory before serving the SPA.",
        503,
    )

if __name__ == "__main__":
    host = os.environ.get("FLASK_RUN_HOST", "0.0.0.0")
    port = int(os.environ.get("FLASK_RUN_PORT", 5001))
    app.run(host=host, port=port, debug=False)
