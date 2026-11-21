"""Bounded OpenStreetMap road queries for Basic's rectangular map selections."""

import asyncio
from collections import OrderedDict
import json
import math
import time

import httpx

from harness.app.analysis_region import region_bounds, validate_analysis_region


ROAD_CLASSES = (
    "motorway", "trunk", "primary", "secondary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link",
)
MAX_AREA_KM2 = 40_000
MAX_WAYS = 5_000
MAX_OVERPASS_BYTES = 8_000_000
MAX_RESULT_BYTES = 4_000_000


class RoadNetworkError(Exception):
    def __init__(self, status_code, code, message):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


def network_bounds(geojson):
    if geojson.get("type") == "Feature":
        geojson = geojson.get("geometry")
    try:
        geometry = validate_analysis_region(geojson)
    except ValueError as exc:
        raise RoadNetworkError(422, "invalid_area", "Select a valid rectangular grid to load roads.") from exc
    if geometry is None or geometry["type"] != "Polygon":
        raise RoadNetworkError(422, "invalid_area", "Select a rectangular grid to load roads.")

    west, south, east, north = region_bounds(geometry)
    rings = geometry["coordinates"]
    corners = {(west, south), (west, north), (east, south), (east, north)}
    if len(rings) != 1 or len(rings[0]) != 5 or set(map(tuple, rings[0][:-1])) != corners:
        raise RoadNetworkError(422, "invalid_area", "Select a rectangular grid to load roads.")
    area = 6371.0088**2 * math.radians(east - west) * (
        math.sin(math.radians(north)) - math.sin(math.radians(south))
    )
    if area > MAX_AREA_KM2:
        raise RoadNetworkError(422, "area_limit", f"Select a grid no larger than {MAX_AREA_KM2:,} km².")
    return west, south, east, north


def _clip_segment(start, end, bounds):
    """Return the portion of a segment inside the box using its parametric interval."""
    west, south, east, north = bounds
    x, y = start
    dx, dy = end[0] - x, end[1] - y
    enter, leave = 0.0, 1.0
    for direction, distance in ((-dx, x - west), (dx, east - x), (-dy, y - south), (dy, north - y)):
        if direction == 0:
            if distance < 0:
                return None
            continue
        if direction < 0:
            enter = max(enter, distance / direction)
        else:
            leave = min(leave, distance / direction)
        if enter >= leave:
            return None

    def position(fraction):
        return [min(east, max(west, x + fraction * dx)), min(north, max(south, y + fraction * dy))]

    first = start if enter == 0 else position(enter)
    last = end if leave == 1 else position(leave)
    return (first, last) if first != last else None


def _clip_line(line, bounds):
    section = []
    for start, end in zip(line, line[1:]):
        clipped = _clip_segment(start, end, bounds)
        if clipped is None:
            if section:
                yield section
                section = []
            continue
        first, last = clipped
        if section and section[-1] == first:
            section.append(last)
        else:
            if section:
                yield section
            section = [first, last]
    if section:
        yield section


def _parse_overpass(data, bounds):
    elements, count = checked_elements(data, "ways", MAX_WAYS, "road_limit",
                                       f"The grid exceeds {MAX_WAYS:,} candidate OSM roads.")

    roads = {}
    for way in elements:
        tags, coords = way["tags"], way["geometry"]
        if (way["type"] != "way" or type(way["id"]) is not int or way["id"] <= 0
                or tags.get("highway") not in ROAD_CLASSES or tags.get("area") == "yes"
                or not isinstance(coords, list) or len(coords) < 2
                or ("nodes" in way and len(way["nodes"]) != len(coords))):
            raise ValueError("Invalid OSM way.")
        line = geometry_positions(coords)
        properties = {"osm_way_id": str(way["id"]), "highway": tags["highway"]}
        road = (line, properties)
        if roads.setdefault(way["id"], road) != road:
            raise ValueError("Conflicting OSM way versions.")
    if count != len(roads):
        raise ValueError("OSM way count does not match the response.")

    return {
        "type": "FeatureCollection",
        "features": [
            {"type": "Feature", "geometry": {"type": "LineString", "coordinates": section},
             "properties": properties}
            for line, properties in roads.values()
            for section in _clip_line(line, bounds)
        ],
    }


def checked_elements(data, count_key, limit, limit_code, limit_message):
    if not isinstance(data, dict) or data.get("remark") or not isinstance(data.get("elements"), list):
        raise ValueError("Incomplete Overpass response.")
    elements = data["elements"]
    if not elements or elements[-1]["type"] != "count":
        raise ValueError("Overpass response has no completion count.")
    raw_count = elements[-1]["tags"][count_key]
    if not isinstance(raw_count, str) or not raw_count.isascii() or not raw_count.isdecimal():
        raise ValueError("Invalid Overpass count.")
    count = int(raw_count)
    if count > limit or len(elements) > limit + 1:
        raise RoadNetworkError(422, limit_code, limit_message)
    return elements[:-1], count


