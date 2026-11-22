"""Publish a fixed-grid Earth Engine flood classification as a reusable task artifact."""

import json
import math
from pathlib import Path
import re
from uuid import uuid4

import numpy as np
from pyproj import Transformer


MAX_CELLS = 20_000_000
# Earth Engine can account for wider intermediate pixels than the returned uint8 band.
MAX_REQUEST_CELLS = 4_000_000
RECIPE_LIMIT = 4_000_000
UNKNOWN, OUTSIDE, INVALID = 255, 254, 253
BAND = 'flood_class'


def paths(directory, ref):
    if not isinstance(ref, str) or not re.fullmatch(r'[a-f0-9]{32}', ref):
        raise ValueError('Invalid flood result reference')
    directory = Path(directory)
    return directory / f'flood-{ref}.json', directory / f'flood-{ref}.npy'


def grid_for(bounds, crs, scale):
    if not isinstance(crs, str) or not re.fullmatch(r'EPSG:32[67](?:0[1-9]|[1-5][0-9]|60)', crs):
        raise ValueError('Use the local WGS84 UTM CRS, e.g. EPSG:32748 for Jakarta')
    if type(scale) is not int or not 5 <= scale <= 120:
        raise ValueError('Use an integer flood grid scale of 5–120 metres')
    left, bottom, right, top = Transformer.from_crs('EPSG:4326', crs, always_xy=True).transform_bounds(*bounds)
    x = (math.floor(left / scale) - 1) * scale
    y = (math.ceil(top / scale) + 1) * scale
    width = math.ceil((right - x) / scale) + 1
    height = math.ceil((y - bottom) / scale) + 1
    if width * height > MAX_CELLS or max(width, height) > 32768:
        raise ValueError('Flood grid exceeds the pixel budget. Select a smaller analysis area or coarser scale.')
    return {'crs': crs, 'scale': scale, 'x': x, 'y': y, 'width': width, 'height': height}


def summarize_pixels(pixels, scale, minimum_coverage):
    counts = np.bincount(pixels.ravel(), minlength=256)
    dry, flood, excluded = map(int, counts[:3])
    unknown = int(counts[UNKNOWN])
    total = dry + flood + excluded + unknown
    if total + counts[OUTSIDE] != pixels.size:
        raise ValueError('Flood classification must use 0 dry, 1 flood, 2 excluded, and masked unknown pixels')
    observed = dry + flood + excluded
    if total == 0 or dry + flood == 0 or observed / total < minimum_coverage:
        raise ValueError('Flood classification has insufficient valid observations in the confirmed area')
    area = scale * scale / 1_000_000
    return {'aoi_km2': total * area, 'flood_km2': flood * area, 'dry_km2': dry * area,
            'excluded_km2': excluded * area, 'unobserved_km2': unknown * area,
            'observed_fraction': observed / total, 'classifiable_fraction': (dry + flood) / total}


def read_grid_pixels(ee, image, grid):
    width, height, scale = grid['width'], grid['height'], grid['scale']
    rows_per_request = MAX_REQUEST_CELLS // width
    pixels = np.empty((height, width), dtype=np.uint8)
    for first_row in range(0, height, rows_per_request):
        rows = min(rows_per_request, height - first_row)
        packed = ee.data.computePixels({'expression': image, 'fileFormat': 'NUMPY_NDARRAY', 'bandIds': [BAND],
            'grid': {'crsCode': grid['crs'], 'dimensions': {'width': width, 'height': rows},
                     'affineTransform': {'scaleX': scale, 'scaleY': -scale, 'translateX': grid['x'],
                                         'translateY': grid['y'] - first_row * scale}}})
        block = packed[BAND]
        if block.dtype != np.uint8 or block.shape != (rows, width):
            raise ValueError('Earth Engine returned an unexpected flood grid')
        pixels[first_row:first_row + rows] = block
    return pixels


def classify(ee, image, payload):
    context = payload['analysis_context']
    geometry = context.get('analysis_region')
    if not geometry:
        raise ValueError('Confirm a polygon on the map before publishing a flood result')
    settings = payload['flood_settings']
    grid = grid_for(context['bounds'], settings['crs'], settings['scale'])
    minimum = settings.get('minimum_coverage', 0)
    if type(minimum) not in (float, int) or not 0 <= minimum <= 1:
        raise ValueError('Minimum coverage must be a fraction between zero and one')
    scale = grid['scale']
    transform = [scale, 0, 0, 0, -scale, 0]
    aoi = ee.Geometry(geometry)
    canonical = image.select([0], [BAND]).reproject(crs=grid['crs'], crsTransform=transform).clip(aoi)
    classified = canonical.remap([0, 1, 2], [0, 1, 2], INVALID, BAND).rename(BAND)
    encoded = classified.unmask(UNKNOWN, False).clip(aoi).unmask(OUTSIDE, False).toUint8()
    pixels = read_grid_pixels(ee, encoded, grid)
    stats = summarize_pixels(pixels, scale, minimum)
    return canonical.eq(1).selfMask(), pixels, {
        'version': 1, 'geometry': geometry, 'bounds': context['bounds'], 'grid': grid, 'stats': stats,
        'provenance': settings, 'image': canonical.serialize(),
    }


def save(directory, recipe, pixels):
    ref = uuid4().hex
    document, raster = paths(directory, ref)
    document.parent.mkdir(parents=True, exist_ok=True)
    raw = json.dumps(recipe, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(raw) > RECIPE_LIMIT:
        raise ValueError('Flood recipe exceeds the saved result budget')
    temp_document, temp_raster = document.with_suffix('.json.tmp'), raster.with_suffix('.npy.tmp')
    try:
        with temp_raster.open('wb') as file:
            np.save(file, pixels, allow_pickle=False)
        temp_document.write_bytes(raw)
        temp_raster.replace(raster)
        temp_document.replace(document)
    finally:
        temp_document.unlink(missing_ok=True)
        temp_raster.unlink(missing_ok=True)
    return ref


def load(directory, ref):
    document, raster = paths(directory, ref)
    try:
        if document.is_symlink() or raster.is_symlink():
            raise ValueError('Invalid saved flood result')
        with document.open('rb') as file:
            raw = file.read(RECIPE_LIMIT + 1)
        if len(raw) > RECIPE_LIMIT or raster.stat().st_size > MAX_CELLS + 1024:
            raise ValueError('Saved flood result exceeds its budget')
        recipe = json.loads(raw)
        grid = recipe['grid']
        dimensions = (grid['height'], grid['width'])
        pixels = np.load(raster, mmap_mode='r', allow_pickle=False)
        if recipe['version'] != 1 or pixels.shape != dimensions or pixels.dtype != np.uint8:
            raise ValueError('Invalid saved flood grid')
    except (OSError, ValueError, TypeError, KeyError) as exc:
        raise ValueError('Original flood result is unavailable in this conversation. Publish the flood map again.') from exc
    return recipe, pixels
