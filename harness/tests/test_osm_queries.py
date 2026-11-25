import asyncio
from dataclasses import dataclass
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

from fastapi import FastAPI
from fastapi.testclient import TestClient
import httpx
from shapely.geometry import shape

from harness.app.osm_building_partitions import MAX_MERGED_BYTES
from harness.app.osm_queries import ATTRIBUTION, OverpassQueries
from harness.app.osm_transport import RoadNetworkError
from harness.app.controller import TaskController
from harness.app.identity import owner_for
from harness.app.osm_worker import execute
from harness.app.server import router
from harness.app.session_store import SessionStore, encode


BOUNDS = [10, 20, 10.02, 20.02]


def positions(points):
    return [{"lon": x, "lat": y} for x, y in points]


def box(west, south, east, north):
    return [[west, south], [east, south], [east, north], [west, north], [west, south]]


def obj(osm_type, identifier, tags, **geometry):
    return {"type": osm_type, "id": identifier, "tags": tags, **geometry}


def response(*items, count=None):
    return {"osm3s": {"timestamp_osm_base": "2026-11-01T00:00:00Z"},
            "elements": [*items, {"type": "count", "tags": {"total": str(len(items) if count is None else count)}}]}


class OSMQueryTests(unittest.IsolatedAsyncioTestCase):
    async def test_buildings_prepartition_large_area_and_clip_once_at_original_boundary(self):
        bounds = [10, 20, 10.12, 20.08]
        hole = box(10.058, 20.02, 10.062, 20.03)
        exterior = box(10.05, 20.01, 10.07, 20.04)
        region = {'type': 'Polygon', 'coordinates': [box(*bounds), hole]}
        way = obj('way', 7, {'building': 'yes'}, geometry=positions(exterior))
        relation = obj('relation', 8, {'building': 'yes'}, members=[
            {'type': 'way', 'ref': 7, 'role': 'outer', 'geometry': positions(exterior)}])
        calls = []

        def respond(req):
            calls.append(parse_qs(req.content.decode())['data'][0])
            fixture = response(way) if len(calls) == 1 else response(relation)
            fixture['osm3s']['timestamp_osm_base'] = f'2026-11-01T00:00:0{len(calls)}Z'
            return httpx.Response(200, json=fixture)

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = OverpassQueries(client, 'https://osm.test')
            with tempfile.TemporaryDirectory() as directory:
                result = await execute(service, {'kind': 'buildings', 'bounds': bounds, 'analysis_region': region,
                                                 'artifact_dir': directory})
                path, = Path(directory).glob('*.geojson')
                collection = json.loads(path.read_bytes())
        self.assertEqual(len(calls), 2)
        self.assertEqual(result['bounds'], bounds)
        self.assertEqual(result['summary']['partition_count'], 2)
        self.assertEqual(len(result['summary']['osm_data_time_range']), 2)
        feature, = collection['features']
        self.assertEqual(feature['properties']['osm_type'], 'relation')
        self.assertTrue(shape(feature['geometry']).equals(shape({'type': 'Polygon', 'coordinates': [exterior, hole]})))

    async def test_building_candidates_split_on_limit_and_reject_conflicting_objects(self):
        tags = {'building': 'house'}
        geometry = positions(box(10.005, 20.004, 10.015, 20.018))
        original = obj('way', 9, tags, geometry=geometry)
        for conflict in (False, True):
            with self.subTest(conflict=conflict), tempfile.TemporaryDirectory() as directory:
                duplicate = obj('way', 9, {**tags, 'name': 'Changed'}, geometry=geometry) if conflict else original
                replies = iter([response(count=4_001), response(original), response(duplicate)])
                transport = httpx.MockTransport(lambda _: httpx.Response(200, json=next(replies)))
                async with httpx.AsyncClient(transport=transport) as client, \
                        asyncio.timeout(2):
                    service = OverpassQueries(client, 'https://osm.test')
                    with patch.dict('os.environ', {'SATGPT_OSM_SNAPSHOT_DIR': ''}):
                        payload = {'kind': 'buildings', 'bounds': BOUNDS, 'artifact_dir': directory}
                        if conflict:
                            with self.assertRaisesRegex(RoadNetworkError, 'conflicting versions'):
                                await execute(service, payload)
                            self.assertFalse(list(Path(directory).iterdir()))
                        else:
                            result = await execute(service, payload)
                            self.assertEqual(result['summary']['partition_count'], 2)
                            self.assertEqual(result['summary']['count'], 1)

    async def test_building_partition_failure_and_cancellation_publish_nothing(self):
        building = obj('way', 9, {'building': 'yes'}, geometry=positions(box(10.01, 20.01, 10.02, 20.02)))
        bounds = [10, 20, 10.12, 20.08]
        for cancel in (False, True):
            with self.subTest(cancel=cancel), tempfile.TemporaryDirectory() as directory:
                started = asyncio.Event()
                calls = 0

                async def respond(_request):
                    nonlocal calls
                    calls += 1
                    if calls == 1:
                        return httpx.Response(200, json=response(building))
                    started.set()
                    if cancel:
                        await asyncio.Future()
                    return httpx.Response(429)

                async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                    service = OverpassQueries(client, 'https://osm.test')
                    payload = {'kind': 'buildings', 'bounds': bounds, 'artifact_dir': directory}
                    with patch.dict('os.environ', {'SATGPT_OSM_SNAPSHOT_DIR': ''}):
                        if cancel:
                            task = asyncio.create_task(execute(service, payload))
                            await asyncio.wait_for(started.wait(), 2)
                            task.cancel()
                            with self.assertRaises(asyncio.CancelledError):
                                await task
                        else:
                            with self.assertRaises(RoadNetworkError) as caught:
                                await execute(service, payload)
                            self.assertEqual(caught.exception.code, 'osm_rate_limited')
                    await service.close()
                self.assertEqual(calls, 2)
                self.assertFalse(list(Path(directory).iterdir()))

    async def test_roads_clip_to_polygon_and_hole_with_one_count_per_way(self):
        calls = []

        def respond(request):
            calls.append(parse_qs(request.content.decode())["data"][0])
            road = obj("way", 7, {"highway": "primary"}, geometry=positions([(9.99, 20.01), (10.04, 20.01)]))
            return httpx.Response(200, json=response(road))

        region = {"type": "Polygon", "coordinates": [box(*BOUNDS), box(10.006, 20.006, 10.014, 20.014)]}
        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = OverpassQueries(client, "https://osm.test/interpreter")
            summary, content = await service.query("roads", "major", region, BOUNDS)
            self.assertEqual(await service.query("roads", "major", region, BOUNDS), (summary, content))
        self.assertEqual(len(calls), 1)
        self.assertTrue(calls[0].startswith("[out:json][timeout:25];"))
        self.assertIn("primary_link", calls[0])
        self.assertEqual(summary["by_category"], {"primary": 1})
        self.assertEqual(summary["osm_data_time"], "2026-11-01T00:00:00+00:00")
        line = json.loads(content)["features"][0]["geometry"]
        self.assertEqual(line, {"type": "MultiLineString", "coordinates": [
            [[10, 20.01], [10.006, 20.01]], [[10.014, 20.01], [10.02, 20.01]],
        ]})

    async def test_poi_nodes_and_area_points_use_multipolygon_scope(self):
        tagged = {"amenity": "hospital"}
        node = obj("node", 2, {**tagged, "name": "Hospital A"}, lat=20.003, lon=10.003)
        outside = obj("node", 3, tagged, lat=20.01, lon=10.01)
        campus = obj("way", 2, tagged, geometry=positions(box(10.013, 20.013, 10.03, 20.03)))
        open_way = obj("way", 4, tagged, geometry=positions([[10.003, 20.003], [10.004, 20.004]]))
        region = {"type": "MultiPolygon", "coordinates": [[box(10, 20, 10.006, 20.006)], [box(10.014, 20.014, 10.02, 20.02)]]}
        async def request(req):
            self.assertIn('node["amenity"="hospital"]', parse_qs(req.content.decode())["data"][0])
            return httpx.Response(200, json=response(node, outside, campus, open_way))

        async with httpx.AsyncClient(transport=httpx.MockTransport(request)) as client:
            service = OverpassQueries(client, "https://osm.test")
            summary, content = await service.query("pois", "hospital", region, BOUNDS)
        self.assertEqual(summary["count"], 2)
        self.assertEqual(summary["skipped_geometry"], 1)
        self.assertEqual(summary["examples"], ["Hospital A"])
        features = json.loads(content)["features"]
        self.assertTrue(all(f["geometry"]["type"] == "Point" for f in features))
        self.assertTrue(10.014 < features[1]["geometry"]["coordinates"][0] < 10.02)

    async def test_building_multipolygon_retains_inner_ring_and_writes_only_one_artifact(self):
        exterior = box(10.002, 20.002, 10.018, 20.018)
        hole = box(10.005, 20.005, 10.010, 20.010)
        tagged = {"building": "yes"}
        way = obj("way", 7, tagged, geometry=positions(exterior))
        relation = obj("relation", 8, tagged, members=[
            {"type": "way", "ref": 7, "role": "outer", "geometry": positions(exterior)},
            {"type": "way", "ref": 9, "role": "inner", "geometry": positions(hole[:3])},
            {"type": "way", "ref": 10, "role": "inner", "geometry": positions(hole[2:])},
        ])
        transport = httpx.MockTransport(lambda req: httpx.Response(200, json=response(way, relation)))
        async with httpx.AsyncClient(transport=transport) as client:
            service = OverpassQueries(client, "https://osm.test")
            with tempfile.TemporaryDirectory() as directory:
                result = await execute(service, {"kind": "buildings", "bounds": BOUNDS, "artifact_dir": directory})
                path = Path(directory) / f'{result["artifact_ref"]}.geojson'
                self.assertEqual(list(path.parent.iterdir()), [path])
                features = json.loads(path.read_bytes())["features"]
                self.assertEqual(features[0]["properties"]["osm_type"], "relation")
                self.assertEqual(len(features[0]["geometry"]["coordinates"]), 2)
                self.assertEqual(result["summary"]["count"], 1)
                self.assertEqual(result["summary"]["attribution"], ATTRIBUTION)

    async def test_empty_query_limit_timeout_and_invalid_upstream_are_distinct(self):
        with tempfile.TemporaryDirectory() as directory:
            async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: httpx.Response(200, json=response()))) as client:
                service = OverpassQueries(client, "https://osm.test")
                result = await execute(service, {"kind": "buildings", "bounds": BOUNDS, "artifact_dir": directory})
                self.assertEqual(result["summary"]["status"], "empty")
                self.assertFalse(list(Path(directory).iterdir()))

        for fixture, code in ((httpx.Response(200, json=response(count=4_001)), "feature_limit"),
                              (httpx.Response(200, json=response(count=2)), "osm_unavailable"),
                              (httpx.Response(429), "osm_rate_limited"), (httpx.Response(504), "osm_timeout"),
                              (httpx.Response(200, json={"remark": "Query timed out."}), "osm_timeout")):
            with self.subTest(code=code):
                async with httpx.AsyncClient(transport=httpx.MockTransport(lambda req: fixture)) as client:
                    service = OverpassQueries(client, "https://osm.test")
                    with self.assertRaises(RoadNetworkError) as caught:
                        await service.query("buildings", None, None, BOUNDS)
                    self.assertEqual(caught.exception.code, code)

    async def test_deduplicated_requests_allow_one_waiter_to_cancel(self):
        started, release = asyncio.Event(), asyncio.Event()
        calls = 0

        async def respond(req):
            nonlocal calls
            calls += 1
            started.set()
            await release.wait()
            return httpx.Response(200, json=response())

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            service = OverpassQueries(client, "https://osm.test")
            first = asyncio.create_task(service.query("buildings", None, None, BOUNDS))
            await started.wait()
            second = asyncio.create_task(service.query("buildings", None, None, BOUNDS))
            first.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await first
            release.set()
            self.assertEqual((await second)[0]["status"], "empty")
            self.assertEqual(calls, 1)


