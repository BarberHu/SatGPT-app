"""Run DSH's native web tools against simulated DeepSeek API endpoints."""

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from tempfile import TemporaryDirectory
from threading import Thread
import unittest
from unittest.mock import patch

import yaml

from harness.app.bootstrap import ensure_plugin
from harness.app.controller import TaskController
from harness.tests.runtime_fixture import client_for, task_body, wait_for_task
from harness.tests.test_cancellation import emit
from harness.tests.test_osm_sdk import emit_tools


class WebSdkTests(unittest.TestCase):
    def test_native_tools_use_the_independent_search_and_fetch_api(self):
        source = 'https://example.com/report'
        query = 'documented flood report'
        source_text = 'The survey found 42 inundated road segments.'
        model_tool_lists = []
        web_requests = []

        class Provider(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                request = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                if self.path.startswith('/v1/tools/'):
                    web_requests.append((self.path, request))
                    body = {'results': [{'url': source, 'title': 'Flood report', 'snippet': 'Survey', 'date': None}]}
                    if self.path == '/v1/tools/fetch':
                        body = {'content': source_text}
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/json')
                    self.end_headers()
                    self.wfile.write(json.dumps(body).encode())
                    return

                model_tool_lists.append({tool['name'] for tool in request.get('tools', [])})
                latest = json.dumps(request['messages'][-1])
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                if source_text in latest:
                    emit(self, source_text)
                elif source in latest:
                    emit_tools(self, [('web_fetch', {'url': source})])
                else:
                    emit_tools(self, [('web_search', {'queries': [query]})])

        with ThreadingHTTPServer(('127.0.0.1', 0), Provider) as server, TemporaryDirectory() as directory:
            thread = Thread(target=server.serve_forever, daemon=True)
            thread.start()
            base = f'http://127.0.0.1:{server.server_port}'

            def install_with_fixture_endpoint(home):
                ensure_plugin(home)
                bundle_patch = (home / 'profiles' / 'sdk' / 'node_modules' / '@local' /
                                'webgis-gee-tools' / 'cordis.patch.yml')
                config = yaml.safe_load(bundle_patch.read_text(encoding='utf-8'))
                web_api = next(row['config'] for row in config if row.get('id') == 'web-deepseek-api')
                web_api['baseURL'] = f'{base}/v1/tools'
                bundle_patch.write_text(yaml.safe_dump(config), encoding='utf-8')

            root = Path(directory)
            worker = root / 'app' / 'gee_worker.py'
            worker.parent.mkdir()
            worker.write_text('import sys\nfor line in sys.stdin: pass\n', encoding='utf-8')
            try:
                with patch.dict(os.environ, {
                    'DSH_PROVIDER': 'deepseek-official', 'DSH_MODEL': 'smoke-model', 'DSH_REASONING_EFFORT': 'default',
                    'DEEPSEEK_API_KEY': 'local-fixture-key', 'DEEPSEEK_BASE_URL': base, 'SATGPT_OSM_TOOLS': '0',
                    'SATGPT_GEOCODING_URL': '', 'SATGPT_PUBLIC_ORIGIN': '', 'SATGPT_COOKIE_SECURE': 'false',
                    'NO_PROXY': '127.0.0.1,localhost',
                }), patch('harness.app.shared_runtime.ensure_plugin', install_with_fixture_endpoint):
                    controller = TaskController(root, state=root / 'state')
                    try:
                        with client_for(controller) as client:
                            response = client.post('/api/harness/tasks', json=task_body(None, 'Find and read a flood report.'))
                            response.raise_for_status()
                            task = wait_for_task(client, response.json()['id'], timeout=25)
                    finally:
                        controller.close()
            finally:
                server.shutdown()
                thread.join()

        self.assertEqual(task['status'], 'completed', task.get('error'))
        self.assertEqual(task['output']['message'], source_text)
        self.assertTrue(model_tool_lists)
        for names in model_tool_lists:
            self.assertEqual(names, {'web_search', 'web_fetch', 'gee_check', 'gee_status', 'gee_catalog', 'gee_eval',
                                     'gee_preview', 'gee_layer', 'gee_publish_flood', 'geo_data_search',
                                     'geo_data_info', 'skill', 'flood_population_exposure', 'flexth_estimate'})
        self.assertEqual(web_requests, [('/v1/tools/search', {'query': query, 'count': 8, 'need_content': False}),
                                        ('/v1/tools/fetch', {'url': source})])
        tools = [row for row in task['timeline'] if row['kind'] == 'tool']
        self.assertEqual([(row['name'], row['status']) for row in tools], [('web_search', 'done'), ('web_fetch', 'done')])
        self.assertIn(source, tools[0]['result'])
        self.assertIn(source_text, tools[1]['result'])
