import time
from flask import Flask
from flask import Response
from flask import render_template
from flask import request
from datetime import datetime, timedelta
import uuid
## Server .py 
import json
import os

import config
import ee
import jinja2

import socket
import json
import re
from flask import Blueprint, request, jsonify
from flask_cors import CORS
import openai

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

app = Flask(__name__)
# Enable CORS for React frontend
CORS(app, resources={r"/*": {"origins": ["http://localhost:3000", "http://127.0.0.1:3000"]}})

@app.route('/flask-health-check', methods=['GET'])
def health_check():
    return "healthy", 200

@app.route("/")
def mainHandler():
    return render_template('index.html'
                           ,GOOGLE_MAPS_API_KEY=config.GOOGLE_MAPS_API_KEY,
                            MAPBOX_ACCESS_KEY=config.MAPBOX_ACCESS_KEY
                           )
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

@app.route('/get_unsupervised_map')
def getUnsupervisedHandler():

    AoI_cords = json.loads(request.args.get('AoI_cords'))
    eeRing = ee.Geometry.Polygon(AoI_cords)
    AoI = ee.FeatureCollection(ee.Feature(eeRing))

    time_start   = request.args.get('time_start')
    time_end     = request.args.get('time_end')
    collection = ee.ImageCollection('LANDSAT/LE07/C01/T1_SR')\
               .filterBounds(AoI)\
               .filterDate(time_start, time_end)
    def computeNDWI(image):
        ndwi = image.normalizedDifference(['B2', 'B4']).rename('NDWI')
        return image.addBands(ndwi)
    
    landsatNDWI = collection.map(computeNDWI)
    medianNDWI = landsatNDWI.median().clip(AoI)
    gsw = ee.Image('JRC/GSW1_2/GlobalSurfaceWater')
    occurence = gsw.select('occurrence')
    waterMask = occurence.gte(90)
    maskedResult = medianNDWI.updateMask(waterMask)
    training = maskedResult.select('NDWI').sample(
        region=AoI,
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
  
@app.route('/get_historical_map')
def getHistoricalHandler():

    AoI_cords = json.loads(request.args.get('AoI_cords'))
    eeRing = ee.Geometry.Polygon(AoI_cords)
    AoI = ee.FeatureCollection(ee.Feature(eeRing))

    time_start   = request.args.get('time_start')
    time_end     = request.args.get('time_end')
    start_year = int(time_start.split("-")[0])
    end_year = int(time_end.split("-")[0])

    jrcSurfaceWater = ee.ImageCollection('JRC/GSW1_3/YearlyHistory') \
        .filter(ee.Filter.calendarRange(start_year, end_year, 'year')) \
        .map(lambda image: image.select('waterClass').eq(3)) \
        .sum() \
        .clip(AoI)
    jrcSurfaceWater = jrcSurfaceWater.updateMask(jrcSurfaceWater.gt(0)) 
    jrcSurfaceWater = jrcSurfaceWater.visualize(min=0, max=1, palette=['#00008B'])
                   
    jrcSurfaceFlood = ee.ImageCollection('JRC/GSW1_3/YearlyHistory') \
        .filter(ee.Filter.calendarRange(start_year, end_year, 'year')) \
        .map(lambda image: image.select('waterClass').eq(2)) \
        .sum() \
        .clip(AoI)

    jrcSurfaceFlood = jrcSurfaceFlood.updateMask(jrcSurfaceFlood.gt(0)) 
    jrcSurfaceFlood = jrcSurfaceFlood.visualize(min=0, max=1, palette=['#FD0303'])

    LCLU = ee.ImageCollection("ESA/WorldCover/v200").first().clip(AoI)

    PopulationDensity = ee.Image('CIESIN/GPWv411/GPW_UNWPP-Adjusted_Population_Density/gpw_v4_population_density_adjusted_to_2015_unwpp_country_totals_rev11_2020_30_sec').clip(AoI);
    PopulationDensity = PopulationDensity.visualize(min = 0.0, max = 1000,  palette = ['ffffe7','FFc869', 'ffac1d','e17735','f2552c', '9f0c21'])

    SoilTexture = ee.Image('OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02').clip(AoI).select('b10')
    SoilTexture = SoilTexture.visualize(min = 1.0, max = 12.0, palette = ['d5c36b','b96947','9d3706','ae868f','f86714','46d143','368f20','3e5a14','ffd557','fff72e','ff5a9d','ff005b'])

    HealthCareAccess = ee.Image('Oxford/MAP/accessibility_to_healthcare_2019').select('accessibility').clip(AoI)
    HealthCareAccess = HealthCareAccess.visualize(min = 1,  max = 60,  palette = ['FFF8DC', 'FFEBCD', 'FFDEAD', 'F5DEB3', 'DEB887', 'D2B48C', 'CD853F', '8B4513', 'A0522D', '8B4513'])
    
    mapIdWater = jrcSurfaceWater.getMapId()
    mapIdFlood = jrcSurfaceFlood.getMapId()
    mapIdLCLU = LCLU.getMapId()
    mapIdPopulationDensity = PopulationDensity.getMapId()
    mapIdSoilTexture = SoilTexture.getMapId()
    mapIdHealthCareAccess = HealthCareAccess.getMapId()


    content = { 
        'eeMapIdFlood': mapIdFlood['mapid'],
        'eeTokenFlood': mapIdFlood['token'],
        'eeMapURLFlood': mapIdFlood['tile_fetcher'].url_format,
        'eeMapIdWater': mapIdWater['mapid'],
        'eeTokenWater': mapIdWater['token'],
        'eeMapURLWater': mapIdWater['tile_fetcher'].url_format,
        'eeMapIdLCLU': mapIdLCLU['mapid'],
        'eeTokenLCLU': mapIdLCLU['token'],
        'eeMapURLLCLU': mapIdLCLU['tile_fetcher'].url_format,
        'eeMapIdPopulationDensity': mapIdPopulationDensity['mapid'],
        'eeTokenPopulationDensity': mapIdPopulationDensity['token'],
        'eeMapURLPopulationDensity': mapIdPopulationDensity['tile_fetcher'].url_format,
        'eeMapIdSoilTexture': mapIdSoilTexture['mapid'],
        'eeTokenSoilTexture': mapIdSoilTexture['token'],
        'eeMapURLSoilTexture': mapIdSoilTexture['tile_fetcher'].url_format,
        'eeMapIdHealthCareAccess': mapIdHealthCareAccess['mapid'],
        'eeTokenHealthCareAccess': mapIdHealthCareAccess['token'],
        'eeMapURLHealthCareAccess': mapIdHealthCareAccess['tile_fetcher'].url_format,
    }

    # send content using json
    response = Response()
    response.headers['Content-Type'] = 'application/json'
    response.data = json.dumps(content)
    return response
  
@app.route('/get_flood_hotspot_map')
def getFloodHotspotHandler():
    AoI_cords = json.loads(request.args.get('AoI_cords'))
    eeRing = ee.Geometry.Polygon(AoI_cords)
    AoI = ee.FeatureCollection(ee.Feature(eeRing))
    year_from = int(request.args.get('year_from'))
    year_count = int(request.args.get('year_count'))
    year_to = year_from + year_count 
    
    WaterESA2 = ee.ImageCollection("ESA/WorldCover/v200").first().eq(80).selfMask()#.clip(AoI)
    WaterESA1 = ee.ImageCollection("ESA/WorldCover/v100").first().eq(80).selfMask()#.clip(AoI)
    waterHistory = ee.ImageCollection("JRC/GSW1_4/YearlyHistory").filter(ee.Filter.calendarRange(year_from, year_to, 'year'))

    masks = waterHistory.map(lambda image: image.select('waterClass').eq(3))

    PermanentWater = masks.sum()
    PermanentWaterFrequency = PermanentWater.divide(year_count);
    PermanentWaterFrequencyMap = PermanentWaterFrequency.gt(0).selfMask()
    PermanentWaterLayer = ee.ImageCollection([WaterESA1.rename('waterClass'),WaterESA2.rename('waterClass'), PermanentWaterFrequencyMap]).mosaic().clip(AoI);

    binary_masks = waterHistory.map(lambda image: image.select('waterClass').eq(2))
    yearsWithWater = binary_masks.sum()
    floodFrequency = yearsWithWater.divide(year_count);
    floodFrequencyMap = floodFrequency.where(PermanentWaterLayer.eq(1),0).selfMask().clip(AoI)
    floodFrequencyMapMasked = floodFrequencyMap.updateMask(floodFrequencyMap.lte(0.91))
    minMax = floodFrequencyMap.reduceRegion(ee.Reducer.minMax(), AoI);
    floodFrequencyMap = floodFrequencyMap.where(floodFrequencyMap.gt(0.9),0.90)

    pink = ['#ffa9bb', '#ff9cac', '#ff8f9e', '#ff8190', '#ff7281', '#ff6171', '#ff4f61', '#ff3b50', '#ff084a']

    permanentWaterLayer = PermanentWaterLayer.select('waterClass').visualize(min=0, max=1, palette=['#00008B'])
    floodLayer = floodFrequencyMap.select('waterClass').visualize(min=0.1, max=0.8, palette=pink)

    LCLU = ee.ImageCollection("ESA/WorldCover/v200").first().clip(AoI)

    PopulationDensity = ee.Image('CIESIN/GPWv411/GPW_UNWPP-Adjusted_Population_Density/gpw_v4_population_density_adjusted_to_2015_unwpp_country_totals_rev11_2020_30_sec').clip(AoI);
    PopulationDensity = PopulationDensity.visualize(min = 0.0, max = 1000,  palette = ['ffffe7','FFc869', 'ffac1d','e17735','f2552c', '9f0c21'])

    SoilTexture = ee.Image('OpenLandMap/SOL/SOL_TEXTURE-CLASS_USDA-TT_M/v02').clip(AoI).select('b10')
    SoilTexture = SoilTexture.visualize(min = 1.0, max = 12.0, palette = ['d5c36b','b96947','9d3706','ae868f','f86714','46d143','368f20','3e5a14','ffd557','fff72e','ff5a9d','ff005b'])

    HealthCareAccess = ee.Image('Oxford/MAP/accessibility_to_healthcare_2019').select('accessibility').clip(AoI)
    HealthCareAccess = HealthCareAccess.visualize(min = 1,  max = 60,  palette = ['FFF8DC', 'FFEBCD', 'FFDEAD', 'F5DEB3', 'DEB887', 'D2B48C', 'CD853F', '8B4513', 'A0522D', '8B4513'])

    mapIdWater = permanentWaterLayer.getMapId()
    mapIdFlood = floodLayer.getMapId()
    mapIdLCLU = LCLU.getMapId()
    mapIdPopulationDensity = PopulationDensity.getMapId()
    mapIdSoilTexture = SoilTexture.getMapId()
    mapIdHealthCareAccess = HealthCareAccess.getMapId()

    content = { 
        'eeMapIdFlood': mapIdFlood['mapid'],
        'eeTokenFlood': mapIdFlood['token'],
        'eeMapURLFlood': mapIdFlood['tile_fetcher'].url_format,
        'eeMapIdWater': mapIdWater['mapid'],
        'eeTokenWater': mapIdWater['token'],
        'eeMapURLWater': mapIdWater['tile_fetcher'].url_format,
        'eeMapIdLCLU': mapIdLCLU['mapid'],
        'eeTokenLCLU': mapIdLCLU['token'],
        'eeMapURLLCLU': mapIdLCLU['tile_fetcher'].url_format,
        'eeMapIdPopulationDensity': mapIdPopulationDensity['mapid'],
        'eeTokenPopulationDensity': mapIdPopulationDensity['token'],
        'eeMapURLPopulationDensity': mapIdPopulationDensity['tile_fetcher'].url_format,
        'eeMapIdSoilTexture': mapIdSoilTexture['mapid'],
        'eeTokenSoilTexture': mapIdSoilTexture['token'],
        'eeMapURLSoilTexture': mapIdSoilTexture['tile_fetcher'].url_format,
        'eeMapIdHealthCareAccess': mapIdHealthCareAccess['mapid'],
        'eeTokenHealthCareAccess': mapIdHealthCareAccess['token'],
        'eeMapURLHealthCareAccess': mapIdHealthCareAccess['tile_fetcher'].url_format,
    }

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
    completion = openai.ChatCompletion.create(
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
        generated_text = completion.choices[0].message.function_call.arguments
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
    completion = openai.ChatCompletion.create(
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
        assistant_response = completion.choices[0].message.function_call.arguments
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

if __name__ == "__main__":
    app.run(host='0.0.0.0', debug=True)
