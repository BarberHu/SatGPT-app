"""Check polygon geometry without guessing, repairing or reshaping its boundary."""

import math

from shapely.geometry import shape
from shapely.errors import GEOSException


def checked_polygon(geometry):
    """Return a valid WGS84 polygon, or None; validity is not source verification."""
    if not isinstance(geometry, dict) or geometry.get("type") not in {"Polygon", "MultiPolygon"}:
        return None
    coordinates = geometry.get("coordinates")
    if not isinstance(coordinates, list) or not coordinates:
        return None
    polygons = [coordinates] if geometry["type"] == "Polygon" else coordinates
    for polygon in polygons:
        if not isinstance(polygon, list) or not polygon:
            return None
        for ring in polygon:
            if not isinstance(ring, list) or len(ring) < 4:
                return None
            for point in ring:
                if not isinstance(point, (list, tuple)) or len(point) not in {2, 3}:
                    return None
                if any(isinstance(value, bool) or not isinstance(value, (int, float))
                       or not math.isfinite(value) for value in point):
                    return None
                if not (-180 <= point[0] <= 180 and -90 <= point[1] <= 90):
                    return None
            if ring[0][:2] != ring[-1][:2]:
                return None
    try:
        polygon = shape(geometry)
        if polygon.is_empty or not polygon.is_valid or polygon.area <= 0:
            return None
        return polygon
    except (TypeError, ValueError, GEOSException):
        return None


def polygon_identity(polygon):
    """Recognize equivalent rings/parts without changing the returned GeoJSON."""
    return polygon.normalize().wkb_hex


def exact_polygon_geometry(geojson):
    """Unwrap a single AOI and preserve its exact vertices for imagery and exports."""
    if not isinstance(geojson, dict):
        raise ValueError("AOI must contain a valid Polygon or MultiPolygon.")
    geometry = geojson
    if geometry.get("type") == "FeatureCollection":
        features = geometry.get("features") or []
        if len(features) != 1:
            raise ValueError("Combine the AOI features into one Polygon/MultiPolygon before analysis.")
        geometry = features[0]
    if isinstance(geometry, dict) and geometry.get("type") == "Feature":
        geometry = geometry.get("geometry")
    if checked_polygon(geometry) is None:
        raise ValueError("AOI polygon is invalid. Check closed rings, coordinates and intersections.")
    return geometry


def is_approximate_search_scope(aoi):
    """Block old guessed search scopes as well as newly unresolved candidates."""
    if not isinstance(aoi, dict):
        return False
    properties = (aoi.get("geojson") or {}).get("properties") or {}
    sources = {aoi.get("source"), aoi.get("boundary_source"),
               properties.get("source"), properties.get("boundary_source")}
    return (aoi.get("can_analyze") is False or properties.get("can_analyze") is False
            or bool(sources & {"bounds_fallback", "approximate_boundary", "unresolved", "ambiguous"})
            or aoi.get("status") == "Approximate boundary"
            or properties.get("status") == "Approximate boundary")
