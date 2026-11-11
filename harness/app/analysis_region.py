"""Bounded GeoJSON input contract for task-local analysis geometry (EPSG:4326)."""
import math


def _cross(a, b, c):
    return (b[0]-a[0])*(c[1]-a[1]) - (b[1]-a[1])*(c[0]-a[0])


def _intersects(a, b, c, d):
    if (max(a[0], b[0]) < min(c[0], d[0]) or max(c[0], d[0]) < min(a[0], b[0])
            or max(a[1], b[1]) < min(c[1], d[1]) or max(c[1], d[1]) < min(a[1], b[1])):
        return False
    return _cross(a,b,c)*_cross(a,b,d) <= 0 and _cross(c,d,a)*_cross(c,d,b) <= 0


def _rings_cross(first, second):
    return any(_intersects(a,b,c,d) for a,b in zip(first, first[1:]) for c,d in zip(second, second[1:]))


def _inside(point, ring):
    x, y = point
    inside = False
    for a, b in zip(ring, ring[1:]):
        if (a[1] > y) != (b[1] > y) and x < (b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0]:
            inside = not inside
    return inside


def validate_analysis_region(value):
    if value is None:
        return None
    if not isinstance(value, dict) or value.get('type') not in {'Polygon', 'MultiPolygon'}:
        raise ValueError('analysis_region must be a GeoJSON Polygon or MultiPolygon geometry')
    polygons = [value.get('coordinates')] if value['type'] == 'Polygon' else value.get('coordinates')
    if not isinstance(polygons, list) or not 1 <= len(polygons) <= 32:
        raise ValueError('analysis_region must contain 1–32 polygons')
    count, points, normalized, area = 0, [], [], 0
    for polygon in polygons:
        if not isinstance(polygon, list) or not 1 <= len(polygon) <= 64:
            raise ValueError('Each polygon must contain 1–64 rings')
        rings = []
        for index, ring in enumerate(polygon):
            if not isinstance(ring, list) or len(ring) < 4:
                raise ValueError('Each ring needs at least four coordinates including closure')
            count += len(ring)
            if count > 2048:
                raise ValueError('analysis_region exceeds 2048 vertices')
            clean = []
            for point in ring:
                if (not isinstance(point, list) or len(point) != 2
                        or any(isinstance(n, bool) or not isinstance(n, (int, float)) for n in point)
                        or not -180 <= point[0] <= 180 or not -90 <= point[1] <= 90):
                    raise ValueError('Coordinates must be finite longitude/latitude pairs')
                clean.append([float(n) for n in point])
            if clean[0] != clean[-1] or len(set(map(tuple, clean))) < 3:
                raise ValueError('Each ring must be closed with three distinct vertices')
            edges = list(zip(clean, clean[1:]))
            if any(a == b for a,b in edges) or any(
                    _intersects(a,b,c,d) for i,(a,b) in enumerate(edges) for j,(c,d) in enumerate(edges)
                    if j > i+1 and not (i == 0 and j == len(edges)-1)):
                raise ValueError('Polygon rings must not self-intersect or repeat vertices')
            x0, y0 = clean[0]
            signed = sum((a[0]-x0)*(b[1]-y0)-(b[0]-x0)*(a[1]-y0) for a, b in zip(clean, clean[1:]))
            if abs(signed) < 1e-12:
                raise ValueError('Each ring must enclose a non-zero area')
            # Spherical ring area; reject huge or degenerate scopes before GEE.
            size = abs(sum(math.radians(b[0]-a[0]) * (2 + math.sin(math.radians(a[1])) + math.sin(math.radians(b[1])))
                           for a, b in zip(clean, clean[1:]))) * 6371008.8**2 / 2
            area += size if index == 0 else -size
            points.extend(clean)
            rings.append(clean)
        for i, hole in enumerate(rings[1:], 1):
            if not _inside(hole[0], rings[0]) or any(_rings_cross(hole, other) for other in rings[:i]):
                raise ValueError('Polygon holes must be inside the exterior and must not intersect')
            if any(_inside(hole[0], other) or _inside(other[0], hole) for other in rings[1:i]):
                raise ValueError('Polygon holes must not overlap')
        normalized.append(rings)
    for i, polygon in enumerate(normalized):
        for other in normalized[:i]:
            if (any(_rings_cross(a,b) for a in polygon for b in other)
                    or (_inside(polygon[0][0], other[0]) and not any(_inside(polygon[0][0], h) for h in other[1:]))
                    or (_inside(other[0][0], polygon[0]) and not any(_inside(other[0][0], h) for h in polygon[1:]))):
                raise ValueError('MultiPolygon components must not overlap or intersect')
    if max(p[0] for p in points) - min(p[0] for p in points) > 180:
        raise ValueError('Antimeridian-spanning analysis regions are not supported')
    if not 1 <= area <= 5_000_000_000_000:
        raise ValueError('analysis_region area must be between 1 m² and 5 million km²')
    return {'type': value['type'], 'coordinates': normalized[0] if value['type'] == 'Polygon' else normalized}


def region_bounds(region):
    polygons = [region['coordinates']] if region['type'] == 'Polygon' else region['coordinates']
    points = [point for polygon in polygons for ring in polygon for point in ring]
    return [min(p[0] for p in points), min(p[1] for p in points), max(p[0] for p in points), max(p[1] for p in points)]
