"""Bounded OSM queries for the Agent's task-local analysis geometry."""

from collections import Counter
from datetime import datetime
import asyncio
import json
import math

from shapely import GEOSException, intersection, orient_polygons
from shapely.geometry import LineString, MultiLineString, MultiPolygon, Point, Polygon, mapping, shape
from shapely.ops import linemerge

from harness.app.analysis_region import validate_analysis_region
from .road_network import MAX_RESULT_BYTES, MAX_WAYS, ROAD_CLASSES, OverpassClient, RoadNetworkError, checked_elements, geometry_positions


ATTRIBUTION = "© OpenStreetMap contributors"
LICENSE_URL = "https://www.openstreetmap.org/copyright"
POI_FILTERS = {
    "hospital": ("amenity", "hospital"),
    "clinic": ("amenity", "clinic"),
    "pharmacy": ("amenity", "pharmacy"),
    "school": ("amenity", "school"),
    "university": ("amenity", "university"),
    "police": ("amenity", "police"),
    "fire_station": ("amenity", "fire_station"),
    "shelter": ("amenity", "shelter"),
    "supermarket": ("shop", "supermarket"),
}
ROAD_FILTERS = {
    "major": ROAD_CLASSES,
    "local": ("tertiary", "tertiary_link", "residential", "unclassified", "service", "living_street"),
}
BUILDING_TYPES = frozenset(("yes", "residential", "house", "apartments", "detached", "commercial",
                            "industrial", "retail", "school", "hospital", "office", "public",
                            "warehouse", "garage", "shed", "church", "terrace", "farm"))
LIMITS = {"roads": (40_000, MAX_WAYS), "pois": (250, 2_000), "buildings": (100, 4_000)}


def query_scope(region, bounds, kind):
    if region is None:
        if (not isinstance(bounds, list) or len(bounds) != 4
                or any(type(value) not in (int, float) for value in bounds)):
            raise RoadNetworkError(422, "invalid_area", "Select a valid map area first.")
        west, south, east, north = bounds
        if not (-180 <= west < east <= 180 and -85 <= south < north <= 85):
            raise RoadNetworkError(422, "invalid_area", "Select a valid map area first.")
        region = {"type": "Polygon", "coordinates": [[
            [west, south], [east, south], [east, north], [west, north], [west, south],
        ]]}
    try:
        area = shape(validate_analysis_region(region))
        if not area.is_valid or area.is_empty:
            raise ValueError("Invalid geometry")
    except (ValueError, TypeError, GEOSException) as exc:
        raise RoadNetworkError(422, "invalid_area", "Select a valid map area first.") from exc
    west, south, east, north = area.bounds
    area_budget, _ = LIMITS[kind]
    box_area = 6371.0088**2 * math.radians(east - west) * (
        math.sin(math.radians(north)) - math.sin(math.radians(south)))
    if east - west > 180 or box_area > area_budget:
        raise RoadNetworkError(422, "area_limit", f"Select an area with a bounding box no larger than {area_budget:,} km².")
    return area


def _query(kind, category, bounds, limit):
    west, south, east, north = bounds
    bbox = f"({south},{west},{north},{east})"
    if kind == "roads":
        selection = f'way["highway"~"^({"|".join(ROAD_FILTERS[category])})$"]["area"!="yes"]{bbox};'
    elif kind == "pois":
        key, value = POI_FILTERS[category]
        selection = f'(node["{key}"="{value}"]{bbox};way["{key}"="{value}"]{bbox};rel["{key}"="{value}"]["type"="multipolygon"]{bbox};);'
    else:
        selection = f'(way["building"]["building"!="no"]{bbox};rel["building"]["building"!="no"]["type"="multipolygon"]{bbox};);'
    return f"[out:json][timeout:8];{selection}out geom {limit + 1};out count;"


