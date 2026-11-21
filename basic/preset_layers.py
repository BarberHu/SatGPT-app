"""Session-free preset presentation over the existing raster algorithms."""
from datetime import date, datetime, timezone
import math

import ee

from . import flood_api_services as raster

PRESETS = {
    'singleInundationEvent': 'JRC annual water classification',
    'inundationHotspot': 'Inundation Hotspot', 'wildfireRisk': 'Wildfire Risk',
    'burnHistory': 'Burn History', 'landslideRisk': 'Landslide Risk',
    'slopeSteepness': 'Slope Steepness', 'populationDensity': 'Population Count',
    'soilTexture': 'Soil Texture', 'lclu': 'Land Cover',
}
RESPONSE_NAMES = {'lclu': 'LCLU', **{key: key[0].upper() + key[1:] for key in PRESETS if key != 'lclu'}}
MODEL_KEYS = {'wildfireRisk', 'landslideRisk'}
GHSL_POPULATION_2020 = 'JRC/GHSL/P2023A/GHS_POP/2020'
POPULATION_CLASS_BREAKS = (1, 5, 20, 100, 500)


def _build_population_count(region):
    counts = ee.Image(GHSL_POPULATION_2020).select('population_count')
    # GHSL can carry its -200 NoData sentinel as an unmasked value in Earth Engine.
    return counts.updateMask(counts.gte(0)).clip(region)


def _classify_population_counts(counts):
    classes = counts.gt(POPULATION_CLASS_BREAKS[0])
    for threshold in POPULATION_CLASS_BREAKS[1:]:
        classes = classes.add(counts.gt(threshold))
    return classes.updateMask(counts.gt(0)).reproject(crs=counts.projection())


def effective_parameters(key, payload):
    if key in {'singleInundationEvent', 'inundationHotspot'}:
        start, end, _ = raster._get_jrc_year_range_from_payload(payload, default_start=2021, default_count=1)
        return {'year_start': start, 'year_end': end}
    if key in MODEL_KEYS | {'burnHistory'}:
        minimum = date(2020, 3, 28) if key in MODEL_KEYS else date(2000, 11, 1)
        try:
            start = date.fromisoformat(str(payload['time_start']))
            end = date.fromisoformat(str(payload['time_end']))
        except (KeyError, ValueError):
            raise ValueError('Provide start and exclusive end dates in YYYY-MM-DD format.')
        low, high = (7, 365) if key in MODEL_KEYS else (30, 1095)
        if start < minimum or end > date.today() or not low <= (end - start).days <= high:
            raise ValueError(f'Choose a {low}–{high} day window from {minimum} through today.')
        result = {'time_start': start.isoformat(), 'time_end': end.isoformat()}
        if key in MODEL_KEYS:
            cloud = float(payload.get('cloud_threshold', 50))
            if not math.isfinite(cloud) or not 0 <= cloud <= 100:
                raise ValueError('Cloud threshold must be between 0 and 100.')
            result['cloud_threshold'] = cloud
        return result
    return {}