@dataclass
class ProjectedTask:
    receipt: dict
    run_id: str


class OSMArtifactTests(unittest.TestCase):
    def test_project_and_serve_only_published_result_for_the_correct_task_and_owner(self):
        with tempfile.TemporaryDirectory() as directory:
            controller = TaskController.__new__(TaskController)
            controller.state = Path(directory)
            controller.store = SessionStore(controller.state / "test.sqlite")
            owner, task_id, reference, run_id = "alice", "a" * 32, "b" * 32, "c" * 32
            with controller.store.connect(write=True) as db:
                cid = controller.store.new(db, owner)
                another_cid = controller.store.new(db, owner)
            task = ProjectedTask({"id": task_id, "conversation_id": cid}, run_id)
            meta = {"task_id": task_id, "run_id": run_id, "layer": {
                "kind": "geojson", "renderAs": "line", "artifact_ref": reference, "visible": False,
                "name": "OSM roads", "bounds": BOUNDS, "metadata": {"source": ATTRIBUTION}, "data": "not persisted",
            }}
            output = controller._project(task, [{"type": "tool/result", "seq": 1, "data": {"meta": meta}}], {})
            layer = output["layers"][0]
            self.assertNotIn("data", layer)
            orphan_id = "d" * 32
            root = Path(controller._artifact_fields(owner, cid, task_id)["artifact_dir"])
            root.mkdir(parents=True)
            body = b'{"type":"FeatureCollection","features":[]}'
            for identifier in (reference, orphan_id):
                (root / f"{identifier}.geojson").write_bytes(body)
            record = {**task.receipt, "status": "completed", "output": output}
            with controller.store.connect(write=True) as db:
                db.execute("INSERT INTO tasks VALUES(?,?,?,?,?,?,?)",
                           (task_id, cid, owner, "request", "fingerprint", "completed", encode(record)))
            app = FastAPI()
            app.include_router(router)
            app.state.controller = controller
            app.dependency_overrides[owner_for] = lambda: owner
            with TestClient(app) as client:
                result = client.get(layer["data_url"])
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.content, body)
                self.assertEqual(result.headers["content-type"], "application/geo+json")
                large_body = body.ljust(MAX_MERGED_BYTES)
                (root / f"{reference}.geojson").write_bytes(large_body)
                self.assertEqual(client.get(layer["data_url"]).content, large_body)
                self.assertEqual(client.get(layer["data_url"].replace(cid, another_cid)).status_code, 404)
                self.assertEqual(client.get(layer["data_url"].replace(reference, orphan_id)).status_code, 404)
                app.dependency_overrides[owner_for] = lambda: "mallory"
                self.assertEqual(client.get(layer["data_url"]).status_code, 404)