def _read_candidates(body, limit):
    data = json.loads(body)
    remark = data.get("remark") if isinstance(data, dict) else None
    if isinstance(remark, str) and ("timed out" in remark.lower() or "timeout" in remark.lower()):
        raise RoadNetworkError(504, "osm_timeout", "The OSM provider timed out. Try again.")
    elements, count = checked_elements(data, "total", limit, "feature_limit",
                                       f"The selection exceeds {limit:,} candidate OSM objects. Select a smaller area.")
    unique = {}
    for element in elements:
        kind, identifier = element["type"], element["id"]
        if kind not in ("node", "way", "relation") or type(identifier) is not int or identifier <= 0:
            raise ValueError("Invalid OSM object")
        if unique.setdefault((kind, identifier), element) != element:
            raise ValueError("Conflicting OSM object versions")
    if len(unique) != count:
        raise ValueError("OSM completion count does not match the response")
    timestamp = (data.get("osm3s") or {}).get("timestamp_osm_base")
    if timestamp is not None:
        timestamp = datetime.fromisoformat(timestamp.replace("Z", "+00:00"))
        if timestamp.tzinfo is None:
            raise ValueError("Missing timezone in OSM timestamp")
        timestamp = timestamp.isoformat()
    return unique, timestamp


def _polygon_parts(geometry):
    if geometry.geom_type == "Polygon" and not geometry.is_empty:
        return [geometry]
    if geometry.geom_type in ("MultiPolygon", "GeometryCollection"):
        return [polygon for part in geometry.geoms for polygon in _polygon_parts(part)]
    return []


def _polygonal(geometry):
    parts = _polygon_parts(geometry)
    return parts[0] if len(parts) == 1 else MultiPolygon(parts)


def _line_parts(geometry):
    if geometry.geom_type == "LineString" and geometry.length:
        return [geometry]
    if geometry.geom_type in ("MultiLineString", "GeometryCollection"):
        return [line for part in geometry.geoms for line in _line_parts(part)]
    return []


def _rings(lines):
    if not lines:
        return []
    merged = linemerge(lines)
    rings = [merged] if merged.geom_type == "LineString" else list(merged.geoms)
    if not all(ring.is_ring for ring in rings):
        raise ValueError("Incomplete multipolygon ring")
    return [Polygon(ring) for ring in rings]


def _area_geometry(element):
    if element["type"] == "way":
        points = geometry_positions(element["geometry"])
        if len(points) < 4 or points[0] != points[-1]:
            raise ValueError("Open polygon")
        return Polygon(points), []

    outer, inner, outer_ids = [], [], []
    for member in element["members"]:
        role = member.get("role")
        if role not in ("outer", "inner", ""):
            continue
        if member["type"] != "way":
            raise ValueError("Unsupported multipolygon member")
        line = LineString(geometry_positions(member["geometry"]))
        if role == "inner":
            inner.append(line)
        else:
            outer.append(line)
            outer_ids.append(member["ref"])
    shells = _rings(outer)
    if not shells:
        raise ValueError("Missing multipolygon exterior")
    holes = [[] for _ in shells]
    for inner_ring in _rings(inner):
        containers = [index for index, shell in enumerate(shells) if shell.contains(inner_ring)]
        if not containers:
            raise ValueError("Multipolygon hole has no exterior")
        chosen = min(containers, key=lambda index: shells[index].area)
        holes[chosen].append(inner_ring.exterior.coords)
    return MultiPolygon([Polygon(shell.exterior.coords, holes[index]) for index, shell in enumerate(shells)]), outer_ids


def _geometry(kind, element, area):
    if kind == "roads" and element["type"] == "way":
        line = LineString(geometry_positions(element["geometry"]))
        pieces = _line_parts(intersection(line, area))
        result = pieces[0] if len(pieces) == 1 else MultiLineString(pieces)
        return result, [], []
    if kind == "pois" and element["type"] == "node":
        point = Point(geometry_positions([element])[0])
        return intersection(point, area), [], []
    if element["type"] not in ("way", "relation") or kind == "roads":
        raise ValueError("Unexpected OSM geometry")
    polygon, outer_ids = _area_geometry(element)
    if not polygon.is_valid or polygon.is_empty:
        raise ValueError("Invalid OSM polygon")
    clipped = _polygonal(intersection(polygon, area))
    if kind == "pois":
        return clipped.representative_point(), [], []
    return orient_polygons(clipped), outer_ids, _polygon_parts(polygon)


