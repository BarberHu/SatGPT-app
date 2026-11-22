from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import tempfile
import threading
from time import monotonic
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from harness.app.controller import TaskController
from harness.tests.runtime_fixture import client_for, task_body, wait_for_task
from harness.tests.test_cancellation import emit
from harness.tests.test_geocoding import JINSHUI, PUBLIC_HOST
from harness.tests.test_osm_sdk import emit_tools


APP = Path(__file__).resolve().parents[1] / 'app'
POLYGON = {'type': 'Polygon', 'coordinates': [[[120, 30], [121, 30], [120, 31], [120, 30]]]}
LOOKUP = '定位郑州市金水区'
ANALYZE = '分析金水区的洪水范围'


@contextmanager
def geocoding_sdk_fixture(*, enabled=True, wait_for_upstream=None, public=False):
    seen = {'searches': [], 'requests': [], 'arrivals': [], 'replies': []}

    class FixtureProvider(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_GET(self):
            url = urlsplit(self.path)
            if url.path != '/search' or (public and url.hostname != PUBLIC_HOST):
                self.send_error(404)
                return
            seen['searches'].append(parse_qs(url.query))
            seen['arrivals'].append(monotonic())
            if wait_for_upstream and len(seen['searches']) == 1:
                wait_for_upstream[0].set()
                wait_for_upstream[1].wait(10)
            try:
                seen['replies'].append(monotonic())
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps([JINSHUI]).encode())
            except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
                pass

        def do_POST(self):
            request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
            seen['requests'].append(request)
            tools = {tool['name'] for tool in request.get('tools', [])}
            messages = [json.dumps(message, ensure_ascii=False) for message in request['messages']]
            latest = messages[-1]
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            if '"type": "tool_result"' in latest:
                if JINSHUI['display_name'] not in latest:
                    emit(self, '模拟模型没有收到有效定位。')
                elif ANALYZE in next(message for message in reversed(messages[:-1]) if '"role": "user"' in message):
                    emit(self, '金水区位于郑州市，与当前选区不同。请确认使用哪个范围？')
                else:
                    emit(self, '郑州市金水区，东经 113.66°、北纬 34.8°。来源 OpenStreetMap。')
            elif 'geocode_place' in tools and (LOOKUP in latest or ANALYZE in latest):
                emit_tools(self, [('geocode_place', {'query': '郑州市金水区', 'country_code': 'CN', 'language': 'zh-CN'})])
            else:
                emit(self, '定位工具未配置。')

    provider = ThreadingHTTPServer(('127.0.0.1', 0), FixtureProvider)
    threading.Thread(target=provider.serve_forever, daemon=True).start()
    try:
        url = f'http://127.0.0.1:{provider.server_port}'
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'DSH_PROVIDER': 'deepseek-official', 'DSH_MODEL': 'smoke-model',
            'DSH_REASONING_EFFORT': 'default', 'DEEPSEEK_API_KEY': 'local-fixture-key', 'DEEPSEEK_BASE_URL': url,
            'SATGPT_GEOCODING_URL': (f'http://{PUBLIC_HOST}' if public else url) + '/search' if enabled else '',
            'SATGPT_OSM_TOOLS': '0',
            'SATGPT_PUBLIC_ORIGIN': '', 'SATGPT_COOKIE_SECURE': 'false', 'NO_PROXY': '127.0.0.1,localhost',
            **({'HTTP_PROXY': url} if public else {}),
        }):
            root = Path(directory)
            app = root / 'app'
            app.mkdir()
            shutil.copyfile(APP / 'geocoding_worker.py', app / 'geocoding_worker.py')
            (app / 'gee_worker.py').write_text(
                'import json, sys\nfor line in sys.stdin:\n'
                '    print(json.dumps({"id":json.loads(line)["id"],"ok":True,"data":{}}), flush=True)\n',
                encoding='utf-8',
            )
            controller = TaskController(root, state=root / 'state')
            try:
                yield controller, seen
            finally:
                controller.close()
    finally:
        provider.shutdown()
        provider.server_close()


