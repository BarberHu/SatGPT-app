from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import sqlite3
import tempfile
import threading
import unittest
from urllib.parse import parse_qs
from unittest.mock import patch

from shapely.geometry import Polygon

from harness.app.controller import TaskController
from harness.app.regional_osm import SCHEMA_VERSION
from harness.tests.runtime_fixture import client_for, task_body, wait_for_task
from harness.tests.test_cancellation import emit
from harness.tests.test_osm_queries import BOUNDS, box, obj, positions, response


ROOT = Path(__file__).resolve().parents[1]
TOOLS = {
    "osm_roads": {"show_on_map": True},
    "osm_pois": {"category": "hospital"},
    "osm_buildings": {"show_on_map": True},
    "gee_layer": {"name": "Fixture flood extent", "code": "result = ee.Image(1)", "bounds": BOUNDS},
}


def emit_tools(handler, tool_calls):
    events = [{"type": "message_start", "message": {"id": "msg_osm_probe", "model": "smoke-model",
                                                      "usage": {"input_tokens": 3, "output_tokens": 0}}}]
    for index, (name, args) in enumerate(tool_calls):
        events += [
            {"type": "content_block_start", "index": index,
             "content_block": {"type": "tool_use", "id": f"call_{index}_{name}", "name": name, "input": {}}},
            {"type": "content_block_delta", "index": index,
             "delta": {"type": "input_json_delta", "partial_json": json.dumps(args)}},
            {"type": "content_block_stop", "index": index},
        ]
    events += [{"type": "message_delta", "delta": {"stop_reason": "tool_use"}, "usage": {"output_tokens": 3}},
               {"type": "message_stop"}]
    for event in events:
        handler.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())