def _convert(kind, category, candidates, timestamp, area):
    features, exterior_ways = {}, {}
    skipped = 0
    for (osm_type, osm_id), element in candidates.items():
        tags = element.get("tags") or {}
        if kind == "roads":
            label = tags.get("highway")
            matches = label in ROAD_FILTERS[category] and tags.get("area") != "yes"
        elif kind == "pois":
            tag, label = POI_FILTERS[category]
            matches = tags.get(tag) == label
        else:
            value = tags.get("building")
            matches = isinstance(value, str) and value not in ("no", "")
            label = value if matches and value in BUILDING_TYPES else "other"
        if not matches:
            raise RoadNetworkError(502, "osm_unavailable", "The OSM response contains an unexpected object.")
        try:
            geometry, outer_ids, original = _geometry(kind, element, area)
        except (ValueError, TypeError, KeyError, GEOSException):
            skipped += 1
            continue
        if geometry.is_empty:
            continue
        properties = {"osm_type": osm_type, "osm_id": str(osm_id), "category": label}
        name = tags.get("name")
        if isinstance(name, str) and name.strip():
            properties["name"] = " ".join(name.split())[:100]
        features[(osm_type, osm_id)] = {"type": "Feature", "geometry": mapping(geometry), "properties": properties}
        for outer_id in outer_ids:
            exterior_ways.setdefault(outer_id, []).extend(Polygon(polygon.exterior) for polygon in original)
    for outer_id, shells in exterior_ways.items():
        key = ("way", outer_id)
        if key in features:
            polygon, _ = _area_geometry(candidates[key])
            if any(shell.equals(polygon) for shell in shells):
                features.pop(key)
    result = list(features.values())
    by_category = dict(sorted(Counter(feature["properties"]["category"] for feature in result).items()))
    summary = {"status": "ok" if result else "empty", "count": len(result), "by_category": by_category,
               "skipped_geometry": skipped, "osm_data_time": timestamp, "attribution": ATTRIBUTION,
               "license_url": LICENSE_URL}
    if kind == "pois":
        summary["examples"] = [feature["properties"]["name"] for feature in result if "name" in feature["properties"]][:8]
    collection = {"type": "FeatureCollection", "features": result,
                  "attribution": ATTRIBUTION, "license_url": LICENSE_URL, "osm_data_time": timestamp}
    payload = json.dumps(collection, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")
    if len(payload) > MAX_RESULT_BYTES:
        raise RoadNetworkError(422, "feature_limit", "The GeoJSON exceeds the result budget. Select a smaller area.")
    return summary, payload


class OverpassQueries(OverpassClient):
    async def query(self, kind, category, region, bounds):
        categories = {"roads": ROAD_FILTERS, "pois": POI_FILTERS, "buildings": {None}}
        if (not isinstance(kind, str) or kind not in categories or not isinstance(category, (str, type(None)))
                or category not in categories[kind]):
            raise RoadNetworkError(422, "invalid_category", "Select a supported OSM query category.")
        area = query_scope(region, bounds, kind)
        candidates, timestamp = await self.get((kind, category, area.bounds))
        return await asyncio.to_thread(_convert, kind, category, candidates, timestamp, area)

    async def _request(self, key):
        kind, category, bounds = key
        _, limit = LIMITS[kind]
        body = await self.response_body(_query(kind, category, bounds, limit), limit_code="feature_limit",
                                        limit_message="The OSM response exceeds the byte budget. Select a smaller area.")
        return await asyncio.to_thread(_read_candidates, body, limit)