def presentation(key, params):
    catalog = raster.get_basic_layer_catalog()
    supplementary = catalog['supplementary']
    legend = {}
    if key == 'singleInundationEvent':
        vis = raster.JRC_WATER_VIS
        legend = {'type': 'categorical', 'labels': ['Permanent water', 'Seasonal water']}
        source, dataset, unit = 'JRC Global Surface Water', catalog['historical']['jrcYearlyHistory']['dataset'], ''
        method = 'Annual water classes aggregated across the inclusive year range. Seasonal water takes precedence. This is historical water classification, not a real-time flood event extraction.'
    elif key == 'inundationHotspot':
        vis = catalog['hotspot']['floodFrequency']['visualization']
        source, dataset, unit = 'JRC / ESA WorldCover', catalog['hotspot']['jrcYearlyHistory']['dataset'], 'fraction of years'
        method = 'Seasonal-water frequency; excludes JRC permanent water and ESA WorldCover 2020/2021 water. Blue is permanent water; frequency saturates at 0.8 (values capped at 0.9).'
        # The rendered image blends a blue permanent-water mask with a frequency ramp.
        legend = {'type': 'composite', 'swatches': [{'label': 'Permanent water', 'color': '#00008B'}]}
    elif key in MODEL_KEYS:
        palette = raster.WILDFIRE_RISK_PALETTE if key == 'wildfireRisk' else raster.LANDSLIDE_RISK_PALETTE
        vis = {'min': 1, 'max': 5, 'palette': palette}
        legend = {'type': 'categorical', 'labels': ['Low', 'Moderate', 'Watch', 'Warning', 'Very high']}
        source = 'Model-based index'
        dataset = 'Sentinel-2 SR; CHIRPS; SRTM; ' + ('MODIS LST; ESA WorldCover' if key == 'wildfireRisk' else 'Sentinel-1 VH')
        unit = 'class'
        method = ('Weighted fuel dryness (20%), water deficit (30%), temperature anomaly (25%), precipitation deficit (15%), terrain (10%); forest and land masks.'
                  if key == 'wildfireRisk' else 'Weighted 3-day rainfall (35%), slope (25%), SAR saturation (20%), NDVI instability (10%), terrain roughness (10%); land mask.')
        method += ' Baseline extends from 3 years before the exclusive end to the window start. Missing source observations use the existing model fallback constants; classes are indices, not calibrated probabilities.'
    elif key == 'burnHistory':
        vis = raster.BURN_HISTORY_VIS
        source, dataset, unit = 'NASA MODIS', 'MODIS/061/MCD64A1', ''
        method = 'Union of positive BurnDate pixels from monthly products whose timestamps fall in the selected start-inclusive, end-exclusive interval. Product timestamps are not exact burn dates.'
    elif key == 'slopeSteepness':
        vis = raster.SLOPE_STEEPNESS_VIS
        source, dataset, unit = 'NASA SRTM', 'USGS/SRTMGL1_003', 'degrees'
        method = 'ee.Terrain.slope from 30 m elevation. Values above 60 degrees saturate. SRTM coverage is approximately 56°S–60°N.'
    elif key == 'lclu':
        vis = raster.WORLDCOVER_VIS
        legend = {'type': 'categorical', 'labels': ['Tree cover', 'Shrubland', 'Grassland', 'Cropland', 'Built-up', 'Bare / sparse', 'Snow / ice', 'Water', 'Wetland', 'Mangroves', 'Moss / lichen']}
        source, dataset, unit = 'ESA WorldCover', supplementary['landcover']['dataset'], ''
        method = '2021 WorldCover Map classes remapped from 10…100 to consecutive display values 0…10.'
    elif key == 'populationDensity':
        vis = {'min': 0, 'max': len(POPULATION_CLASS_BREAKS), 'palette': supplementary[key]['visualization']['palette']}
        lower_bounds = (0, *POPULATION_CLASS_BREAKS)
        labels = [f'>{lower} to {upper}' for lower, upper in zip(lower_bounds, POPULATION_CLASS_BREAKS)]
        legend = {'type': 'categorical', 'labels': [*labels, f'>{POPULATION_CLASS_BREAKS[-1]}'],
                  'note': '0 is transparent'}
        source, dataset, unit = 'JRC GHSL', GHSL_POPULATION_2020, 'people/pixel'
        method = ('2020 GHS-POP R2023A estimated residential population per native 100 m pixel. '
                  'All grids use the same six classes with inclusive upper bounds. '
                  'Valid zeros are included in statistics and transparent in the map and preview.')
    else:
        entry = supplementary[key]
        vis = entry['visualization']
        source, dataset, unit = 'OpenLandMap', entry['dataset'], 'USDA class'
        method = 'USDA soil texture at 10 cm depth (band b10), v02; modeled soil properties, not a dated observation.'
        legend = {'type': 'categorical', 'labels': ['Clay', 'Silty clay', 'Sandy clay', 'Clay loam', 'Silty clay loam', 'Sandy clay loam', 'Loam', 'Silt loam', 'Sandy loam', 'Silt', 'Loamy sand', 'Sand']}
    observed = (f"{params['year_start']}–{params['year_end']} (inclusive)" if 'year_start' in params
                else f"{params['time_start']} to {params['time_end']} (end exclusive)" if 'time_start' in params
                else {'populationDensity': '2020', 'lclu': '2021', 'slopeSteepness': '2000-02-11 to 2000-02-22', 'soilTexture': 'v02 · static model; observation date unavailable'}[key])
    return {'visualization': vis, 'legend': legend, 'metadata': {'source': source, 'dataset_id': dataset,
            'unit': unit, 'observed_at': observed, 'description': method, 'created_at': datetime.now(timezone.utc).isoformat()}}


