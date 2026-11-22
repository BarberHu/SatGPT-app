import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import TaskController
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, result, task_body, wait_for_task
from harness.tests.test_layer_reload import POLYGON, URL

REF = 'b' * 32


def pending_layer(ctx, **_):
    folder = Path(ctx['artifact_dir'])
    folder.mkdir(parents=True)
    (folder / f'thumbnail-{REF}.json').write_text('{}', encoding='utf-8')
    layer = {'name': 'Deferred preview', 'url': URL.format(name='original'),
             'bounds': [113.6, 34.7, 113.64, 34.74], 'visualization': {'min': 0, 'max': 5},
             'thumbnail_status': 'pending'}
    return result('Layer ready', ctx=ctx, artifacts=[
        {'layer': layer, 'thumbnail_ref': REF, 'code': 'result = ee.Image(1).clip(analysis_region)'},
    ])


class DeferredLayerTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        env = patch.dict('os.environ', {'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only'})
        env.start()
        self.addCleanup(env.stop)
        self.root = Path(temp.name)
        self.controller = TaskController(self.root, runtime_factory=lambda *args: SimulatedRuntime(*args, run=pending_layer))
        self.addCleanup(self.controller.close)
        self.client = client_for(self.controller)
        self.cid = new_chat(self.client)
        self.owner = self.controller.identity.verify(self.client.cookies.get('satgpt_browser'))
        self.entered, self.release = threading.Event(), threading.Event()
        self.addCleanup(self.release.set)
        self.location = None

    def start(self, control):
        self.patch = patch.object(self.controller.runtime, 'control', side_effect=control)
        self.patch.start()
        self.addCleanup(self.patch.stop)
        submission = self.client.post('/api/harness/tasks', json=task_body(self.cid, analysis_region=POLYGON))
        self.assertEqual(submission.status_code, 202)
        self.job_id = submission.json()['id']
        self.layer_id = f'{self.job_id}-0'
        self.status = f'/api/harness/conversations/{self.cid}/layer-thumbnails?ids={self.layer_id}'
        receipt = wait_for_task(self.client, self.job_id)
        self.assertEqual(receipt['status'], 'completed')
        self.assertEqual(receipt['output']['layers'][0]['url'], URL.format(name='original'))
        self.assertEqual(receipt['output']['layers'][0]['thumbnail_status'], 'pending')

    def render(self, route, body, **_):
        payload = body['payload']
        if route == '/reload':
            return {'layer': {'url': URL.format(name='reloaded'), 'bounds': payload['bounds'],
                              'thumbnail_status': 'unavailable'}}
        self.assertEqual(route, '/thumbnail')
        self.assertEqual(body['owner_id'], self.owner)
        self.assertEqual(body['tool_call_id'], 'call-1')
        self.assertEqual(payload['thumbnail_ref'], REF)
        self.entered.set()
        self.assertTrue(self.release.wait(4))
        self.location = Path(payload['artifact_dir']) / f'{REF}.png'
        if self.location.parent.is_dir():
            self.location.write_bytes(b'png fixture')
        return {'thumbnail': {'url': payload['artifact_url'] + f'/{REF}.png', 'width': 256, 'height': 256}}

    def current(self):
        response = self.client.get(self.status)
        self.assertEqual(response.status_code, 200)
        return response.json()['layers'][0]

    def settled(self):
        until = time.monotonic() + 3
        while time.monotonic() < until:
            with self.controller.lock:
                idle = not self.controller.thumbnails.active
            if idle:
                return self.current()
            time.sleep(.01)
        self.fail('Deferred thumbnail did not settle')

    def test_task_and_map_are_ready_while_thumbnail_is_blocked_then_persisted(self):
        self.start(self.render)
        self.assertTrue(self.entered.wait(3))
        self.assertEqual(self.current()['thumbnail_status'], 'pending')
        fresh_page = client_for(self.controller)
        self.assertEqual(fresh_page.get(self.status).status_code, 404)
        other_chat = new_chat(self.client)
        self.assertEqual(self.current()['thumbnail_status'], 'pending')
        self.release.set()
        states = self.settled()
        self.assertEqual(states['thumbnail_status'], 'ready')
        self.assertEqual(self.client.get(states['thumbnail']['url']).status_code, 200)
        self.assertEqual(fresh_page.get(states['thumbnail']['url']).status_code, 404)
        self.assertFalse(self.location.with_name(f'thumbnail-{REF}.json').exists())
        self.assertEqual(self.controller.current(self.owner)['conversation_id'], other_chat)
        persisted = self.client.get('/api/harness/tasks/' + self.job_id).json()['output']['layers'][0]
        self.assertEqual(persisted['thumbnail'], states['thumbnail'])
        self.assertNotIn('thumbnail_ref', persisted)

    def test_late_preview_cannot_override_reload(self):
        self.start(self.render)
        self.assertTrue(self.entered.wait(3))
        reload = self.client.post(f'/api/harness/conversations/{self.cid}/layers/{self.layer_id}/reload')
        self.assertEqual(reload.status_code, 200)
        self.release.set()
        status = self.settled()
        self.assertEqual(status['reload_version'], 1)
        self.assertEqual(status['thumbnail_status'], 'unavailable')
        self.assertFalse(self.location.exists())
        self.assertEqual(self.controller.conversation(self.owner, self.cid)['messages'][-1]['layers'][0]['url'],
                         URL.format(name='reloaded'))

    def test_missing_job_after_restart_becomes_unavailable_without_changing_map(self):
        with patch.object(self.controller.thumbnails, 'schedule'):
            self.start(self.render)
        restarted = TaskController(self.root, runtime_factory=SimulatedRuntime)
        try:
            client = client_for(restarted)
            client.cookies.clear()
            client.cookies.set('satgpt_browser', self.client.cookies.get('satgpt_browser'))
            response = client.get(self.status)
            self.assertEqual(response.status_code, 200)
            states = response.json()['layers']
            self.assertEqual(states[0]['thumbnail_status'], 'unavailable')
            receipt = client.get('/api/harness/tasks/' + self.job_id).json()
            self.assertEqual(receipt['output']['layers'][0]['url'], URL.format(name='original'))
            self.assertEqual(receipt['output']['layers'][0]['thumbnail_status'], 'unavailable')
        finally:
            restarted.close()

    def test_deleted_conversation_drops_inflight_result(self):
        self.start(self.render)
        self.assertTrue(self.entered.wait(3))
        self.assertEqual(self.client.delete(f'/api/harness/conversations/{self.cid}').status_code, 200)
        self.release.set()
        until = time.monotonic() + 3
        while time.monotonic() < until and self.controller.thumbnails.active:
            time.sleep(.01)
        self.assertFalse(self.controller.thumbnails.active)
        self.assertEqual(self.client.get(self.status).status_code, 404)
        self.assertFalse(self.location.exists())

    def test_renderer_error_keeps_existing_tiles_and_marks_unavailable(self):
        def fails(*_args, **_kwargs):
            self.entered.set()
            self.assertTrue(self.release.wait(4))
            raise ValueError('upstream failed')

        self.start(fails)
        self.assertTrue(self.entered.wait(3))
        self.release.set()
        self.assertEqual(self.settled()['thumbnail_status'], 'unavailable')
        layers = self.controller.conversation(self.owner, self.cid)['messages'][-1]['layers']
        self.assertEqual(layers[0]['url'], URL.format(name='original'))
