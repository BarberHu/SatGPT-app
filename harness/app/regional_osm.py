"""Query immutable, spatially indexed regional OSM snapshots."""

from collections import Counter
from contextlib import closing
import json
from pathlib import Path
import sqlite3

from shapely import from_wkb, orient_polygons
from shapely.geometry import MultiLineString, mapping, shape

from harness.app.osm_queries import ATTRIBUTION, LICENSE_URL, ROAD_FILTERS, _line_parts, _polygonal
from harness.app.osm_transport import MAX_RESULT_BYTES, MAX_WAYS, RoadNetworkError


SCHEMA_VERSION = 1
MAX_BUILDINGS = 10_000


def query_regional_snapshot(directory, kind, category, area):
    paths = sorted(Path(directory).glob('*.sqlite3'))
    if not paths:
        raise ValueError('No regional snapshots installed')
    for path in paths:
        with closing(sqlite3.connect(path.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            if db.execute('PRAGMA user_version').fetchone()[0] != SCHEMA_VERSION:
                raise ValueError('Unsupported regional snapshot version')
            row = db.execute('SELECT data FROM snapshot').fetchone()
            if row is None:
                raise ValueError('Missing regional snapshot metadata')
            metadata = json.loads(row[0])
            if shape(metadata['coverage']).covers(area):
                return _query_features(db, metadata, kind, category, area)
    raise RoadNetworkError(422, 'osm_snapshot_outside_coverage',
                           'No installed OSM snapshot covers the entire selection.')


def _query_features(db, metadata, kind, category, area):
    west, south, east, north = area.bounds
    parameters = [east, west, north, south, kind]
    query = '''SELECT f.osm_type, f.osm_id, f.category, f.name, f.geometry
        FROM feature_bounds AS b CROSS JOIN features AS f ON f.id=b.id
        WHERE b.min_x<=? AND b.max_x>=? AND b.min_y<=? AND b.max_y>=? AND f.kind=?'''
    if kind == 'roads':
        classes = ROAD_FILTERS[category]
        query += f" AND f.category IN ({','.join('?' for _ in classes)})"
        parameters.extend(classes)
    features = []
    limit = MAX_WAYS if kind == 'roads' else MAX_BUILDINGS
    for osm_type, osm_id, label, name, wkb in db.execute(query, parameters):
        clipped = from_wkb(wkb).intersection(area)
        if kind == 'roads':
            lines = _line_parts(clipped)
            clipped = lines[0] if len(lines) == 1 else MultiLineString(lines)
        else:
            clipped = orient_polygons(_polygonal(clipped))
        if clipped.is_empty:
            continue
        if len(features) == limit:
            raise RoadNetworkError(422, 'feature_limit',
                                   f'The snapshot query exceeds {limit:,} features. Select a smaller area.')
        props = {'osm_type': osm_type, 'osm_id': str(osm_id), 'category': label}
        if name:
            props['name'] = name
        features.append({'type': 'Feature', 'geometry': mapping(clipped), 'properties': props})

    provenance = {'source': metadata['source'], 'source_url': metadata['source_url'],
                  'source_version': metadata['source_sha256'], 'osm_data_time': metadata['osm_data_time'],
                  'attribution': ATTRIBUTION, 'license_url': LICENSE_URL}
    summary = {**provenance, 'status': 'ok' if features else 'empty', 'count': len(features),
               'by_category': dict(sorted(Counter(f['properties']['category'] for f in features).items())),
               'skipped_geometry': 0, 'snapshot_skipped_geometry': metadata['skipped'][kind]}
    payload = json.dumps({'type': 'FeatureCollection', 'features': features, **provenance},
                         ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(payload) > MAX_RESULT_BYTES:
        raise RoadNetworkError(422, 'feature_limit', 'The snapshot output is too large. Select a smaller area.')
    return summary, payload