def get_preset_layer_payload(payload):
    key = payload.get('preset_id')
    if key not in PRESETS:
        raise ValueError('Unsupported preset ID.')
    params = effective_parameters(key, payload)
    aoi = raster.parse_aoi_from_payload(payload)
    geometry = raster.extract_geojson_geometry(aoi.get('geojson'))
    if not geometry or geometry.get('type') not in {'Polygon', 'MultiPolygon'}:
        raise ValueError('A polygon study area is required.')
    # Derive bounds from geometry, not untrusted or stale caller bounds.
    def points(coords):
        if isinstance(coords, list) and len(coords) >= 2 and all(isinstance(v, (int, float)) for v in coords[:2]):
            yield coords[:2]
        elif isinstance(coords, list):
            for child in coords:
                yield from points(child)
    coordinates = list(points(geometry['coordinates']))
    bounds_map = raster.get_bounds_from_ring(coordinates)
    if not raster.is_valid_bounds(bounds_map):
        raise ValueError('Study area bounds are invalid.')
    bounds = [bounds_map[name] for name in ['west', 'south', 'east', 'north']]
    region = raster.aoi_to_ee_geometry(aoi)
    display = presentation(key, params)
    response_name = RESPONSE_NAMES[key]
    if key == 'populationDensity':
        counts = _build_population_count(region)
        stats = counts.reduceRegion(reducer=ee.Reducer.minMax().unweighted(), geometry=region,
                                    crs=counts.projection(), maxPixels=10_000_000, tileScale=4).getInfo()
        minimum = stats.get('population_count_min')
        maximum = stats.get('population_count_max')
        if minimum is None or maximum is None:
            return {'status': 'empty', 'effective_params': params, 'note': 'No rendered pixels for this study area and interval.', 'layer': None}
        display['metadata']['description'] += f' Valid counts in this grid range from {minimum:g} to {maximum:g} people/pixel.'
        image = raster.visualize_image(_classify_population_counts(counts), display['visualization'])
        output = {}
        raster.attach_map_id(output, response_name, image.getMapId())
    else:
        inputs = {'aoi': aoi, **params, 'layer_keys': [key]}
        if key == 'singleInundationEvent':
            inputs.update(time_start=f"{params['year_start']}-01-01", time_end=f"{params['year_end']}-12-31")
        images = {}
        output = raster.get_agent_raster_layers_payload(inputs, _images=images)
        image = images[response_name]
    # Source windows are analysis windows; record real product timestamps separately.
    coverage, source_counts = [], []
    sources = ([('MODIS/061/MCD64A1', None)] if key == 'burnHistory' else
               [('COPERNICUS/S2_SR_HARMONIZED', 'cloud'), ('UCSB-CHG/CHIRPS/DAILY', None)] +
               ([('MODIS/061/MOD11A2', None)] if key == 'wildfireRisk' else [('COPERNICUS/S1_GRD', None)]) if key in MODEL_KEYS else [])
    for dataset, cloud_filter in sources:
        collection = ee.ImageCollection(dataset).filterBounds(region).filterDate(params['time_start'], params['time_end'])
        if cloud_filter:
            collection = collection.filter(ee.Filter.lt('CLOUDY_PIXEL_PERCENTAGE', params['cloud_threshold']))
        if dataset == 'COPERNICUS/S1_GRD':
            collection = collection.filter(ee.Filter.listContains('transmitterReceiverPolarisation', 'VH')).filter(ee.Filter.eq('instrumentMode', 'IW'))
        summary = ee.Dictionary({'count': collection.size(), 'first': collection.aggregate_min('system:time_start'), 'last': collection.aggregate_max('system:time_start')}).getInfo()
        source_counts.append(summary['count'])
        first, last = summary.get('first'), summary.get('last')
        stamp = lambda value: datetime.fromtimestamp(value / 1000, timezone.utc).date().isoformat()
        coverage.append(f"{dataset}: {stamp(first)} to {stamp(last)}" if first is not None and last is not None else f'{dataset}: no observations; model fallback may apply')
    if coverage:
        display['metadata']['description'] += ' Available product timestamps — ' + '; '.join(coverage) + '.'
        if key == 'burnHistory' and summary['count']:
            display['metadata']['observed_at'] = f'{stamp(first)} to {stamp(last)} (monthly products)'
    note = 'Analysis dates describe the calculation window; source observations can lag and vary by dataset.' if key in MODEL_KEYS else ''
    if source_counts and not any(source_counts):
        return {'status': 'empty', 'effective_params': params, 'note': 'No input observations for the selected study area and interval.', 'layer': None}
    if key in MODEL_KEYS and any(count == 0 for count in source_counts):
        note = 'Some input collections have no observations. The model uses fallback constants; inspect Source & method before interpreting the index.'
    if key != 'populationDensity':
        # This is a coverage check. Population extrema already establish coverage on the native grid.
        has_pixels = image.mask().reduceRegion(reducer=ee.Reducer.max(), geometry=region, scale=30,
                                               bestEffort=True, maxPixels=1_000_000, tileScale=4).getInfo()
        if not any(value for value in has_pixels.values() if value is not None):
            return {'status': 'empty', 'effective_params': params, 'note': 'No rendered pixels for this study area and interval.', 'layer': None}
    thumbnail = None
    try:
        if key == 'populationDensity':
            thumbnail = {'url': image.getThumbURL({'format': 'png', 'dimensions': 256, 'region': region})}
        else:
            from harness.app.gee_worker import save_thumbnail
            thumbnail = save_thumbnail(image, {}, bounds, ee)
    except Exception:
        pass  # A thumbnail failure must never discard a usable map.
    layer = {'id': 'preset-result', 'name': PRESETS[key], 'kind': 'gee',
             'url': output[f'eeMapURL{response_name}'], 'bounds': bounds,
             'thumbnail': thumbnail, **display}
    return {'status': 'ready', 'layer': layer, 'effective_params': params, 'note': note}
