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


class HoldingAgent:
    arrived = threading.Event()
    released = threading.Event()

    def __init__(self, *_):
        pass

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.released.set()

    def run(self, *_, on_stream=None, **__):
        self.arrived.set()
        self.released.wait(5)
        return 'Offline answer'

    def cancel(self):
        self.released.set()


class UnifiedBackendTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        HoldingAgent.arrived.clear()
        HoldingAgent.released.clear()
        self.addCleanup(HoldingAgent.released.set)
        self.patches = [
            patch.object(basic, 'validate_config'),
            patch.object(harness, 'validate_config'),
            patch.object(basic.gee_service, '_initialize_ee',
                         side_effect=lambda: setattr(basic.gee_service, 'initialized', True)),
            patch.object(harness, 'ROOT', Path(self.temp.name)),
            patch.object(harness, 'TaskController',
                         side_effect=lambda root: TaskController(root, agent_factory=HoldingAgent)),
            patch.dict(os.environ, {'OPENAI_API_KEY': 'offline-basic', 'DEEPSEEK_API_KEY': 'offline-agent',
                                    'DSH_PROVIDER': 'deepseek-official'}),
        ]
        for p in self.patches:
            p.start()
            self.addCleanup(p.stop)
        self.client = TestClient(backend.app)

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
        result = {'event': 'offline event', 'pre_date': '2020-01-01', 'location': 'test'}
        with self.client as client, patch.object(basic, 'get_chatgpt_response', return_value=json.dumps(result)) as chat:
            for message in ('first', 'second'):
                response = client.post('/api/chat', json={'message': message})
                self.assertEqual(response.json(), {'message': json.dumps(result)})
            self.assertEqual([c.args for c in chat.call_args_list], [('first',), ('second',)])
            self.assertEqual(client.get('/api/harness/conversation').json()['messages'], [])
            self.assertEqual(client.post('/api/chat', json={}).status_code, 422)
            chat.return_value = None
            self.assertEqual(client.post('/api/chat', json={'message': 'fail'}).json(), {'detail': 'Error with ChatGPT.'})
            for path, function in [('/api/maps/historical', 'get_historical_map_payload'),
                                   ('/api/maps/flood-hotspot', 'get_flood_hotspot_map_payload')]:
                payload = {'longitude': 100, 'latitude': 10, 'year': 2020, 'start_date': '2020-01-01'}
                expected = {'success': True, 'data': {'layers': [{'url': 'offline-tile'}]}}
                with patch.object(basic, function, return_value=expected) as operation:
                    self.assertEqual(client.post(path, json=payload).json(), expected)
                    operation.assert_called_once_with(payload)
                with patch.object(basic, function, side_effect=ValueError('fixture error')):
                    response = client.post(path, json=payload)
                    self.assertEqual(response.status_code, 500)
                    self.assertEqual(response.json(), {'detail': 'fixture error'})
                basic.gee_service.initialized = False
                self.assertEqual(client.post(path, json=payload).status_code, 503)
                basic.gee_service.initialized = True

    def test_task_concurrency_cancellation_and_sse(self):
        with self.client as client, patch.object(basic, 'get_chatgpt_response', return_value='offline'):
            conversation = client.get('/api/harness/conversation').json()
            response = client.post('/api/harness/tasks', json={
                'prompt': 'Hold task', 'bounds': [100, 10, 101, 11],
                'conversation_id': conversation['conversation_id'],
            })
            self.assertEqual(response.status_code, 202)
            job = response.json()['id']
            self.assertTrue(HoldingAgent.arrived.wait(2))
            started = time.perf_counter()
            self.assertEqual(client.post('/api/chat', json={'message': 'hello'}).json(), {'message': 'offline'})
            self.assertEqual(client.get('/readyz').status_code, 200)
            self.assertLess(time.perf_counter() - started, 1)
            self.assertEqual(client.get(f'/api/harness/tasks/{job}').json()['status'], 'running')
            conflict = client.post('/api/harness/tasks', json={'prompt': 'Another', 'bounds': [100, 10, 101, 11]})
            self.assertEqual(conflict.status_code, 409)
            self.assertEqual(client.post(f'/api/harness/tasks/{job}/cancel').json()['status'], 'cancelled')
            events = client.get(f'/api/harness/tasks/{job}/events', headers={'Last-Event-ID': '0'})
            self.assertIn('text/event-stream', events.headers['content-type'])
            self.assertIn('cancelled', events.text)
            ids = [int(line[4:]) for line in events.text.splitlines() if line.startswith('id: ')]
            self.assertNotIn('id: ', client.get(f'/api/harness/tasks/{job}/events?after={max(ids)}').text)
            self.assertEqual(client.get('/api/harness/tasks/absent').status_code, 404)
            self.assertEqual(client.post('/api/harness/tasks/absent/cancel').status_code, 404)
            new = client.post('/api/harness/conversation/new').json()
            self.assertNotEqual(new['conversation_id'], conversation['conversation_id'])
            self.assertEqual(client.get('/api/harness/conversations').status_code, 200)
            self.assertEqual(client.post(f"/api/harness/conversations/{conversation['conversation_id']}/activate").status_code, 200)

    def test_shutdown_cancels_running_task_and_joins_threads(self):
        with self.client as client:
            controller = backend.app.state.controller
            job = client.post('/api/harness/tasks', json={'prompt': 'Hold on shutdown', 'bounds': [0, 0, 1, 1]}).json()
            self.assertTrue(HoldingAgent.arrived.wait(2))
        self.assertEqual(controller.get(job['id'])['status'], 'cancelled')
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
                            patch.object(basic, 'get_historical_map_payload', side_effect=hold):
                        first = asyncio.create_task(client.post('/api/maps/historical', json={}))
                        try:
                            self.assertTrue(await asyncio.to_thread(entered.wait, 2))
                            response = await client.post('/api/maps/historical', json={})
                            self.assertEqual(response.status_code, 503)
                            self.assertEqual(response.headers['retry-after'], '5')
                            self.assertEqual((await client.get('/readyz')).status_code, 200)
                        finally:
                            release.set()
                            self.assertEqual((await first).status_code, 200)
        asyncio.run(scenario())

    def test_tile_proxy_uses_unified_http_service(self):
        with self.client as client:
            registry = basic.TileProxyServer.get_instance()
            registry.register('offline', Mock(fetch_tile=Mock(return_value=b'png')))
            response = client.get('/api/ee-tiles/offline/1/2/3')
            self.assertEqual(response.content, b'png')
            self.assertEqual(response.headers['content-type'], 'image/png')
            self.assertEqual(client.get('/api/ee-tiles/missing/1/2/3').status_code, 404)
        self.assertEqual(registry.tile_registry, {})


