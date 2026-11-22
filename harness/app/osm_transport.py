"""Bounded Overpass requests and response validation for Harness OSM tools."""

import asyncio
from collections import OrderedDict
import time

import httpx


ROAD_CLASSES = (
    "motorway", "trunk", "primary", "secondary",
    "motorway_link", "trunk_link", "primary_link", "secondary_link",
)
MAX_WAYS = 5_000
MAX_OVERPASS_BYTES = 8_000_000
MAX_RESULT_BYTES = 4_000_000


class RoadNetworkError(Exception):
    def __init__(self, status_code, code, message):
        super().__init__(message)
        self.status_code = status_code
        self.code = code


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
    """Bounded transport and cache for OpenStreetMap queries."""

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

