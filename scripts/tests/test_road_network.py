import asyncio
import json
import unittest
from pathlib import Path
from urllib.parse import parse_qs
from unittest.mock import AsyncMock, patch

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from basic import road_network
from basic.server import router
from basic.road_network import OverpassRoads, RoadNetworkError, network_bounds


GRID_FILE = Path(__file__).resolve().parents[2] / "frontend/public/assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson"
BOUNDS = (10, 20, 11, 21)


def rectangle(west, south, east, north):
    return {"type": "Polygon", "coordinates": [[
        [west, south], [east, south], [east, north], [west, north], [west, south],
    ]]}


def osm_way(osm_id, *points):
    return {
        "type": "way", "id": osm_id, "tags": {"highway": "primary"},
        "geometry": [{"lon": lon, "lat": lat} for lon, lat in points],
    }


def osm_result(*ways, count=None):
    return {"elements": [*ways, {"type": "count", "tags": {"ways": str(len(ways) if count is None else count)}}]}


class RoadNetworkTests(unittest.IsolatedAsyncioTestCase):
    def test_all_wgs84_basic_grids_fit_the_road_query_budget(self):
        grids = json.loads(GRID_FILE.read_text(encoding="utf-8"))["features"]
        valid_count = 0
        for feature in grids:
            ring = feature["geometry"]["coordinates"][0]
            with self.subTest(grid=feature["properties"]["FID"]):
                if any(not (-180 <= lon <= 180 and -90 <= lat <= 90) for lon, lat in ring):
                    with self.assertRaises(RoadNetworkError) as caught:
                        network_bounds(feature)
                    self.assertEqual(caught.exception.code, "invalid_area")
                else:
                    network_bounds(feature)
                    valid_count += 1
        self.assertGreater(valid_count, 6000)

    def test_invalid_polygon_and_large_rectangle_are_rejected(self):
        with self.assertRaisesRegex(RoadNetworkError, "rectangular"):
            network_bounds({"type": "Polygon", "coordinates": [[[10, 20], [11, 20], [11, 21], [10, 20]]]})
        with self.assertRaisesRegex(RoadNetworkError, "40,000"):
            network_bounds(rectangle(10, 20, 14, 24))

    async def test_overpass_query_clips_roads_and_keeps_separate_sections(self):
        def respond(request):
            self.assertEqual(request.method, "POST")
            query = parse_qs(request.content.decode())["data"][0]
            self.assertIn("(20,10,21,11)", query)
            self.assertIn("primary_link", query)
            self.assertNotIn("residential", query)
            way = osm_way(100, (9, 20.25), (10.5, 20.25), (12, 20.25), (12, 20.75), (10.5, 20.75))
            touches_corner = osm_way(101, (9, 21), (10, 21), (10, 22))
            return httpx.Response(200, json=osm_result(way, touches_corner))

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            roads = OverpassRoads(client, "https://osm.test/interpreter")
            result = json.loads(await roads.get(BOUNDS))
            self.assertEqual(result["type"], "FeatureCollection")
            self.assertEqual([feature["geometry"]["coordinates"] for feature in result["features"]], [
                [[10, 20.25], [10.5, 20.25], [11, 20.25]],
                [[11, 20.75], [10.5, 20.75]],
            ])
            for feature in result["features"]:
                self.assertEqual(feature["properties"], {"osm_way_id": "100", "highway": "primary"})

    async def test_empty_result_is_shared_cached_and_independent_of_caller_cancellation(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def respond(request):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return httpx.Response(200, json=osm_result())

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            roads = OverpassRoads(client, "https://osm.test/interpreter")
            first = asyncio.create_task(roads.get(BOUNDS))
            await asyncio.wait_for(started.wait(), 1)
            second = asyncio.create_task(roads.get(BOUNDS))
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            result = await second
            self.assertEqual(json.loads(result), {"type": "FeatureCollection", "features": []})
            self.assertEqual(await roads.get(BOUNDS), result)
            self.assertEqual(calls, 1)

    async def test_incomplete_over_budget_and_rate_limited_responses(self):
        for response, status, code in (
            (httpx.Response(200, json={"elements": []}), 502, "osm_unavailable"),
            (httpx.Response(200, json=osm_result(count=1)), 502, "osm_unavailable"),
            (httpx.Response(200, json=osm_result(count=road_network.MAX_WAYS + 1)), 422, "road_limit"),
            (httpx.Response(429), 503, "osm_rate_limited"),
        ):
            with self.subTest(code=code):
                async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response)) as client:
                    with self.assertRaises(RoadNetworkError) as caught:
                        await OverpassRoads(client, "https://osm.test/interpreter").get(BOUNDS)
                    self.assertEqual((caught.exception.status_code, caught.exception.code), (status, code))

    async def test_response_byte_budget_and_timeout(self):
        async def timeout(request):
            raise httpx.ReadTimeout("fixture timeout", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
            with self.assertRaises(RoadNetworkError) as caught:
                await OverpassRoads(client, "https://osm.test/interpreter").get(BOUNDS)
            self.assertEqual((caught.exception.status_code, caught.exception.code), (504, "osm_timeout"))

        with patch.object(road_network, "MAX_OVERPASS_BYTES", 5):
            transport = httpx.MockTransport(lambda _: httpx.Response(200, json=osm_result()))
            async with httpx.AsyncClient(transport=transport) as client:
                with self.assertRaises(RoadNetworkError) as caught:
                    await OverpassRoads(client, "https://osm.test/interpreter").get(BOUNDS)
                self.assertEqual(caught.exception.code, "road_limit")


class RoadRouteTests(unittest.TestCase):
    def test_basic_route_uses_only_geometry_and_returns_geojson(self):
        app = FastAPI()
        app.include_router(router)
        result = b'{"type":"FeatureCollection","features":[]}'
        app.state.road_network = AsyncMock()
        app.state.road_network.get.return_value = result
        with TestClient(app) as client:
            response = client.post("/api/road-network", json={"geojson": rectangle(*BOUNDS)})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.headers["content-type"], "application/geo+json")
            self.assertEqual(response.content, result)
            app.state.road_network.get.assert_awaited_once_with(BOUNDS)
            response = client.post("/api/road-network", json={"geojson": {"type": "Point"}})
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["detail"]["code"], "invalid_area")
