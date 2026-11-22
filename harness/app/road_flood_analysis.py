"""Split road centerlines at the cells of a saved flood classification."""

from collections import defaultdict
from itertools import pairwise
import json
import math
from pathlib import Path
import re

from pyproj import Transformer
from shapely.geometry import shape


MAX_BYTES = 4_000_000
MAX_WAYS = 5000
LENGTH_KEYS = ('dry_m', 'flood_m', 'excluded_m', 'unobserved_m')


def cuts(start, end):
    low, high = sorted((start, end))
    return ((edge - start) / (end - start) for edge in range(math.floor(low) + 1, math.ceil(high)))


def split_line(xy, pixels, grid):
    size = grid['scale']
    grid_xy = [((x - grid['x']) / size, (grid['y'] - y) / size) for x, y in xy]
    lengths = [0., 0., 0., 0.]
    inundated = []
    current = None
    height, width = pixels.shape
    for (x, y), (end_x, end_y) in pairwise(grid_xy):
        dx, dy = end_x - x, end_y - y
        length = math.hypot(dx, dy) * size
        if not length:
            continue
        breaks = sorted({0., 1., *cuts(x, end_x), *cuts(y, end_y)})
        for start, stop in pairwise(breaks):
            if stop - start < 1e-12:
                continue
            mid = (start + stop) / 2
            col, row = math.floor(x + mid * dx), math.floor(y + mid * dy)
            value = int(pixels[row, col]) if 0 <= row < height and 0 <= col < width else 255
            lengths[value if value in (0, 1, 2) else 3] += (stop - start) * length
            if value == 1:
                a = (grid['x'] + (x + start * dx) * size, grid['y'] - (y + start * dy) * size)
                b = (grid['x'] + (x + stop * dx) * size, grid['y'] - (y + stop * dy) * size)
                if current is None:
                    current = [a]
                    inundated.append(current)
                current.append(b)
            else:
                current = None
    return lengths, inundated


def road_source(directory, osm_ref, flood_ref, *, indexed=False):
    if not isinstance(osm_ref, str) or not re.fullmatch(r'[a-f0-9]{32}', osm_ref):
        raise ValueError('Use the road artifact reference returned for this task')
    path = Path(directory) / f'{osm_ref}.geojson'
    if path.is_symlink():
        raise ValueError('Invalid road artifact')
    try:
        with path.open('rb') as file:
            raw = file.read(MAX_BYTES + 1)
    except OSError as exc:
        raise ValueError('Road artifact is unavailable in this task') from exc
    if len(raw) > MAX_BYTES:
        raise ValueError('Road artifact exceeds its analysis budget')
    source = json.loads(raw)
    features = source.get('features')
    if ((not indexed and source.get('flood_result_ref') != flood_ref) or not isinstance(features, list)
            or not 0 < len(features) <= MAX_WAYS):
        raise ValueError('Query the roads again with osm_roads and the selected flood result reference')
    return source


def totals(lengths):
    summary = dict(zip(LENGTH_KEYS, lengths))
    summary['total_m'] = sum(lengths)
    summary['observed_m'] = lengths[0] + lengths[1]
    if not summary['observed_m']:
        summary['flood_m'] = None
    return summary


def intersect_roads(source, recipe, pixels):
    grid = recipe['grid']
    forward = Transformer.from_crs('EPSG:4326', grid['crs'], always_xy=True)
    inverse = Transformer.from_crs(grid['crs'], 'EPSG:4326', always_xy=True)
    categories = defaultdict(lambda: [0., 0., 0., 0.])
    hits = []
    seen = set()
    for feature in source['features']:
        props = feature['properties']
        key = props['osm_type'], props['osm_id']
        geom = shape(feature['geometry'])
        if key in seen or key[0] != 'way' or geom.geom_type not in ('LineString', 'MultiLineString') or not geom.is_valid:
            raise ValueError('Road artifact contains a duplicate or invalid centerline')
        seen.add(key)
        lines = [geom] if geom.geom_type == 'LineString' else geom.geoms
        flood_m, wet = 0., []
        for line in lines:
            lng, lat = zip(*line.coords)
            values, fragments = split_line(list(zip(*forward.transform(lng, lat))), pixels, grid)
            category = categories[props['category']]
            for index, value in enumerate(values):
                category[index] += value
            flood_m += values[1]
            for segment in fragments:
                project_x, project_y = zip(*segment)
                wet.append(list(zip(*inverse.transform(project_x, project_y))))
        if wet:
            hits.append({'type': 'Feature', 'properties': {**props, 'flood_m': flood_m, 'analysis_status': 'hit'},
                         'geometry': {'type': 'MultiLineString', 'coordinates': wet}})
    lengths = [sum(values) for values in zip(*categories.values())]
    return {**totals(lengths), 'count': len(seen), 'hit_count': len(hits),
            'by_category': {key: totals(values) for key, values in sorted(categories.items())}}, hits


def analyze(payload, recipe, pixels, write_layer):
    ref = payload['flood_ref']
    source = road_source(payload.get('road_directory', payload['artifact_dir']), payload['osm_ref'], ref,
                         indexed=bool(payload.get('road_data_ref')))
    summary, hits = intersect_roads(source, recipe, pixels)
    metadata = {key: source.get(key) for key in ('osm_data_time', 'source', 'source_version', 'attribution', 'license_url')}
    provenance = recipe['provenance']
    status = 'ok' if summary['observed_m'] else 'no_raster_coverage'
    result = {'summary': {**summary, **metadata, 'status': status, 'flood_ref': ref, 'bounds': recipe['bounds'],
                          'observed_at': provenance['observed_at'], 'raster_source': provenance['source'],
                          'crs': recipe['grid']['crs'], 'scale': recipe['grid']['scale']}}
    if payload.get('flood_data_ref'):
        result['summary'].update(flood_data_ref=payload['flood_data_ref'], road_data_ref=payload['road_data_ref'])
    if hits and payload.get('show_on_map') is True:
        layer_ref = write_layer(payload['artifact_dir'], {'type': 'FeatureCollection', 'features': hits, **metadata})
        result['layer'] = {'kind': 'geojson', 'renderAs': 'line', 'artifact_ref': layer_ref, 'visible': True,
            'name': 'Potential road flood exposure', 'bounds': recipe['bounds'],
            'metadata': {'source': f"{metadata['attribution']} · {provenance['source']}",
                         'observed_at': provenance['observed_at'],
                         'description': f"{summary['flood_m'] / 1000:.2f} km of road centerline over mapped inundation. "
                                        f"Road snapshot: {metadata['osm_data_time'] or 'unknown'}."}}
    return result
