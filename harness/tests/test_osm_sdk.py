from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import tempfile
import threading
import unittest
from urllib.parse import parse_qs
from unittest.mock import patch

from harness.app.controller import TaskController
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
def osm_sdk_fixture(*, tool_calls=None, overpass_reply=None):
    seen = {}
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
            seen["tools"] = {item["name"] for item in request.get("tools", [])}
            latest = json.dumps(request["messages"][-1])
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            if "OSM_SDK_PROBE" in latest and '"type": "tool_result"' not in latest:
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
            "SATGPT_PUBLIC_ORIGIN": "", "SATGPT_COOKIE_SECURE": "false", "NO_PROXY": "127.0.0.1,localhost",
        }):
            root = Path(directory)
            app = root / "app"
            app.mkdir()
            worker_errors = app / "osm-error.log"
            (app / "osm_worker.py").write_text(
                f"import runpy, traceback\ntry:\n    runpy.run_path({str(ROOT / 'app' / 'osm_worker.py')!r}, run_name='__main__')\n"
                f"except Exception:\n    with open({str(worker_errors)!r}, 'w') as log:\n        traceback.print_exc(file=log)\n    raise\n",
                encoding="utf-8")
            (app / "gee_worker.py").write_text("""import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request['payload'].get('layer_code'):
        data = {'thumbnail_ref': 'a' * 32, 'layer': {'name': 'Fixture flood extent', 'metadata': {'source': 'Fixture GEE'},
                          'url': 'https://earthengine.googleapis.com/v1/projects/test/maps/flood/tiles/{z}/{x}/{y}'}}
    else:
        data = {}
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
            self.assertTrue(any(layer["name"] == "Fixture flood extent" for layer in layers))
            self.assertFalse(osm_layers["circle"]["visible"])
            self.assertTrue(osm_layers["line"]["visible"])
            for render_as, feature_type in (("line", "LineString"), ("circle", "Point"), ("fill", "Polygon")):
                url = osm_layers[render_as]["data_url"]
                result = owner.get(url)
                self.assertEqual(result.status_code, 200)
                self.assertEqual(result.json()["features"][0]["geometry"]["type"], feature_type)
                self.assertEqual(client_for(controller).get(url).status_code, 404)