class EnvironmentTests(unittest.TestCase):
    def test_only_unified_entry_point_owns_a_fastapi_application(self):
        self.assertIsInstance(backend.app, FastAPI)
        for module in (basic, harness):
            self.assertFalse(any(isinstance(value, FastAPI) for value in vars(module).values()),
                             f'{module.__name__} must export routes without creating an application')

    def test_basic_resources_load_after_package_rename_without_network(self):
        from basic import flood_api_services, flood_dataset_service
        registry = flood_dataset_service._load_flood_registry()
        self.assertEqual(registry['selection_mode'], 'curated_only')
        self.assertTrue(registry['assets'])
        builder = flood_dataset_service._build_catalog_builder()
        with patch.object(builder, 'refresh', side_effect=AssertionError('Retained catalog must load locally')), \
                patch.object(builder, '_write_cache_payload'), \
                patch.object(builder, '_write_inventory_files'):
            self.assertTrue(builder.load(force_refresh=False))
        self.assertTrue(flood_api_services.get_basic_layer_catalog())

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

    def test_tile_service_uses_shared_environment_precedence_and_literal_values(self):
        from basic.water_assets.tile_service import GEETileService
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / '.env').write_text(
                "GEE_PROJECT_ID='${literal-project}'\nGOOGLE_APPLICATION_CREDENTIALS=relative.json\n",
                encoding='utf-8',
            )
            with patch.dict(os.environ, {}, clear=True):
                service = GEETileService(root)
                self.assertEqual(service.project_id, '${literal-project}')
                self.assertEqual(service.credentials_path, str(root / 'relative.json'))
            with patch.dict(os.environ, {'GEE_PROJECT_ID': ''}, clear=True):
                service = GEETileService(root)
                self.assertIsNone(service.project_id, 'An explicit empty process value must not be overwritten')

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
            validate_config('frontend')


if __name__ == '__main__':
    unittest.main()
