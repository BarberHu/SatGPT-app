"""Read an operator-supplied, regional OpenStreetMap road extract."""

from collections import Counter
import json
from pathlib import Path

from shapely.geometry import mapping, shape
from shapely.ops import unary_union

from harness.app.osm_queries import ATTRIBUTION, LICENSE_URL, ROAD_FILTERS, _line_parts
from harness.app.osm_transport import MAX_RESULT_BYTES, MAX_WAYS, RoadNetworkError


def query_snapshot(path, category, aoi):
    with Path(path).open('rb') as file:
        raw = file.read(MAX_RESULT_BYTES + 1)
    if len(raw) > MAX_RESULT_BYTES:
        raise ValueError('Road snapshot exceeds its byte budget')
    data = json.loads(raw)
    if data['category'] != category or not shape(data['coverage']).covers(aoi):
        return None
    grouped, properties = {}, {}
    for feature in data['features']:
        attrs = feature['properties']
        if attrs['osm_type'] != 'way' or attrs['category'] not in ROAD_FILTERS[category]:
            raise ValueError('Unexpected class in the road snapshot')
        parts = _line_parts(shape(feature['geometry']).intersection(aoi))
        if parts:
            key = str(attrs['osm_id'])
            grouped.setdefault(key, []).extend(parts)
            properties.setdefault(key, {**attrs, 'osm_id': key})
    if len(grouped) > MAX_WAYS:
        raise RoadNetworkError(422, 'feature_limit', 'The road snapshot exceeds the query feature budget. Select a smaller area.')
    features = [{'type': 'Feature', 'properties': properties[key], 'geometry': mapping(unary_union(lines))}
                for key, lines in grouped.items()]
    metadata = {'osm_data_time': data['osm_data_time'], 'source': data['source'],
                'source_version': data['source_sha256'], 'attribution': ATTRIBUTION, 'license_url': LICENSE_URL}
    summary = {**metadata, 'status': 'ok' if features else 'empty', 'count': len(features),
               'by_category': dict(sorted(Counter(f['properties']['category'] for f in features).items())),
               'skipped_geometry': data['skipped_geometry']}
    output = json.dumps({'type': 'FeatureCollection', 'features': features, **metadata},
                        ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8')
    if len(output) > MAX_RESULT_BYTES:
        raise RoadNetworkError(422, 'feature_limit', 'The road snapshot exceeds the query byte budget. Select a smaller area.')
    return summary, output
