"""Offline integration tests: real unified HTTP app, controller, threads and worker.

Only external authentication/model/map responses are replaced. State is temporary.
Run from repository root: harness/.venv/Scripts/python -m unittest discover -s scripts/tests -p test_*.py
"""
import asyncio
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from contextlib import asynccontextmanager
from unittest.mock import Mock, patch

import httpx
from fastapi import FastAPI
from fastapi.openapi.utils import get_openapi
from fastapi.testclient import TestClient

import satgpt_backend as backend
from basic import server as basic
from harness.app import server as harness
from harness.app.controller import TaskController
from satgpt_config import load_project_env, validate_config
from harness.tests.runtime_fixture import SimulatedRuntime, result, task_body, wait_for_task


class HoldingSession:
    arrived = threading.Event()

    @classmethod
    def run(cls, stop, **_):
        cls.arrived.set()
        assert stop.wait(5)
        return result(reason='aborted')


class UnifiedBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        HoldingSession.arrived.clear()
        self.patches = [
            patch.object(basic, 'validate_config'),
            patch.object(harness, 'validate_config'),
            patch.object(basic.gee_service, '_initialize_ee',
                         side_effect=lambda: setattr(basic.gee_service, 'initialized', True)),
            patch.object(harness, 'ROOT', Path(self.temp.name)),
            patch.object(harness, 'TaskController',
                         side_effect=lambda root: TaskController(root, runtime_factory=lambda *a: SimulatedRuntime(*a, run=HoldingSession.run))),
            patch.dict(os.environ, {'OPENAI_API_KEY': '', 'DEEPSEEK_API_KEY': 'offline-agent',
                                    'DSH_PROVIDER': 'deepseek-official'}),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(backend.app, headers={'Origin':'http://testserver'})

    def test_lifecycle_health_and_readiness_are_distinct_from_authentication(self):
        self.assertEqual(self.client.get('/readyz').status_code, 503)
        with self.client as client:
            controller = backend.app.state.controller
            self.assertEqual(basic.gee_service._initialize_ee.call_count, 1)
            self.assertEqual(harness.TaskController.call_count, 1)
            self.assertEqual(client.get('/readyz').json(), {'status': 'ready', 'basic': True, 'harness': True})
            health = client.get('/health').json()
            for name in ('service', 'gee_initialized', 'gee_max_concurrency', 'engine',
                         'gee_project_configured', 'model_key_configured'):
                self.assertIn(name, health)
            self.assertEqual(health['model_authentication'], 'not_checked')
            self.assertEqual(health['harness']['gee_authentication'], 'not_checked')
            self.assertEqual(client.get('/api/harness/health').json()['engine'], 'deepseek-harness')
            basic.gee_service.initialized = False
            self.assertEqual(client.get('/health').json()['status'], 'degraded')
            self.assertEqual(client.get('/readyz').status_code, 200)
            backend.app.state.harness_initialized = False
            self.assertEqual(client.get('/readyz').status_code, 503)
        self.assertTrue(controller.pool._shutdown)
        self.assertIsNone(backend.app.state.controller)
        self.assertEqual(self.client.get('/readyz').status_code, 503)

    def test_basic_contracts_and_error_behavior(self):
        with self.client as client:
            self.assertEqual(client.get('/api/harness/session').status_code, 200)
            self.assertEqual(client.get('/api/harness/conversation').json()['messages'], [])

    def test_preset_layer_contract_and_error_behavior(self):
        path = '/api/preset-layers'
        payload = {'preset_id': 'singleInundationEvent'}
        expected = {'status': 'ready', 'layer': {'url': 'offline-tile'}}
        with self.client as client:
            with patch.object(basic, 'get_preset_layer_payload', return_value=expected) as operation:
                self.assertEqual(client.post(path, json=payload).json(), expected)
                operation.assert_called_once_with(payload)
            with patch.object(basic, 'get_preset_layer_payload', side_effect=ValueError('fixture error')):
                response = client.post(path, json=payload)
                self.assertEqual(response.status_code, 400)
                self.assertEqual(response.json(), {'detail': 'fixture error'})
            with patch.object(basic, 'get_preset_layer_payload', side_effect=RuntimeError('fixture error')):
                self.assertEqual(client.post(path, json=payload).status_code, 502)
            basic.gee_service.initialized = False
            self.assertEqual(client.post(path, json=payload).status_code, 503)

    def test_legacy_location_routes_are_removed(self):
        with self.client as client:
            for path, payload in (
                ('/api/location-search', {'query': 'Zhengzhou'}),
                ('/api/flood-confirmation/refresh', {'location': 'Zhengzhou'}),
            ):
                with self.subTest(path=path):
                    self.assertEqual(client.post(path, json=payload).status_code, 404)

    def test_retired_apis_are_absent_from_routing_and_openapi(self):
        routes = (
            ('POST', '/api/state'),
            ('POST', '/api/chat'),
            ('POST', '/api/scripts/gee'),
            ('POST', '/api/scripts/pdf'),
            ('GET', '/api/flood-layer-catalog'),
            ('POST', '/api/recommended-layer-render'),
            ('POST', '/api/harness/conversation/new'),
            ('POST', '/api/agent-raster-layers'),
            ('POST', '/api/agent-raster-download'),
            ('POST', '/api/road-network'),
            ('GET', '/api/maps/default'),
            ('POST', '/api/maps/unsupervised'),
            ('POST', '/api/maps/historical'),
            ('POST', '/api/maps/flood-hotspot'),
            ('POST', '/api/maps/water-regime-change'),
        )
        with self.client as client:
            client.get('/api/harness/session').raise_for_status()
            schema = client.get('/openapi.json').json()
            for method, path in routes:
                with self.subTest(method=method, path=path):
                    self.assertNotIn(path, schema['paths'])
                    self.assertEqual(client.request(method, path).status_code, 404)
            self.assertNotIn('/api/ee-tiles/{layer_id}/{z}/{x}/{y}', schema['paths'])
            self.assertEqual(client.get('/api/ee-tiles/offline/1/2/3').status_code, 404)

    def test_raster_file_download_remains_available(self):
        payload = {'layer_key': 'populationDensity'}
        with self.client as client, patch.object(basic, 'get_agent_raster_download_file',
                                               return_value=(b'tiff', 'population.tif', 1000)) as download:
            response = client.post('/api/agent-raster-download-file', json=payload)
        download.assert_called_once_with(payload)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.content, b'tiff')
        self.assertEqual(response.headers['content-type'], 'image/tiff')
        self.assertEqual(response.headers['content-disposition'], 'attachment; filename="population.tif"')
        self.assertEqual(response.headers['x-satgpt-raster-scale'], '1000')

    def test_business_layers_are_bound_to_the_authenticated_cookie(self):
        from harness.tests.runtime_fixture import client_for

        with self.client as client:
            client.get('/api/harness/session').raise_for_status()
            other = client_for(backend.app.state.controller, app=backend.app)
            path = '/api/business-layers'
            payload = {'store_key': 'shared-name', 'layers': [{'id': 'layer', 'label': 'private'}]}
            self.assertEqual(client.post(path+'/upsert', json=payload).status_code, 200)
            self.assertEqual(other.get(path+'/layer?store_key=shared-name').status_code, 404)
            self.assertEqual(other.post(path+'/batch-resolve', json={'store_key':'shared-name','layer_ids':['layer']}).status_code, 404)
            self.assertEqual(client.get(path+'/layer?store_key=shared-name').json()['data']['label'], 'private')

    def test_task_concurrency_cancellation_and_sse(self):
        with self.client as client, patch.object(basic, 'get_preset_layer_payload', return_value={'status': 'empty'}):
            client.get('/api/harness/session')
            response = client.post('/api/harness/tasks', json=task_body(None, 'Hold task'))
            self.assertEqual(response.status_code, 202)
            job = response.json()['id']
            cid = response.json()['conversation_id']
            self.assertTrue(HoldingSession.arrived.wait(2))
            started = time.perf_counter()
            self.assertEqual(client.post('/api/preset-layers', json={}).json(), {'status': 'empty'})
            self.assertEqual(client.get('/readyz').status_code, 200)
            self.assertLess(time.perf_counter() - started, 1)
            self.assertEqual(client.get(f'/api/harness/tasks/{job}').json()['status'], 'running')
            conflict = client.post('/api/harness/tasks', json=task_body(cid, 'Another'))
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(client.post(f'/api/harness/tasks/{job}/cancel').json()['status'], 'cancelling')
            self.assertEqual(wait_for_task(client, job)['status'], 'cancelled')
            events = client.get(f'/api/harness/tasks/{job}/events', headers={'Last-Event-ID': '0'})
            self.assertIn('text/event-stream', events.headers['content-type'])
            self.assertIn('cancelled', events.text)
            ids = [int(line[4:]) for line in events.text.splitlines() if line.startswith('id: ')]
            self.assertNotIn('id: ', client.get(f'/api/harness/tasks/{job}/events?after={max(ids)}').text)
            self.assertEqual(client.get('/api/harness/tasks/absent').status_code, 404)
            self.assertEqual(client.post('/api/harness/tasks/absent/cancel').status_code, 404)
            self.assertEqual(client.get('/api/harness/conversation').json()['conversation_id'], cid)
            self.assertEqual(client.get('/api/harness/conversations').status_code, 200)
            self.assertEqual(client.post(f'/api/harness/conversations/{cid}/activate').status_code, 200)

    def test_shutdown_cancels_running_task_and_joins_threads(self):
        with self.client as client:
            controller = backend.app.state.controller
            client.get('/api/harness/session')
            owner = controller.identity.verify(client.cookies.get('satgpt_browser'))
            job = client.post('/api/harness/tasks', json=task_body(None, 'Hold on shutdown')).json()
            self.assertTrue(HoldingSession.arrived.wait(2))
        self.assertEqual(controller.get(owner, job['id'])['status'], 'cancelled')
        self.assertTrue(all(not thread.is_alive() for thread in controller.pool._threads))

    def test_failed_harness_startup_unwinds_basic(self):
        with patch.object(harness, 'TaskController', side_effect=RuntimeError('startup fixture')):
            with self.assertRaisesRegex(RuntimeError, 'startup fixture'):
                with self.client:
                    pass
        self.assertFalse(backend.app.state.basic_initialized)
        self.assertFalse(basic.gee_service.initialized)

    def test_routes_and_schemas_preserve_each_module(self):
        unified = backend.app.openapi()['paths']
        expected_paths = set()
        for module in (basic, harness):
            schema = get_openapi(title='Module router', version='1', routes=module.router.routes)
            for path, methods in schema['paths'].items():
                self.assertNotIn(path, expected_paths, f'Business route conflict: {path}')
                expected_paths.add(path)
                for method, operation in methods.items():
                    for key in ('parameters', 'requestBody', 'responses'):
                        self.assertEqual(unified[path][method].get(key), operation.get(key), (path, method, key))
        self.assertTrue(expected_paths <= set(unified))
        self.assertEqual(set(unified) - expected_paths, {'/health', '/readyz'})

    def test_module_lifecycles_enter_once_and_exit_in_reverse_order(self):
        events = []
        @asynccontextmanager
        async def basic_lifecycle(app):
            self.assertIs(app, backend.app)
            events.append('basic start')
            try:
                yield
            finally:
                events.append('basic stop')
        @asynccontextmanager
        async def harness_lifecycle(app):
            self.assertIs(app, backend.app)
            events.append('harness start')
            try:
                yield
            finally:
                events.append('harness stop')
        async def scenario():
            async with backend.lifespan(backend.app):
                self.assertEqual(events, ['basic start', 'harness start'])
        with patch.object(basic, 'lifespan', basic_lifecycle), \
                patch.object(harness, 'lifespan', harness_lifecycle):
            asyncio.run(scenario())
        self.assertEqual(events, ['basic start', 'harness start', 'harness stop', 'basic stop'])

    def test_basic_heavy_queue_limit_does_not_block_event_loop(self):
        async def scenario():
            async with backend.lifespan(backend.app):
                async with httpx.AsyncClient(transport=httpx.ASGITransport(app=backend.app), base_url='http://test') as client:
                    entered, release = threading.Event(), threading.Event()
                    def hold(_):
                        entered.set()
                        release.wait(3)
                        return {'success': True}
                    with patch.object(basic, '_HEAVY_OPERATION_SEMAPHORE', asyncio.Semaphore(1)), \
                            patch.object(basic, '_HEAVY_QUEUE_TIMEOUT_SECONDS', .05), \
                            patch.object(basic, 'get_preset_layer_payload', side_effect=hold):
                        first = asyncio.create_task(client.post('/api/preset-layers', json={}))
                        try:
                            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                            response = await client.post('/api/preset-layers', json={})
                            self.assertEqual(response.status_code, 503)
                            self.assertEqual(response.headers['retry-after'], '5')
                            self.assertEqual((await client.get('/readyz')).status_code, 200)
                        finally:
                            release.set()
                            self.assertEqual((await first).status_code, 200)
        asyncio.run(scenario())

