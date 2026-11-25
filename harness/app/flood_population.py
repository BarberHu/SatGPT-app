"""Area-weighted population exposure on supported native geographic grids."""

from dataclasses import dataclass
import math
import re

import numpy as np
from shapely.geometry import box, shape


GFD = 'GLOBAL_FLOOD_DB/MODIS_EVENTS/V1'
WORLDPOP = 'WorldPop/GP/100m/pop'
FLOOD_BANDS = ('flooded', 'clear_views', 'jrc_perm_water')
NO_DATA = -9999
EARTH_RADIUS_M = 6_371_008.8
MAX_WINDOW_CELLS = 2_000_000
MAX_OVERLAP_CELLS = 8_000_000
MAX_OVERLAP_OPERATIONS = 250_000_000


def prepare(payload):
    event, country, year = (payload.get(key) for key in ('event_id', 'country', 'year'))
    if type(event) is not int or not 1 <= event <= 2_147_483_647:
        raise ValueError('Provide a positive numeric GFD event ID')
    if not isinstance(country, str) or not re.fullmatch('[A-Z]{3}', country):
        raise ValueError('Provide a WorldPop three-letter country code')
    if type(year) is not int or not 2000 <= year <= 2020:
        raise ValueError('Use a year from 2000 through 2020 for legacy WorldPop')
    if type(payload.get('exclude_permanent_water')) is not bool:
        raise ValueError('Specify the approved permanent-water treatment')
    if 'show_on_map' in payload and type(payload['show_on_map']) is not bool:
        raise ValueError('show_on_map must be a boolean')
    geometry = (payload.get('analysis_context') or {}).get('analysis_region')
    if not geometry:
        raise ValueError('Confirm a rectangular AOI for native population overlap')
    aoi = shape(geometry)
    if aoi.geom_type != 'Polygon' or aoi.is_empty or not aoi.is_valid:
        raise ValueError('Native population overlap requires a valid rectangular AOI')
    west, south, east, north = aoi.bounds
    if not (-180 <= west < east <= 180 and -90 <= south < north <= 90
            and east - west < 180 and aoi.equals(box(west, south, east, north))):
        raise ValueError('Native population overlap requires a latitude-longitude rectangle without holes or dateline crossing')
    return aoi.bounds


@dataclass(frozen=True)
class NativeWindow:
    grid: dict

    @property
    def size(self):
        dims = self.grid['dimensions']
        return dims['width'], dims['height']

    def edges(self):
        width, height = self.size
        t = self.grid['affineTransform']
        longitude = t['translateX'] + np.arange(width + 1) * t['scaleX']
        latitude = t['translateY'] + np.arange(height + 1) * t['scaleY']
        return longitude, np.sin(np.deg2rad(latitude[::-1]))


def native_window(projection, bounds):
    transform = projection.get('transform')
    if (projection.get('crs') != 'EPSG:4326' or not isinstance(transform, list) or len(transform) != 6
            or not all(type(x) in (int, float) and math.isfinite(x) for x in transform)):
        raise ValueError('Native population overlap requires an EPSG:4326 affine grid')
    dx, shear_x, x0, shear_y, dy, y0 = transform
    if shear_x or shear_y or dx <= 0 or dy >= 0:
        raise ValueError('Native population overlap requires an unrotated, north-up grid')
    west, south, east, north = bounds
    indices = ((west - x0) / dx, (east - x0) / dx, (north - y0) / dy, (south - y0) / dy)
    if not all(math.isfinite(i) and abs(i) < 1e12 for i in indices):
        raise ValueError('Native grid window exceeds the pixel budget')
    col0, col1 = math.floor(indices[0]), math.ceil(indices[1])
    row0, row1 = math.floor(indices[2]), math.ceil(indices[3])
    width, height = col1 - col0, row1 - row0
    if width < 1 or height < 1 or width * height > MAX_WINDOW_CELLS:
        raise ValueError('Native grid window exceeds the pixel budget')
    return NativeWindow({'crsCode': 'EPSG:4326', 'dimensions': {'width': width, 'height': height},
                         'affineTransform': {'scaleX': dx, 'shearX': 0, 'translateX': x0 + col0 * dx,
                                             'shearY': 0, 'scaleY': dy, 'translateY': y0 + row0 * dy}})


def read_window(ee, image, bands, window):
    values = ee.data.computePixels({
        'expression': image.select(list(bands)).toFloat().unmask(NO_DATA, False),
        'fileFormat': 'NUMPY_NDARRAY', 'bandIds': list(bands), 'grid': window.grid,
    })
    width, height = window.size
    if values.shape != (height, width) or values.dtype.names != tuple(bands):
        raise ValueError('Earth Engine returned an unexpected native raster window')
    return values


def overlap(left, right, lower, upper):
    end = np.minimum(np.minimum(left[1:, None], right[None, 1:]), upper)
    start = np.maximum(np.maximum(left[:-1, None], right[None, :-1]), lower)
    return np.maximum(0, end - start)


def check_overlap_budget(flood_grid, population_grid):
    fw, fh = flood_grid.size
    pw, ph = population_grid.size
    if (pw * fw + ph * fh + ph * fw > MAX_OVERLAP_CELLS
            or ph * fw * (fh + pw) > MAX_OVERLAP_OPERATIONS):
        raise ValueError('Native grid overlap exceeds the calculation budget')