def geometry_positions(coords):
    line = []
    for point in coords:
        lon, lat = point["lon"], point["lat"]
        if (type(lon) not in (int, float) or type(lat) not in (int, float)
                or not (-180 <= lon <= 180 and -90 <= lat <= 90)):
            raise ValueError("Invalid OSM coordinate.")
        if not line or line[-1] != [lon, lat]:
            line.append([lon, lat])
    return line


class OverpassClient:
    """Bounded transport and cache shared by the Basic and Agent query services."""

    def __init__(self, client, endpoint, *, queue_timeout=4, request_timeout=10, cache_ttl=300):
        self.client = client
        self.endpoint = endpoint
        self.queue_timeout = queue_timeout
        self.request_timeout = request_timeout
        self.cache_ttl = cache_ttl
        self._slot = asyncio.Semaphore(1)
        self._inflight = {}
        self._cache = OrderedDict()

    async def get(self, key):
        cached = self._cache.pop(key, None)
        if cached and time.monotonic() < cached[0]:
            self._cache[key] = cached
            return cached[1]
        task = self._inflight.get(key)
        if task is None:
            task = asyncio.create_task(self._fetch(key))
            self._inflight[key] = task
            task.add_done_callback(self._consume_error)
        return await asyncio.shield(task)

    @staticmethod
    def _consume_error(task):
        if not task.cancelled():
            task.exception()

    async def close(self):
        tasks = tuple(self._inflight.values())
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._inflight.clear()
        self._cache.clear()

    subject = "OSM"

    async def _fetch(self, key):
        try:
            try:
                await asyncio.wait_for(self._slot.acquire(), self.queue_timeout)
            except TimeoutError as exc:
                raise RoadNetworkError(503, "osm_queue_full", f"{self.subject} requests are busy. Retry shortly.") from exc
            try:
                result = await asyncio.wait_for(self._request(key), self.request_timeout)
            finally:
                self._slot.release()
            self._cache[key] = (time.monotonic() + self.cache_ttl, result)
            if len(self._cache) > 4:
                self._cache.popitem(last=False)
            return result
        except (httpx.TimeoutException, TimeoutError) as exc:
            raise RoadNetworkError(504, "osm_timeout", f"The {self.subject.lower()} provider timed out. Try again.") from exc
        except (httpx.HTTPError, httpx.InvalidURL, ValueError, KeyError, TypeError, AttributeError) as exc:
            raise RoadNetworkError(502, "osm_unavailable",
                                   f"The {self.subject.lower()} provider returned an incomplete or invalid response. Try again.") from exc
        finally:
            self._inflight.pop(key, None)

    async def response_body(self, query, *, limit_code, limit_message):
        async with self.client.stream("POST", self.endpoint, data={"data": query}, follow_redirects=False) as response:
            if response.status_code == 429:
                raise RoadNetworkError(503, "osm_rate_limited", f"The {self.subject.lower()} provider is busy. Retry shortly.")
            if response.status_code == 504:
                raise RoadNetworkError(504, "osm_timeout", f"The {self.subject.lower()} provider timed out. Try again.")
            response.raise_for_status()
            body = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=64_000):
                if len(body) + len(chunk) > MAX_OVERPASS_BYTES:
                    raise RoadNetworkError(422, limit_code, limit_message)
                body.extend(chunk)
        return body


class OverpassRoads(OverpassClient):
    subject = "Road"

    async def _request(self, bounds):
        west, south, east, north = bounds
        bbox = ",".join(str(value) for value in (south, west, north, east))
        query = (
            f'[out:json][timeout:8];way["highway"~"^({"|".join(ROAD_CLASSES)})$"]["area"!="yes"]({bbox});'
            f'out geom {MAX_WAYS + 1};out count;'
        )
        body = await self.response_body(query, limit_code="road_limit",
                                        limit_message="The road provider response exceeds the grid budget.")
        return await asyncio.to_thread(self._build_result, body, bounds)

    @staticmethod
    def _build_result(body, bounds):
        result = _parse_overpass(json.loads(body), bounds)
        payload = json.dumps(result, separators=(",", ":")).encode("utf-8")
        if len(payload) > MAX_RESULT_BYTES:
            raise RoadNetworkError(422, "road_limit", "The road layer exceeds the grid budget.")
        return payload
