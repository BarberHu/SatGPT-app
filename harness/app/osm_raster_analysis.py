"""Referenced OSM inputs and Earth Engine sampling/area calculations."""

import json
import math
from pathlib import Path
import re
from uuid import uuid4

from shapely import get_coordinates
from shapely.errors import ShapelyError
from shapely.geometry import shape

from analysis_region import region_bounds
from context_guard import safe_text
from geo_index import artifact_directory, get


MAX_INPUT_BYTES = 1_000_000
MAX_FEATURES = 1_000
MAX_PIXELS_PER_BUILDING = 1_000_000
DETAIL_LIMIT = 20
AREA_BANDS = ['grid_area_m2', 'observed_area_m2', 'flood_area_m2']


def finite_number(value):
    return type(value) in (int, float) and math.isfinite(value)


def resolve_input(payload):
    data_ref = payload.get('osm_data_ref')
    if data_ref is None:
        return payload
    if payload.get('osm_ref') is not None:
        raise ValueError('Provide exactly one OSM reference')
    kinds = {'point_sample': 'pois', 'building_flood': 'buildings'}
    kind = kinds.get(payload.get('mode'))
    if kind is None:
        raise ValueError('Select point_sample or building_flood')
    context = payload['geo_context']
    record = get(context, data_ref, (kind,))
    area = record.get('geometry')
    analysis = payload['analysis_context']
    selected = analysis.get('analysis_region')
    if not area or (selected and not shape(selected).equals(shape(area))):
        raise ValueError('The selected study area must match the saved OSM area')
    return {**payload, 'osm_ref': record['legacy_ref'],
            'osm_input_dir': artifact_directory(context, record['task_id']),
            'analysis_context': {**analysis, 'analysis_region': area, 'bounds': record['bounds']}}


def read_source(payload):
    ref = payload.get('osm_ref')
    if not isinstance(ref, str) or not re.fullmatch(r'[a-f0-9]{32}', ref):
        raise ValueError('osm_ref must be the artifact_ref from an OSM query in this task')
    path = Path(payload.get('osm_input_dir', payload['artifact_dir'])) / f'{ref}.geojson'
    if not path.is_file() or path.is_symlink():
        raise ValueError('OSM artifact is unavailable in this task')
    try:
        with path.open('rb') as stream:
            raw = stream.read(MAX_INPUT_BYTES + 1)
    except OSError:
        raise ValueError('OSM artifact is unavailable in this task') from None
    if len(raw) > MAX_INPUT_BYTES:
        raise ValueError('OSM artifact exceeds the analysis byte budget. Select a smaller area.')
    try:
        source = json.loads(raw)
    except (ValueError, RecursionError):
        raise ValueError('Invalid OSM GeoJSON artifact') from None
    if (not isinstance(source, dict) or source.get('type') != 'FeatureCollection'
            or 'analysis' in source or not isinstance(source.get('features'), list) or not source['features']):
        raise ValueError('Use a nonempty GeoJSON artifact from an OSM query in this task')
    if len(source['features']) > MAX_FEATURES:
        raise ValueError(f'OSM analysis supports up to {MAX_FEATURES:,} features. Select a smaller area.')
    return source


def feature_key(feature, geometry_types):
    if not isinstance(feature, dict) or feature.get('type') != 'Feature':
        raise ValueError('Invalid OSM feature')
    properties, geometry = feature.get('properties'), feature.get('geometry')
    if not isinstance(geometry, dict) or geometry.get('type') not in geometry_types:
        raise ValueError('OSM geometry does not match the requested analysis mode')
    if not isinstance(properties, dict):
        raise ValueError('Invalid OSM feature properties')
    kind, identifier = properties.get('osm_type'), properties.get('osm_id')
    if (kind not in ('node', 'way', 'relation') or not isinstance(identifier, str)
            or not re.fullmatch(r'[1-9][0-9]{0,19}', identifier)):
        raise ValueError('OSM feature must have a valid type and ID')
    try:
        geom = shape(geometry)
        if (geom.is_empty or geom.has_z or not geom.is_valid or any(
                not (-180 <= x <= 180 and -90 <= y <= 90) for x, y in get_coordinates(geom))):
            raise ValueError('Invalid geometry')
    except (ShapelyError, ValueError, TypeError, KeyError, IndexError, OverflowError, RecursionError):
        raise ValueError('Invalid OSM feature geometry') from None
    return f'{kind}/{identifier}'