@contextmanager
def osm_sdk_fixture(*, tool_calls=None, overpass_reply=None, followup=None, snapshot=None):
    seen = {'requests': []}
    if tool_calls is None:
        tool_calls = tuple(TOOLS.items())

    class FixtureProvider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = self.rfile.read(int(self.headers["Content-Length"]))
            if self.path == "/overpass":
                query = parse_qs(body.decode())["data"][0]
                if overpass_reply is not None:
                    status, payload = overpass_reply(query)
                else:
                    if '["highway"' in query:
                        element = obj("way", 11, {"highway": "primary"},
                                      geometry=positions([(9.99, 20.004), (10.03, 20.015)]))
                    elif '["amenity"' in query:
                        element = obj("node", 12, {"amenity": "hospital", "name": "Fixture hospital"}, lon=10.008, lat=20.012)
                    else:
                        element = obj("way", 13, {"building": "yes"}, geometry=positions(box(10.009, 20.006, 10.015, 20.012)))
                    status, payload = 200, response(element)
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(payload).encode())
                return

            request = json.loads(body)
            seen['requests'].append(request['messages'])
            seen["tools"] = {item["name"] for item in request.get("tools", [])}
            message = request["messages"][-1]
            latest = json.dumps(message)
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            extra_calls = followup(message, seen) if followup else None
            if extra_calls:
                emit_tools(self, extra_calls)
            elif "OSM_SDK_PROBE" in latest and '"type": "tool_result"' not in latest:
                emit_tools(self, tool_calls)
            else:
                emit(self, "Fixture query finished.")

    provider = ThreadingHTTPServer(("127.0.0.1", 0), FixtureProvider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        url = f"http://127.0.0.1:{provider.server_port}"
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "DSH_PROVIDER": "deepseek-official", "DSH_MODEL": "smoke-model",
            "DSH_REASONING_EFFORT": "default", "DEEPSEEK_API_KEY": "local-fixture-key", "DEEPSEEK_BASE_URL": url,
            "SATGPT_OSM_TOOLS": "1", "SATGPT_OVERPASS_URL": url + "/overpass",
            "SATGPT_OSM_SNAPSHOT_DIR": "", "SATGPT_ROAD_SNAPSHOT": "",
            "SATGPT_PUBLIC_ORIGIN": "", "SATGPT_COOKIE_SECURE": "false", "NO_PROXY": "127.0.0.1,localhost",
        }):
            root = Path(directory)
            if snapshot:
                snapshot(root)
                os.environ['SATGPT_OSM_SNAPSHOT_DIR'] = str(root)
            app = root / "app"
            app.mkdir()
            worker_errors = app / "osm-error.log"
            (app / "osm_worker.py").write_text(
                f"import runpy, traceback\ntry:\n    runpy.run_path({str(ROOT / 'app' / 'osm_worker.py')!r}, run_name='__main__')\n"
                f"except Exception:\n    with open({str(worker_errors)!r}, 'w') as log:\n        traceback.print_exc(file=log)\n    raise\n",
                encoding="utf-8")
            (app / "gee_worker.py").write_text(f"import sys\nsys.path.insert(0, {str(ROOT / 'app')!r})\n" + """import json
from osm_raster_analysis import prepare, format_result, resolve_input
for line in sys.stdin:
    request = json.loads(line)
    payload = request['payload']
    try:
        if payload.get('operation') == 'osm_analysis':
            payload = resolve_input(payload)
            settings, source, features = prepare(payload)
            metrics = ({'sample_value': 1} if settings['mode'] == 'point_sample'
                       else {'grid_area_m2': 100, 'observed_area_m2': 50, 'flood_area_m2': 25})
            rows = {'features': [{'properties': {'osm_key': key, **metrics}} for key in features]}
            data = format_result(payload, settings, source, features, rows)
        elif payload.get('operation') in ('geo_search', 'geo_info'):
            from gee_worker import execute
            data = execute(payload)
        elif payload.get('layer_code'):
            data = {'thumbnail_ref': 'a' * 32, 'layer': {'name': 'Fixture flood extent', 'metadata': {'source': 'Fixture GEE'},
                              'url': 'https://earthengine.googleapis.com/v1/projects/test/maps/flood/tiles/{z}/{x}/{y}'}}
        else:
            data = {}
    except ValueError as exc:
        print(json.dumps({'id':request['id'], 'ok':False, 'error':str(exc)}), flush=True)
        continue
    print(json.dumps({'id':request['id'], 'ok':True, 'data':data}), flush=True)
""", encoding="utf-8")
            controller = TaskController(root, state=root / "state")
            try:
                yield controller, seen
            finally:
                controller.close()
    finally:
        provider.shutdown()
        provider.server_close()


