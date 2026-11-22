"""Keep spatial payloads out of text and general-purpose model tool results."""

import json
import math
import re


SPATIAL_TEXT = re.compile(
    r'(?i)(["\'](?:coordinates|geometries|geojson|pixels|pixel_values|raster_values|affinetransform)["\']\s*:\s*\['
    r'|["\']type["\']\s*:\s*["\'](?:FeatureCollection|Feature|MultiPolygon|Polygon|MultiLineString|LineString|MultiPoint|Point)["\']'
    r'|\b(?:POLYGON|MULTIPOLYGON|LINESTRING|MULTILINESTRING)\s*\(\s*\(?\s*[-+]?\d'
    r'|(?<![\w])[A-Za-z]:[\\/]|/(?:api/previews|api/harness/conversations)/[^\s]+/osm/)')
FORBIDDEN_FIELDS = {'coordinates', 'geometry', 'geometries', 'geojson', 'features', 'pixels', 'pixel_values',
                    'raster_values', 'affinetransform', 'artifact_dir', 'file_path'}
COORDINATE_PAIRS = re.compile(r'\[\s*\[\s*[-+]?\d+(?:\.\d+)?\s*,\s*[-+]?\d+(?:\.\d+)?\s*\]\s*,\s*\[')


def safe_text(value):
    if not isinstance(value, str) or SPATIAL_TEXT.search(value) or COORDINATE_PAIRS.search(value):
        return '[Spatial data omitted. Use a confirmed study area or indexed data reference.]'
    return value


def recovery_summary(messages, current_id):
    rows = []
    for entry in messages:
        if entry.get('job_id') == current_id or entry.get('role') not in ('user', 'assistant'):
            continue
        value = safe_text(entry.get('content'))
        if isinstance(value, str):
            rows.append({'role': entry['role'], 'text': value[:480]})
    return rows[-6:]


def summary(value):
    remaining = 1400

    def check(node, depth):
        nonlocal remaining
        remaining -= 1
        if depth > 6 or remaining < 0:
            raise ValueError('Return a bounded statistics summary or publish a spatial artifact')
        if isinstance(node, dict):
            if any(str(key).lower() in FORBIDDEN_FIELDS or safe_text(str(key)) != str(key) for key in node):
                raise ValueError('Spatial payloads must be saved as indexed artifacts, not returned by gee_eval')
            return {key: check(item, depth + 1) for key, item in node.items()}
        if isinstance(node, (list, tuple)):
            if len(node) > 256 or any(isinstance(item, (list, tuple)) for item in node):
                raise ValueError('Use labeled scalar statistics instead of coordinate or raster matrices')
            return [check(item, depth + 1) for item in node]
        if isinstance(node, str):
            if len(node) > 1600 or safe_text(node) != node:
                raise ValueError('Use short observation labels or an indexed data reference')
        if isinstance(node, float) and not math.isfinite(node):
            return None
        return node

    checked = check(value, 0)
    if len(json.dumps(checked, ensure_ascii=False, allow_nan=False).encode()) > 32_000:
        raise ValueError('Return a smaller statistics summary')
    return checked
