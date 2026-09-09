"""Exercise real merged handlers without initializing external GEE/LLM services.

Only the required definitions are compiled from server.py. Network/SDK calls
are replaced with fakes; FastAPI routing, validation and threadpool are real.
"""
import ast
import asyncio
import logging
import threading
import time
import unittest
from pathlib import Path
from types import SimpleNamespace
from typing import Optional
from unittest.mock import Mock

import httpx
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel
from starlette.concurrency import run_in_threadpool


def load_handlers():
    path = Path(__file__).resolve().parents[1] / 'server.py'
    tree = ast.parse(path.read_text(encoding='utf-8'))
    names = {
        '_run_heavy_operation', 'GeoBounds', 'FloodImageRequest', 'ScriptPdfRequest',
        'get_default_map', 'get_flood_imagery', 'get_pdf',
    }
    definitions = [node for node in tree.body if getattr(node, 'name', None) in names]
    namespace = {
        'app': FastAPI(), 'asyncio': asyncio, 'time': time, 'Optional': Optional,
        'BaseModel': BaseModel, 'HTTPException': HTTPException, 'Response': Response,
        'run_in_threadpool': run_in_threadpool, 'logger': logging.getLogger(__name__),
        '_HEAVY_OPERATION_SEMAPHORE': asyncio.Semaphore(1), '_HEAVY_QUEUE_TIMEOUT_SECONDS': 0.03,
        '_ensure_gee_ready': lambda: None, '_summarize_flood_image_request': lambda request: {},
        '_duration_ms': lambda started: 0,
        'get_default_map_payload': lambda: {'ok': True},
        'build_script_pdf': lambda script: script.encode(),
    }
    namespace['gee_service'] = SimpleNamespace(
        initialized=True,
        get_imagery_window_by_geojson=Mock(return_value={'kind': 'window-geojson'}),
        get_imagery_window_by_bounds=Mock(return_value={'kind': 'window-bounds'}),
        get_imagery_window=Mock(return_value={'kind': 'window-center'}),
        get_flood_imagery_by_geojson=Mock(return_value={'kind': 'event-geojson'}),
    )
    exec(compile(ast.Module(body=definitions, type_ignores=[]), str(path), 'exec'), namespace)
    return namespace


class DeploymentMergeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.ns = load_handlers()
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.ns['app']), base_url='http://test')

    async def asyncTearDown(self):
        await self.client.aclose()

    async def test_queue_timeout_remains_503_with_retry_header(self):
        await self.ns['_HEAVY_OPERATION_SEMAPHORE'].acquire()
        try:
            response = await self.client.get('/api/maps/default')
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.headers['retry-after'], '5')
        finally:
            self.ns['_HEAVY_OPERATION_SEMAPHORE'].release()

    async def test_failed_operation_releases_capacity(self):
        def fail():
            raise ValueError('simulated failure')
        with self.assertRaises(ValueError):
            await self.ns['_run_heavy_operation'](fail)
        self.assertEqual(await self.ns['_run_heavy_operation'](lambda: 'recovered'), 'recovered')

    async def test_parallel_operations_respect_limit(self):
        self.ns['_HEAVY_QUEUE_TIMEOUT_SECONDS'] = 1
        active = 0
        peak = 0
        lock = threading.Lock()

        def work():
            nonlocal active, peak
            with lock:
                active += 1
                peak = max(peak, active)
            time.sleep(0.01)
            with lock:
                active -= 1

        await asyncio.gather(*(self.ns['_run_heavy_operation'](work) for _ in range(4)))
        self.assertEqual(peak, 1)

    async def test_imagery_window_preserves_each_aoi_mode(self):
        base = {'imagery_start_date': '2026-07-01', 'imagery_end_date': '2026-07-03', 'longitude': 118, 'latitude': 32}
        for scope, kind in [
            ({'geojson': {'type': 'Polygon', 'coordinates': []}}, 'window-geojson'),
            ({'bounds': {'west': 117, 'south': 31, 'east': 119, 'north': 33}}, 'window-bounds'),
            ({}, 'window-center'),
        ]:
            with self.subTest(kind=kind):
                response = await self.client.post('/api/flood-images', json={**base, **scope})
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual(response.json()['data']['kind'], kind)

    async def test_event_imagery_still_uses_event_dates(self):
        payload = {'pre_date': '2026-07-01', 'peek_date': '2026-07-02', 'after_date': '2026-07-03',
                   'longitude': 118, 'latitude': 32, 'geojson': {'type': 'Polygon', 'coordinates': []}}
        response = await self.client.post('/api/flood-images', json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['data']['kind'], 'event-geojson')
        self.assertEqual(self.ns['gee_service'].get_flood_imagery_by_geojson.call_args.kwargs['peek_date'], payload['peek_date'])

    async def test_pdf_content_is_owned_by_each_request(self):
        first, second = await asyncio.gather(
            self.client.post('/api/scripts/pdf', json={'script': 'first-user-script'}),
            self.client.post('/api/scripts/pdf', json={'script': 'second-user-script'}),
        )
        self.assertEqual(first.content, b'first-user-script')
        self.assertEqual(second.content, b'second-user-script')
        self.assertEqual(first.headers['content-type'], 'application/pdf')

    async def test_empty_pdf_script_is_rejected(self):
        response = await self.client.post('/api/scripts/pdf', json={'script': ' '})
        self.assertEqual(response.status_code, 400)


if __name__ == '__main__':
    unittest.main()