def prepare(payload):
    mode = payload.get('mode')
    if mode not in ('point_sample', 'building_flood'):
        raise ValueError('Select point_sample or building_flood')
    settings = {'mode': mode}
    for field, limit in [('band', 128), ('crs', 240), ('raster_source', 240), ('observed_at', 100)]:
        value = payload.get(field)
        if not isinstance(value, str) or not 1 <= len(value.strip()) <= limit:
            raise ValueError(f'{field} is required and must be at most {limit} characters')
        settings[field] = value.strip()
    scale, transform = payload.get('scale'), payload.get('crs_transform')
    if (scale is None) == (transform is None):
        raise ValueError('Provide exactly one of scale or crs_transform')
    if scale is not None:
        if not finite_number(scale) or scale <= 0:
            raise ValueError('scale must be a finite positive number in metres')
        settings['scale'] = scale
    else:
        if not isinstance(transform, list) or len(transform) != 6 or not all(map(finite_number, transform)):
            raise ValueError('crs_transform must contain six finite numbers')
        determinant = transform[0] * transform[4] - transform[1] * transform[3]
        if not math.isfinite(determinant) or determinant == 0:
            raise ValueError('crs_transform must specify a nonsingular grid')
        settings['crs_transform'] = transform
    if 'hit_value' in payload:
        if mode != 'point_sample' or not finite_number(payload['hit_value']):
            raise ValueError('hit_value must be a finite number and is only supported for point_sample')
        settings['hit_value'] = payload['hit_value']
    source = read_source(payload)
    geometry_types = ('Point',) if mode == 'point_sample' else ('Polygon', 'MultiPolygon')
    features = {}
    for feature in source['features']:
        key = feature_key(feature, geometry_types)
        if key in features:
            raise ValueError('Duplicate OSM type and ID in analysis input')
        features[key] = feature
    return settings, source, features


def reduce_features(ee, image, settings, source_features):
    point = settings['mode'] == 'point_sample'
    geometry_options = {} if point else {'geodesic': False}
    features = ee.FeatureCollection([
        ee.Feature(ee.Geometry(feature['geometry'], proj='EPSG:4326', **geometry_options), {'osm_key': key})
        for key, feature in source_features.items()
    ])
    band = image.select([settings['band']])
    crs = settings['crs']
    if point:
        sample_grid = ({'projection': ee.Projection(crs, settings['crs_transform'])}
                       if 'crs_transform' in settings else {'projection': ee.Projection(crs), 'scale': settings['scale']})
        return band.rename('sample_value').sampleRegions(collection=features, properties=['osm_key'], **sample_grid)

    area = ee.Image.pixelArea()
    flood = band.eq(1)
    observed = band.eq(0).Or(flood)
    # Preserve dry pixels as zeros and leave all other classes or missing pixels unobserved.
    areas = ee.Image.cat(area, area.updateMask(observed), area.multiply(flood).updateMask(observed)).rename(AREA_BANDS)
    area_grid = ({'crsTransform': settings['crs_transform']} if 'crs_transform' in settings else {'scale': settings['scale']})
    reduced = areas.reduceRegions(collection=features, reducer=ee.Reducer.sum(), crs=crs, **area_grid,
                                  maxPixelsPerRegion=MAX_PIXELS_PER_BUILDING)
    return reduced.map(lambda feature: feature.setGeometry(None))


def join_results(rows, features):
    values = {}
    for row in rows['features']:
        properties = row['properties']
        key = properties.get('osm_key')
        if key not in features or key in values:
            raise ValueError('Earth Engine returned an unexpected OSM feature reference')
        values[key] = properties
    return values