class OSMSDKTests(unittest.TestCase):
    def test_outbound_model_messages_keep_online_and_snapshot_artifacts_out_of_context(self):
        count = 192
        marker = 'OSM_PRIVATE_FEATURE_MARKER_58'
        inner = 10.006731029
        polygon = Polygon(box(inner, 20.005, 10.01, 20.01))

        def snapshot(root):
            with sqlite3.connect(root / 'fixture.sqlite3') as db:
                db.executescript(f'''PRAGMA user_version={SCHEMA_VERSION};
                    CREATE TABLE snapshot(data TEXT);
                    CREATE TABLE features(id INTEGER PRIMARY KEY, kind TEXT, osm_type TEXT, osm_id INTEGER,
                                          category TEXT, name TEXT, geometry BLOB);
                    CREATE VIRTUAL TABLE feature_bounds USING rtree(id,min_x,max_x,min_y,max_y);''')
                meta = {'coverage': {'type': 'Polygon', 'coordinates': [box(*BOUNDS)]},
                        'source': 'Fixture snapshot', 'source_url': '', 'source_sha256': 'test',
                        'osm_data_time': '2026-01-01', 'skipped': {'buildings': 0}}
                db.execute('INSERT INTO snapshot VALUES(?)', (json.dumps(meta),))
                west, south, east, north = polygon.bounds
                for identifier in range(1, count + 1):
                    db.execute('INSERT INTO features VALUES(?,\'buildings\',\'way\',?,\'yes\',?,?)',
                               (identifier, identifier, marker, polygon.wkb))
                    db.execute('INSERT INTO feature_bounds VALUES(?,?,?,?,?)', (identifier, west, east, south, north))

        calls = []

        def overpass(query):
            calls.append(query)
            if '["building"' in query:
                return 429, {}
            if '["highway"' in query:
                return 200, response(*(obj('way', i, {'highway': 'primary', 'name': marker},
                                          geometry=positions([(inner, 20.005), (10.01, 20.01)]))
                                       for i in range(1, count + 1)))
            return 200, response(*(obj('node', i, {'amenity': 'hospital', 'name': marker}, lon=inner, lat=20.005)
                                   for i in range(1, count + 1)))

        def followup(message, seen):
            if 'OSM_SDK_REUSE' in json.dumps(message):
                return [('geo_data_search', {})]
            items = message.get('content') or []
            results = [item for item in items if isinstance(item, dict) and item.get('type') == 'tool_result']
            if not results:
                return None
            first = results[0]
            if first.get('tool_use_id') != 'call_0_geo_data_search':
                return None
            data = first['content']
            hits = json.loads(data if isinstance(data, str) else data[0]['text'])['results']
            refs = {item['kind']: item['data_ref'] for item in hits}
            seen['indexed'] = refs
            grid = {'code': 'result = ee.Image(1)', 'band': 'constant', 'crs': 'EPSG:3857', 'scale': 10,
                    'raster_source': 'Fixture raster', 'observed_at': '2026-01-01', 'show_on_map': True}
            return [('geo_data_info', {'data_ref': refs['buildings']}),
                    ('gee_osm_analyze', {**grid, 'mode': 'point_sample', 'osm_data_ref': refs['pois']}),
                    ('gee_osm_analyze', {**grid, 'mode': 'building_flood', 'osm_data_ref': refs['buildings']})]

        with osm_sdk_fixture(tool_calls=tuple(TOOLS.items())[:3], overpass_reply=overpass,
                             followup=followup, snapshot=snapshot) as (controller, seen):
            owner = client_for(controller)
            first = owner.post('/api/harness/tasks', json=task_body(None, 'OSM_SDK_PROBE', bounds=BOUNDS))
            first.raise_for_status()
            result = wait_for_task(owner, first.json()['id'], timeout=25)
            self.assertEqual(result['status'], 'completed', result.get('trace'))
            summaries = {row['name']: json.loads(row['result']) for row in result['trace'] if row.get('name') in TOOLS}
            for name, summary in summaries.items():
                self.assertEqual(summary['count'], count)
                self.assertTrue(summary['data_ref'].startswith('g_'))
                self.assertEqual(summary['source_mode'], 'regional_snapshot' if name == 'osm_buildings' else 'overpass')
            self.assertEqual(summaries['osm_buildings']['fallback_reason'], 'osm_rate_limited')
            for layer in result['output']['layers']:
                artifact = owner.get(layer['data_url']).json()
                self.assertEqual(len(artifact['features']), count)
                self.assertIn(marker, json.dumps(artifact))
                self.assertIn(str(inner), json.dumps(artifact))
            second = owner.post('/api/harness/tasks', json=task_body(result['conversation_id'], 'OSM_SDK_REUSE',
                                                                    bounds=[11, 20, 11.01, 20.01]))
            second.raise_for_status()
            reused = wait_for_task(owner, second.json()['id'], timeout=25)
            self.assertEqual(reused['status'], 'completed', reused.get('trace'))
            self.assertEqual(seen['indexed'], {key.removeprefix('osm_'): val['data_ref'] for key, val in summaries.items()})
            self.assertEqual(len(calls), 3)
            analysis_rows = [row for row in reused['trace'] if row.get('name') == 'gee_osm_analyze']
            self.assertEqual([row['status'] for row in analysis_rows], ['done', 'done'], analysis_rows)
            analysis = [json.loads(row['result']) for row in analysis_rows]
            self.assertEqual([item['count'] for item in analysis], [count, count])
            self.assertEqual(len(reused['output']['layers']), 2)
            for layer in reused['output']['layers']:
                self.assertEqual(layer['bounds'], BOUNDS)
                self.assertIn(marker, owner.get(layer['data_url']).text)
            outgoing = json.dumps(seen['requests'])
            for word in (marker, str(inner), 'FeatureCollection', r'\"features\"', r'\"geometry\"',
                         r'\"coordinates\"', 'artifact_dir', '.geojson'):
                self.assertNotIn(word, outgoing)
            for val in summaries.values():
                self.assertIn(val['artifact_ref'], outgoing)
                self.assertIn(val['data_ref'], outgoing)

    def test_native_sdk_chains_osm_sources_into_analysis_and_keeps_results_task_owned(self):
        calls = [("osm_pois", {"category": "hospital"}), ("osm_buildings", {})]
        args = dict(code="result = ee.Image(1)", band="constant", crs="EPSG:3857", scale=10,
                    raster_source="Fixture raster", observed_at="2026-01-01", show_on_map=True)

        def followup(message, seen):
            content = message.get('content') or []
            if 'OSM_SDK_STALE' in json.dumps(message):
                return [('gee_osm_analyze', {**args, 'osm_ref': seen['refs'][0], 'mode': 'point_sample'})]
            results = [item['content'] for item in content if isinstance(item, dict) and item.get('type') == 'tool_result']
            if not results or 'refs' in seen:
                return None
            refs = []
            for result in results:
                text = result if isinstance(result, str) else result[0]['text']
                refs.append(json.loads(text)['artifact_ref'])
            seen['refs'] = refs
            return [('gee_osm_analyze', {**args, 'osm_ref': ref, 'mode': mode,
                                        **({'hit_value': 1} if mode == 'point_sample' else {})})
                    for ref, mode in zip(refs, ('point_sample', 'building_flood'), strict=True)]

        with osm_sdk_fixture(tool_calls=calls, followup=followup) as (controller, seen):
            owner = client_for(controller)
            area = {'type': 'Polygon', 'coordinates': [box(10, 20, 10.012, 20.02)]}
            receipt = owner.post('/api/harness/tasks', json=task_body(None, 'OSM_SDK_PROBE', bounds=BOUNDS,
                                                                    analysis_region=area)).json()
            record = wait_for_task(owner, receipt['id'], timeout=20)
            self.assertEqual(record['status'], 'completed', record.get('trace'))
            self.assertIn('gee_osm_analyze', seen['tools'])
            trace = [row for row in record['trace'] if row.get('name') == 'gee_osm_analyze']
            self.assertEqual([json.loads(row['result'])['hit_count'] for row in trace], [1, 1], record['trace'])
            layers = {layer['renderAs']: layer for layer in record['output']['layers'] if layer['visible']}
            self.assertEqual(set(layers), {'circle', 'fill'})
            point = owner.get(layers['circle']['data_url']).json()['features'][0]
            polygon_url = layers['fill']['data_url']
            building = owner.get(polygon_url).json()['features'][0]
            self.assertEqual(point['properties']['sample_value'], 1)
            self.assertEqual(building['properties']['flood_area_m2'], 25)
            self.assertAlmostEqual(max(lon for lon, _ in building['geometry']['coordinates'][0]), 10.012)
            outsider = client_for(controller)
            self.assertEqual(outsider.get(polygon_url).status_code, 404)
            for client in (owner, outsider):
                receipt = client.post('/api/harness/tasks', json=task_body(None, 'OSM_SDK_STALE', bounds=BOUNDS)).json()
                record = wait_for_task(client, receipt['id'], timeout=15)
                trace = [row for row in record['trace'] if row.get('name') == 'gee_osm_analyze']
                self.assertEqual(len(trace), 1, record['trace'])
                self.assertIn('unavailable in this task', str(trace[0]))
                self.assertFalse(record['output']['layers'])

    def test_native_sdk_preserves_poi_summaries_and_only_publishes_a_successful_layer(self):
        tool_calls = tuple(("osm_pois", {"category": category, "show_on_map": visible}) for category, visible in (
            ("hospital", True), ("hospital", False), ("pharmacy", True), ("school", True),
        ))
        upstream_calls = []

        def overpass_reply(query):
            upstream_calls.append(query)
            if '["amenity"="hospital"]' in query:
                return 200, response()
            if '["amenity"="pharmacy"]' in query:
                return 504, {"remark": "Query timed out."}
            return 200, response(obj("node", 14, {"amenity": "school"}, lon=10.008, lat=20.012))

        with osm_sdk_fixture(tool_calls=tool_calls, overpass_reply=overpass_reply) as (controller, _):
            owner = client_for(controller)
            for bounds, expected in (
                ([10, 20, 12, 22], ["area_limit"] * 4),
                (BOUNDS, ["empty", "empty", "osm_timeout", "ok"]),
            ):
                with self.subTest(expected=expected):
                    accepted = owner.post("/api/harness/tasks", json=task_body(None, "OSM_SDK_PROBE", bounds=bounds))
                    accepted.raise_for_status()
                    record = wait_for_task(owner, accepted.json()["id"], timeout=15)
                    self.assertEqual(record["status"], "completed", record.get("error"))
                    trace = [entry for entry in record["trace"] if entry.get("name") == "osm_pois"]
                    self.assertEqual([entry["status"] for entry in trace], ["done"] * 4, trace)
                    self.assertEqual([json.loads(entry["result"])["status"] for entry in trace], expected)
                    layers = record["output"]["layers"]
                    if expected[-1] == "area_limit":
                        self.assertEqual(upstream_calls, [])
                        self.assertEqual(layers, [])
                    else:
                        for entry in trace[:2]:
                            self.assertEqual(json.loads(entry["result"])["count"], 0)
                        self.assertEqual(len(layers), 1)
                        self.assertEqual(layers[0]["renderAs"], "circle")
                        self.assertTrue(layers[0]["visible"])
                        download = owner.get(layers[0]["data_url"])
                        download.raise_for_status()
                        self.assertEqual(download.json()["features"][0]["geometry"]["type"], "Point")

    def test_local_sdk_projects_three_osm_artifacts_and_an_existing_gee_layer(self):
        with osm_sdk_fixture() as (controller, seen):
            owner = client_for(controller)
            receipt = owner.post("/api/harness/tasks", json=task_body(None, "OSM_SDK_PROBE", bounds=BOUNDS)).json()
            record = wait_for_task(owner, receipt["id"], timeout=15)
            self.assertEqual(record["status"], "completed", (record.get("error"), record.get("trace"), seen))
            self.assertTrue(set(TOOLS).issubset(seen["tools"]))
            layers = record["output"]["layers"]
            osm_layers = {layer["renderAs"]: layer for layer in layers if layer.get("kind") == "geojson"}
            worker_errors = controller.root / "app" / "osm-error.log"
            self.assertEqual(set(osm_layers), {"line", "circle", "fill"},
                             worker_errors.read_text() if worker_errors.exists() else record.get("trace"))
            self.assertTrue(any(layer["name"] == "Fixture flood extent" for layer in layers), record.get('trace'))
            self.assertFalse(osm_layers["circle"]["visible"])
            self.assertTrue(osm_layers["line"]["visible"])
            for render_as, feature_type in (("line", "LineString"), ("circle", "Point"), ("fill", "Polygon")):
                url = osm_layers[render_as]["data_url"]
                result = owner.get(url)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["features"][0]["geometry"]["type"], feature_type)
                self.assertEqual(client_for(controller).get(url).status_code, 404)