def summarize(bounds, flood_grid, population_grid, eligible, flood, population):
    west, south, east, north = bounds
    lower, upper = np.sin(np.deg2rad([south, north]))
    fx, fy = flood_grid.edges()
    px, py = population_grid.edges()
    vx = overlap(px, fx, west, east)
    vy = overlap(py, fy, lower, upper)
    native_area = np.diff(py)[:, None] * np.diff(px)[None, :]
    population = population[::-1].astype(np.float64)
    pop_valid = np.isfinite(population) & (population >= 0)
    wet = vy @ flood[::-1].astype(np.float64) @ vx.T
    joint = vy @ eligible[::-1].astype(np.float64) @ vx.T
    coverage = float(joint[pop_valid].sum())
    flooded = float(wet[pop_valid].sum())
    aoi_area = (east - west) * (upper - lower)
    to_km2 = math.pi / 180 * (EARTH_RADIUS_M / 1000) ** 2
    exposed = float((population[pop_valid] * wet[pop_valid] / native_area[pop_valid]).sum())
    return {
        'status': 'ok' if coverage > 0 else 'no_joint_coverage',
        'exposed_people': exposed if coverage > 0 else None,
        'aoi_area_km2': float(aoi_area * to_km2),
        'joint_valid_area_km2': coverage * to_km2,
        'joint_valid_fraction': min(1.0, coverage / aoi_area),
        'joint_valid_flood_area_km2': flooded * to_km2 if coverage > 0 else None,
    }


def estimate(ee, payload, bounds):
    event_id = payload['event_id']
    aoi = ee.Geometry.Rectangle(list(bounds), 'EPSG:4326', False)
    collection = ee.ImageCollection(GFD).filter(ee.Filter.eq('id', event_id)).filterBounds(aoi)
    metadata = ee.Dictionary({
        'count': collection.size(), 'start': collection.aggregate_array('system:time_start'),
        'end': collection.aggregate_array('system:time_end'),
    }).getInfo()
    if metadata['count'] != 1:
        return {'status': 'event_unmatched' if metadata['count'] == 0 else 'ambiguous_event',
                'event_id': event_id, 'matched_events': metadata['count'], 'exposed_people': None}

    result = {'event_id': event_id, 'flood_dataset': GFD,
              'event_start_ms': next(iter(metadata['start']), None),
              'event_end_ms': next(iter(metadata['end']), None),
              'exclude_permanent_water': payload['exclude_permanent_water']}
    event = ee.Image(collection.first())
    flood_grid = native_window(event.select(list(FLOOD_BANDS)).projection().getInfo(), bounds)
    values = read_window(ee, event, FLOOD_BANDS, flood_grid)
    longitude, sine_latitude = flood_grid.edges()
    west, south, east, north = bounds
    lower, upper = np.sin(np.deg2rad([south, north]))
    in_x = (longitude[1:] > west) & (longitude[:-1] < east)
    in_y = (sine_latitude[1:] > lower) & (sine_latitude[:-1] < upper)
    in_aoi = in_y[::-1, None] & in_x[None, :]
    observed = in_aoi & np.isin(values['flooded'], [0, 1]) & (values['clear_views'] > 0)
    result['flood_grid'] = flood_grid.grid
    result['valid_flood_product_pixels'] = int(observed.sum())
    if not observed.any():
        return {**result, 'status': 'no_flood_observations', 'exposed_people': None}
    eligible = observed & (values['jrc_perm_water'] == 0) if payload['exclude_permanent_water'] else observed
    if not eligible.any():
        return {**result, 'status': 'no_eligible_flood_observations', 'exposed_people': None}
    wet = eligible & (values['flooded'] == 1)

    country, year = payload['country'], payload['year']
    people = ee.ImageCollection(WORLDPOP).filter(ee.Filter.eq('country', country)).filter(ee.Filter.eq('year', year))
    count = people.size().getInfo()
    if count != 1:
        return {**result, 'status': 'population_unmatched' if count == 0 else 'ambiguous_population',
                'matched_population_images': count, 'exposed_people': None}
    image = ee.Image(people.first()).select('population')
    population_grid = native_window(image.projection().getInfo(), bounds)
    check_overlap_budget(flood_grid, population_grid)
    population = read_window(ee, image, ('population',), population_grid)['population']
    return {**result, **summarize(bounds, flood_grid, population_grid, eligible, wet, population),
            'population_dataset': WORLDPOP, 'country': country, 'population_year': year,
            'population_grid': population_grid.grid,
            'method': 'native geographic cell overlap, weighted by full population cell area'}


def display_code(payload):
    """Replay the verified sources and their coverage masks as a density layer."""
    return '\n'.join([
        "area = ee.Geometry(analysis_region_geojson, 'EPSG:4326', False)",
        (f"event = ee.Image(ee.ImageCollection({GFD!r}).filter(ee.Filter.eq('id', {payload['event_id']!r}))"
         ".filterBounds(area).first())"),
        "wet = event.select('flooded').eq(1).And(event.select('clear_views').gt(0))",
        *(["wet = wet.And(event.select('jrc_perm_water').eq(0))"] if payload['exclude_permanent_water'] else []),
        (f"population = ee.Image(ee.ImageCollection({WORLDPOP!r})"
         f".filter(ee.Filter.eq('country', {payload['country']!r}))"
         f".filter(ee.Filter.eq('year', {payload['year']!r})).first()).select('population')"),
        "cell_area = ee.Image.pixelArea().reproject(population.projection())",
        "density = population.divide(cell_area).multiply(1000000).rename('population_density')",
        "result = density.updateMask(population.gte(0)).updateMask(wet).clip(area)",
    ])