class EnvironmentTests(unittest.TestCase):
    def test_only_unified_entry_point_owns_a_fastapi_application(self):
        self.assertIsInstance(backend.app, FastAPI)
        for module in (basic, harness):
            self.assertFalse(any(isinstance(value, FastAPI) for value in vars(module).values()),
                             f'{module.__name__} must export routes without creating an application')

    def test_basic_layer_catalog_loads_from_packaged_configuration(self):
        from basic.flood_api_services import get_basic_layer_catalog
        self.assertTrue(get_basic_layer_catalog())

    def test_config_does_not_require_the_retired_basic_model(self):
        from satgpt_config import DEFAULTS

        with tempfile.TemporaryDirectory() as folder:
            credential = Path(folder) / 'service-account.json'
            credential.write_text(json.dumps({
                'type': 'service_account', 'private_key': 'fixture', 'client_email': 'fixture@example.invalid',
            }), encoding='utf-8')
            with patch.dict(os.environ, {
                **DEFAULTS, 'GOOGLE_APPLICATION_CREDENTIALS': str(credential), 'GEE_PROJECT_ID': 'test-project',
                'DEEPSEEK_API_KEY': 'offline-agent', 'OPENAI_API_BASE': 'unused-invalid-url',
            }, clear=True):
                validate_config('backend')

    def test_launcher_keeps_agent_port_for_unified_app(self):
        import satgpt_config
        with patch.dict(os.environ, {'AGENT_HOST': '127.0.0.1', 'AGENT_PORT': '8123',
                                    'FORWARDED_ALLOW_IPS': '127.0.0.1'}, clear=True), \
                patch.object(satgpt_config, 'load_project_env'), \
                patch.object(satgpt_config, 'validate_config'), \
                patch('uvicorn.run') as run:
            satgpt_config.main(['backend'])
        self.assertEqual(run.call_args.args, ('satgpt_backend:app',))
        self.assertEqual(run.call_args.kwargs['port'], 8123)
        self.assertEqual(run.call_args.kwargs['workers'], 1)

    def test_launch_and_deployment_use_one_backend(self):
        root = Path(__file__).resolve().parents[2]
        for script in ('start_windows.bat', 'start_production.bat'):
            content = (root / 'scripts/windows' / script).read_text(encoding='utf-8')
            self.assertEqual(sum(line.startswith('start ') for line in content.splitlines()), 2)
            self.assertNotIn('BASIC_PYTHON', content)
            self.assertIn('satgpt_config.py" backend', content)
        docker = (root / 'Dockerfile').read_text(encoding='utf-8')
        self.assertIn('COPY requirements.txt /app/', docker)
        self.assertIn('"backend"', docker)
        self.assertIn('/readyz', docker)

    def test_worker_is_a_separate_process_using_same_interpreter(self):
        worker = Path(harness.__file__).with_name('gee_worker.py')
        child = subprocess.Popen([sys.executable, '-I', str(worker), '--serve'], stdin=subprocess.PIPE,
                                 stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            self.assertNotEqual(child.pid, os.getpid())
            output, errors = child.communicate(json.dumps({'id': 'offline', 'payload': {
                'operation': 'check', 'code': 'result = 1'}}) + '\n', timeout=10)
            self.assertEqual(child.returncode, 0, errors)
            self.assertTrue(json.loads(output)['data']['valid'])
        finally:
            if child.poll() is None:
                child.kill()
                child.communicate()

    def test_multiworker_is_rejected_and_legacy_port_is_ignored(self):
        load_project_env()
        with patch.dict(os.environ, {'AGENT_WORKERS': '2'}):
            with self.assertRaisesRegex(ValueError, 'AGENT_WORKERS'):
                validate_config('backend')
        with patch.dict(os.environ, {'HARNESS_PORT': 'ignored', 'AGENT_WORKERS': '1'}):
            with patch.dict(os.environ, {'REACT_APP_MAPBOX_ACCESS_TOKEN': 'pk.validation'}):
                validate_config('frontend')


if __name__ == '__main__':
    unittest.main()