def point_metrics(row, settings):
    value = row.get('sample_value')
    if not finite_number(value):
        return {'sample_value': None, 'coverage': 'none', 'analysis_status': 'no_data'}
    status = 'observed'
    if 'hit_value' in settings:
        status = 'hit' if value == settings['hit_value'] else 'no_hit'
    return {'sample_value': value, 'coverage': 'complete', 'analysis_status': status}


def building_metrics(row):
    grid, observed, flood = (row.get(band) for band in AREA_BANDS)
    if not finite_number(observed) or observed <= 0:
        return {'observed_area_m2': 0, 'flood_area_m2': None, 'coverage_fraction': 0 if grid else None,
                'coverage': 'none', 'analysis_status': 'no_data'}
    if not finite_number(grid) or grid <= 0 or not finite_number(flood) or flood < 0:
        raise ValueError('Earth Engine returned inconsistent building area statistics')
    return {'observed_area_m2': observed, 'flood_area_m2': flood,
            'coverage_fraction': min(1.0, observed / grid),
            'coverage': 'complete' if math.isclose(observed, grid, rel_tol=1e-9) else 'partial',
            'analysis_status': 'hit' if flood > 0 else 'no_hit'}


def format_result(payload, settings, source, features, rows):
    point = settings['mode'] == 'point_sample'
    values = join_results(rows, features)
    annotated, details = [], []
    coverage_counts = {'complete': 0, 'partial': 0, 'none': 0}
    hit_count = 0
    for key, feature in features.items():
        row = values.get(key, {})
        metrics = point_metrics(row, settings) if point else building_metrics(row)
        coverage_counts[metrics['coverage']] += 1
        hit_count += metrics['analysis_status'] == 'hit'
        properties = {**feature['properties'], **metrics}
        annotated.append({**feature, 'properties': properties})
        details.append(metrics)
    # For exposure answers, prioritize hits in the bounded model-visible list.
    details.sort(key=lambda row: row['analysis_status'] != 'hit')
    metadata = {key: source.get(key) for key in ('osm_data_time', 'attribution', 'license_url')}
    labels = {key: safe_text(value) if isinstance(value, str) else value for key, value in {**settings, **metadata}.items()}
    summary = {**labels, 'status': 'no_raster_coverage' if coverage_counts['none'] == len(features) else 'ok',
               'count': len(features), 'coverage_counts': coverage_counts, 'examples': details[:DETAIL_LIMIT],
               'examples_omitted': max(0, len(details) - DETAIL_LIMIT)}
    if payload.get('osm_data_ref'):
        summary['osm_data_ref'] = payload['osm_data_ref']
    if not point or 'hit_value' in settings:
        summary['hit_count'] = hit_count

    result = {'summary': summary}
    show = payload.get('show_on_map') is True
    if show or summary['examples_omitted']:
        ref = write_layer(payload['artifact_dir'], {**source, 'features': annotated, 'analysis': settings})
        context = payload['analysis_context']
        region = context.get('analysis_region')
        result['layer'] = {
            'kind': 'geojson', 'renderAs': 'circle' if point else 'fill',
            'artifact_ref': ref, 'visible': show,
            'name': 'OSM POI raster samples' if point else 'OSM building flood overlap',
            'bounds': region_bounds(region) if region else context['bounds'],
            'metadata': {'source': f"{metadata['attribution']} · {settings['raster_source']}",
                         'observed_at': settings['observed_at'],
                         'description': f"{len(features):,} OSM features. OSM data time: {metadata['osm_data_time'] or 'unknown'}."},
        }
        summary['map_layer'] = 'show_on_completion' if show else 'available'
    return result


def write_layer(directory, collection):
    reference = uuid4().hex
    path = Path(directory) / f'{reference}.geojson'
    temporary = path.with_suffix('.tmp')
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary.write_text(json.dumps(collection, ensure_ascii=False, allow_nan=False, separators=(',', ':')),
                             encoding='utf-8')
        temporary.replace(path)
    except OSError:
        raise ValueError('Could not save the OSM analysis layer') from None
    finally:
        temporary.unlink(missing_ok=True)
    return reference
