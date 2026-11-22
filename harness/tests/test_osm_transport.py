import asyncio
import json
import unittest
from unittest.mock import patch

import httpx

from harness.app import osm_transport
from harness.app.osm_queries import OverpassQueries
from harness.app.osm_transport import RoadNetworkError
from harness.tests.test_osm_queries import BOUNDS, response as overpass_response


class OSMTransportTests(unittest.IsolatedAsyncioTestCase):
    async def test_empty_result_is_shared_cached_and_independent_of_caller_cancellation(self):
        started = asyncio.Event()
        release = asyncio.Event()
        calls = 0

        async def respond(request):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return httpx.Response(200, json=overpass_response())

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            roads = OverpassQueries(client, "https://osm.test/interpreter")
            first = asyncio.create_task(roads.query("roads", "major", None, BOUNDS))
            await asyncio.wait_for(started.wait(), 1)
            second = asyncio.create_task(roads.query("roads", "major", None, BOUNDS))
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            result = await second
            summary, content = result
            self.assertEqual(summary["status"], "empty")
            self.assertEqual(json.loads(content)["features"], [])
            self.assertEqual(await roads.query("roads", "major", None, BOUNDS), result)
            self.assertEqual(calls, 1)

    async def test_incomplete_over_budget_and_rate_limited_responses(self):
        for response, status, code in (
            (httpx.Response(200, json={"elements": []}), 502, "osm_unavailable"),
            (httpx.Response(200, json=overpass_response(count=1)), 502, "osm_unavailable"),
            (httpx.Response(200, json=overpass_response(count=osm_transport.MAX_WAYS + 1)), 422, "feature_limit"),
            (httpx.Response(429), 503, "osm_rate_limited"),
        ):
            with self.subTest(code=code):
                async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: response)) as client:
                    with self.assertRaises(RoadNetworkError) as caught:
                        await OverpassQueries(client, "https://osm.test/interpreter").query("roads", "major", None, BOUNDS)
                    self.assertEqual((caught.exception.status_code, caught.exception.code), (status, code))

    async def test_response_byte_budget_and_timeout(self):
        async def timeout(request):
            raise httpx.ReadTimeout("fixture timeout", request=request)

        async with httpx.AsyncClient(transport=httpx.MockTransport(timeout)) as client:
            with self.assertRaises(RoadNetworkError) as caught:
                await OverpassQueries(client, "https://osm.test/interpreter").query("roads", "major", None, BOUNDS)
            self.assertEqual((caught.exception.status_code, caught.exception.code), (504, "osm_timeout"))

        with patch.object(osm_transport, "MAX_OVERPASS_BYTES", 5):
            transport = httpx.MockTransport(lambda _: httpx.Response(200, json=overpass_response()))
            async with httpx.AsyncClient(transport=transport) as client:
                with self.assertRaises(RoadNetworkError) as caught:
                    await OverpassQueries(client, "https://osm.test/interpreter").query("roads", "major", None, BOUNDS)
                self.assertEqual(caught.exception.code, "feature_limit")