class GeocodingSdkTests(unittest.TestCase):
    def test_dsh_geocodes_with_osm_disabled_and_preserves_task_scope(self):
        with geocoding_sdk_fixture() as (controller, seen), client_for(controller) as owner:
            for prompt, region, expected in [(LOOKUP, None, '113.66'), (ANALYZE, POLYGON, '请确认')]:
                submitted = owner.post('/api/harness/tasks', json=task_body(None, prompt, analysis_region=region))
                submitted.raise_for_status()
                record = wait_for_task(owner, submitted.json()['id'], timeout=20)
                assert record['status'] == 'completed', record.get('error')
                assert record['analysis_region'] == region
                assert record['bounds'] == ([120, 30, 121, 31] if region else [100, 10, 101, 11])
                assert expected in record['output']['message'], record['trace']
                assert record['output']['layers'] == []
                entries = [entry for entry in record['trace'] if entry.get('kind') == 'tool']
                assert [entry['name'] for entry in entries] == ['geocode_place']
                assert json.loads(entries[0]['result'])['candidates'][0]['position'] == [113.66, 34.8]
            tool_names = {tool['name'] for tool in seen['requests'][0]['tools']}
            assert 'geocode_place' in tool_names and 'osm_roads' not in tool_names
            assert seen['searches'] == [{
                'q': ['郑州市金水区'], 'format': ['jsonv2'], 'addressdetails': ['1'], 'limit': ['3'],
                'countrycodes': ['cn'], 'accept-language': ['zh-cn'],
            }]


    def test_dsh_omits_geocoding_when_unconfigured(self):
        with geocoding_sdk_fixture(enabled=False) as (controller, seen), client_for(controller) as owner:
            submitted = owner.post('/api/harness/tasks', json=task_body(None, LOOKUP))
            submitted.raise_for_status()
            record = wait_for_task(owner, submitted.json()['id'], timeout=20)
            assert record['status'] == 'completed', record.get('error')
            assert 'geocode_place' not in {tool['name'] for tool in seen['requests'][0]['tools']}
            assert not seen['searches']


    def test_dsh_can_cancel_an_active_geocoding_call(self):
        arrived, release = threading.Event(), threading.Event()
        with geocoding_sdk_fixture(wait_for_upstream=(arrived, release), public=True) as (controller, seen), \
                client_for(controller) as owner:
            submitted = owner.post('/api/harness/tasks', json=task_body(None, LOOKUP))
            submitted.raise_for_status()
            task_id = submitted.json()['id']
            try:
                assert arrived.wait(10), seen['searches']
                owner.post(f'/api/harness/tasks/{task_id}/cancel').raise_for_status()
                record = wait_for_task(owner, task_id, timeout=10)
                assert record['status'] == 'cancelled', record
                assert all('113.66' not in entry.get('result', '') for entry in record['trace'])
            finally:
                release.set()
            replacement = owner.post('/api/harness/tasks', json=task_body(None, LOOKUP))
            replacement.raise_for_status()
            record = wait_for_task(owner, replacement.json()['id'], timeout=15)
            assert record['status'] == 'completed', record.get('error')
            assert '113.66' in record['output']['message']
            assert len(seen['arrivals']) == 2
            assert seen['arrivals'][1] - seen['arrivals'][0] >= 1

    def test_dsh_processes_share_the_public_request_interval(self):
        with geocoding_sdk_fixture(public=True) as (first, seen), client_for(first) as owner:
            with_second = TaskController(first.root, state=first.root / 'other-state')
            try:
                with client_for(with_second) as other:
                    requests = [client.post('/api/harness/tasks', json=task_body(None, LOOKUP))
                                for client in (owner, other)]
                    for client, submitted in zip((owner, other), requests):
                        submitted.raise_for_status()
                        record = wait_for_task(client, submitted.json()['id'], timeout=20)
                        assert record['status'] == 'completed', record.get('error')
                        assert '113.66' in record['output']['message']
                assert (first.root / 'state' / 'nominatim-rate.sqlite3').is_file()
                assert len(seen['arrivals']) == 2
                assert seen['arrivals'][1] - seen['replies'][0] >= 1
            finally:
                with_second.close()
