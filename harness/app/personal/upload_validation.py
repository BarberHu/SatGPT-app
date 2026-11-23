"""Bounded metadata validation; no reprojection, resampling or silent feature loss."""
import csv
import json
import math
import re
from pathlib import Path
from .settings import PersonalError


def geojson_csv(source, output):
    try:
        data = json.loads(Path(source).read_text(encoding='utf-8-sig'), parse_constant=lambda _: (_ for _ in ()).throw(ValueError()))
    except (ValueError, UnicodeError) as exc:
        raise PersonalError(422, 'The file is not valid finite GeoJSON.') from exc
    crs = data.get('crs') if isinstance(data, dict) else None
    crs_name = crs.get('properties', {}).get('name') if isinstance(crs, dict) and isinstance(crs.get('properties'), dict) else None
    if not isinstance(data, dict) or (crs is not None and crs_name not in
            {'EPSG:4326', 'urn:ogc:def:crs:OGC:1.3:CRS84', 'urn:ogc:def:crs:EPSG::4326'}):
        raise PersonalError(422, 'GeoJSON must use longitude/latitude in EPSG:4326 or CRS84.')
    features = [data] if data.get('type') == 'Feature' else data.get('features') if data.get('type') == 'FeatureCollection' else None
    if not isinstance(features, list) or not 1 <= len(features) <= 10000:
        raise PersonalError(422, 'Upload a Feature or FeatureCollection containing 1–10000 features.')
    types, vertices, extent = {}, 0, [180., 90., -180., -90.]
    depths = {'Point': 0, 'MultiPoint': 1, 'LineString': 1, 'MultiLineString': 2, 'Polygon': 2, 'MultiPolygon': 3}

    def coordinates(value, depth, kind):
        nonlocal vertices
        if not isinstance(value, list) or not value:
            raise PersonalError(422, 'Every geometry must contain valid coordinates.')
        if depth == 0:
            if len(value) not in {2, 3} or any(isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in value):
                raise PersonalError(422, 'Coordinates must contain finite numbers.')
            x, y = value[:2]
            if not (-180 <= x <= 180 and -90 <= y <= 90):
                raise PersonalError(422, 'Coordinates must be longitude/latitude in EPSG:4326.')
            vertices += 1
            if vertices > 100000:
                raise PersonalError(422, 'GeoJSON exceeds the 100000-vertex limit.')
            extent[0], extent[1], extent[2], extent[3] = min(extent[0], x), min(extent[1], y), max(extent[2], x), max(extent[3], y)
        else:
            if depth == 1 and kind in {'LineString', 'MultiLineString'} and len(value) < 2:
                raise PersonalError(422, 'Lines require at least two positions.')
            if depth == 1 and kind in {'Polygon', 'MultiPolygon'} and (len(value) < 4 or value[0] != value[-1]):
                raise PersonalError(422, 'Polygon rings must be closed and contain at least four positions.')
            for child in value:
                coordinates(child, depth - 1, kind)

    for feature in features:
        if not isinstance(feature, dict) or feature.get('type') != 'Feature':
            raise PersonalError(422, 'Every entry must be a GeoJSON Feature.')
        geometry = feature.get('geometry')
        if not isinstance(geometry, dict) or geometry.get('type') not in depths:
            raise PersonalError(422, 'Null geometries and GeometryCollection are not supported.')
        if geometry.get('crs'):
            raise PersonalError(422, 'Per-geometry CRS overrides are not supported.')
        coordinates(geometry.get('coordinates'), depths[geometry['type']], geometry['type'])
        properties = feature.get('properties') if feature.get('properties') is not None else {}
        if not isinstance(properties, dict) or len(properties) > 100:
            raise PersonalError(422, 'Each feature may contain at most 100 scalar properties.')
        for key, value in properties.items():
            if not isinstance(key, str) or not key or len(key) > 100 or key in {'.geo', 'system:index'}:
                raise PersonalError(422, 'A property name is reserved or invalid.')
            if value is None:
                continue
            if isinstance(value, bool):
                raise PersonalError(422, 'Boolean properties cannot be preserved by this CSV import. Convert them explicitly to numbers or strings first.')
            kind = 'COLUMN_DATA_TYPE_STRING' if isinstance(value, str) else 'COLUMN_DATA_TYPE_LONG' if isinstance(value, int) and -(2**63) <= value < 2**63 else 'COLUMN_DATA_TYPE_NUMERIC' if isinstance(value, float) and math.isfinite(value) else None
            if kind is None or (isinstance(value, str) and len(value) > 10000):
                raise PersonalError(422, 'Nested, non-finite or oversized properties are unsupported.')
            if key in types and types[key] != kind:
                raise PersonalError(422, 'Each property column must have a consistent scalar type.')
            types[key] = kind
        if len(types) > 100:
            raise PersonalError(422, 'The dataset may contain at most 100 property columns.')
    # All-null columns remain present as strings, rather than silently disappearing.
    keys = sorted({key for f in features for key in (f.get('properties') or {})})
    with Path(output).open('w', encoding='utf-8', newline='') as file:
        writer = csv.DictWriter(file, fieldnames=['.geo', *keys]); writer.writeheader()
        for feature in features:
            props = feature.get('properties') or {}
            row = {key: '' if props.get(key) is None else str(props[key]).lower() if isinstance(props[key], bool) else props[key] for key in keys}
            writer.writerow({'.geo': json.dumps(feature['geometry'], allow_nan=False, separators=(',', ':')), **row})
    return {'features': len(features), 'vertices': vertices, 'bounds': extent,
            'column_types': {key: types.get(key, 'COLUMN_DATA_TYPE_STRING') for key in keys}}


def geotiff_metadata(path):
    import rasterio
    from rasterio.warp import transform_bounds
    try:
        with rasterio.Env(GDAL_DISABLE_READDIR_ON_OPEN='EMPTY_DIR', GDAL_PAM_ENABLED='NO'):
            with rasterio.open(path, driver='GTiff') as src:
                if src.driver != 'GTiff' or src.crs is None or not (0 < src.count <= 100) or src.width <= 0 or src.height <= 0:
                    raise ValueError('Missing raster georeferencing')
                bounds = list(transform_bounds(src.crs, 'EPSG:4326', *src.bounds, densify_pts=21))
                if any(not math.isfinite(v) for v in bounds) or not (-180 <= bounds[0] < bounds[2] <= 180 and -90 <= bounds[1] < bounds[3] <= 90):
                    raise ValueError('Invalid raster extent')
                names = [name or f'band_{i+1}' for i, name in enumerate(src.descriptions)]
                if len(set(names)) != len(names) or any(not re.fullmatch(r'[A-Za-z][A-Za-z0-9_]{0,99}', name) for name in names):
                    raise ValueError('Invalid or duplicate band descriptions')
                nodata = [v if v is None or math.isfinite(v) else 'NaN' for v in src.nodatavals]
                return {'bands': names, 'crs': src.crs.to_string(), 'bounds': bounds,
                        'width': src.width, 'height': src.height, 'dtypes': list(src.dtypes), 'nodata': nodata}
    except Exception as exc:
        raise PersonalError(422, 'Upload a valid georeferenced GeoTIFF with unique bands and a valid spatial extent.') from exc
