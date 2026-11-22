import copy
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import TaskController
from harness.app.layer_generation import replay_payload, restore_generation_recipes
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, result, task_body, wait_for_task

POLYGON = {'type':'Polygon','coordinates':[[[113.6,34.7],[113.64,34.7],[113.62,34.74],[113.6,34.7]]]}
URL = 'https://earthengine.googleapis.com/v1/projects/p/maps/{name}/tiles/{{z}}/{{x}}/{{y}}'


def run_layers(ctx, **_):
    events = [{'code':f'result = ee.Image({i}).clip(analysis_region)',
               'layer':{'name':'Same display name','url':URL.format(name=str(i)), 'bounds':[113.6,34.7,113.64,34.74],
                        'visualization':{'min':0,'max':i+1,'palette':['ffffff','0000ff']},
                        'metadata':{'source':'Test','created_at':'2020-01-01T00:00:00Z'}}} for i in range(2)]
    directory = Path(ctx['artifact_dir'])
    directory.mkdir(parents=True)
    filename = 'a' * 32 + '.png'
    (directory/filename).write_bytes(b'test-preview')
    events[0]['layer']['thumbnail'] = {'url':ctx['artifact_url']+'/'+filename}
    return result('Two layers.', ctx=ctx, artifacts=events)


class LayerReloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict('os.environ',{'DSH_PROVIDER':'deepseek-official','DEEPSEEK_API_KEY':'test-only'})
        self.env.start(); self.addCleanup(self.env.stop)
        self.controller = TaskController(Path(self.temp.name), runtime_factory=lambda *a: SimulatedRuntime(*a, run=run_layers))
        self.addCleanup(self.controller.close)
        self.client = client_for(self.controller)
        self.owner = self.controller.identity.verify(self.client.cookies.get('satgpt_browser'))
        cid = new_chat(self.client)
        job = self.client.post('/api/harness/tasks', json=task_body(cid, analysis_region=copy.deepcopy(POLYGON))).json()
        job = wait_for_task(self.client, job['id'])
        self.assertEqual(job['status'],'completed')
        self.job = job; self.cid = job['conversation_id']; self.layer_id = f"{job['id']}-0"

    def fresh(self,payload):
        return {'name':payload['visualization']['name'],'url':URL.format(name='fresh'),
                'bounds':payload['bounds'],'visualization':payload['visualization'],
                'metadata':{'source':'Test','created_at':'2099-01-01T00:00:00Z'}}

    def test_exact_per_layer_recipe_and_persistent_replay_without_new_chat(self):
        before = self.controller.current(self.owner)['messages']
        first,second = before[-1]['layers']
        self.assertNotEqual(first['code'],second['code'])
        self.assertEqual(first['generation']['analysis_context']['analysis_region'],POLYGON)
        with patch.object(self.controller.runtime,'reload',side_effect=self.fresh) as runner:
            result = self.controller.reload_layer(self.owner,self.cid,self.layer_id)['layer']
        payload = runner.call_args.args[0]
        self.assertEqual(payload['layer_code'],first['code'])
        self.assertEqual(payload['analysis_context']['analysis_region'],POLYGON)
        self.assertEqual(result['generation'],first['generation'])
        self.assertEqual(result['metadata']['created_at'],first['metadata']['created_at'])
        self.assertEqual(result['reload_version'],1)
        self.assertEqual(len(self.controller.current(self.owner)['messages']),2)
        self.assertEqual(self.controller.current(self.owner)['messages'][-1]['layers'][1],second)
        restored = TaskController(Path(self.temp.name), runtime_factory=SimulatedRuntime)
        try:
            persisted = restored.conversation(self.owner,self.cid)['messages'][-1]['layers'][0]
            self.assertEqual(persisted['url'],result['url'])
            self.assertEqual(persisted['code'],first['code'])
        finally: restored.close()

    def test_failure_preserves_old_result_and_retry_remains_possible(self):
        before = self.controller.current(self.owner)['messages'][-1]['layers'][0]
        with patch.object(self.controller.runtime,'reload',side_effect=ValueError('GEE unavailable')):
            with self.assertRaises(ValueError): self.controller.reload_layer(self.owner,self.cid,self.layer_id)
        self.assertEqual(self.controller.current(self.owner)['messages'][-1]['layers'][0],before)
        with patch.object(self.controller.runtime,'reload',side_effect=self.fresh):
            self.assertEqual(self.controller.reload_layer(self.owner,self.cid,self.layer_id)['layer']['reload_version'],1)

    def test_duplicate_reload_and_conversation_switch_cannot_redirect_result(self):
        entered,released = threading.Event(),threading.Event()
        def holding(payload):
            entered.set(); self.assertTrue(released.wait(5)); return self.fresh(payload)
        with patch.object(self.controller.runtime,'reload',side_effect=holding),ThreadPoolExecutor(1) as pool:
            future = pool.submit(self.controller.reload_layer,self.owner,self.cid,self.layer_id)
            self.assertTrue(entered.wait(3))
            try:
                with self.assertRaisesRegex(RuntimeError,'already reloading'):
                    self.controller.reload_layer(self.owner,self.cid,self.layer_id)
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    self.controller.delete_conversation(self.owner,self.cid)
                response = self.client.post('/api/harness/tasks', json=task_body(None, analysis_region=POLYGON))
                response.raise_for_status()
                other = wait_for_task(self.client, response.json()['id'])
                self.assertEqual(other['status'], 'completed')
                self.assertNotEqual(other['conversation_id'], self.cid)
                other_before = self.controller.conversation(self.owner, other['conversation_id'])
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    self.controller.delete_conversation(self.owner,self.cid)
            finally: released.set()
            result = future.result(3)
        self.assertEqual(result['conversation_id'],self.cid)
        self.assertEqual(self.controller.conversation(self.owner, other['conversation_id']), other_before)
        self.assertEqual(self.controller.conversation(self.owner,self.cid)['messages'][-1]['layers'][0]['reload_version'],1)
        self.controller.delete_conversation(self.owner,self.cid)
        with self.assertRaises(FileNotFoundError): self.controller.conversation(self.owner,self.cid)

    def test_http_uses_saved_code_ignores_client_code_and_masks_service_urls(self):
        client = self.client
        path = f'/api/harness/conversations/{self.cid}/layers/{self.layer_id}/reload'
        with patch.object(self.controller.runtime,'reload',side_effect=self.fresh) as run:
            result = client.post(path,json={'code':'import os','bounds':[0,0,1,1]})
        self.assertEqual(result.status_code,200)
        self.assertEqual(run.call_args.args[0]['layer_code'],self.job['output']['layers'][0]['code'])
        self.assertEqual(client.post(path.replace(self.layer_id,'missing-0')).status_code,404)
        with patch.object(self.controller.runtime,'reload',side_effect=ValueError('Request https://service/private?token=hidden failed')):
            error = client.post(path)
        self.assertEqual(error.status_code,422)
        self.assertNotIn('token=',error.text)
        self.assertNotIn('hidden',error.text)

    def test_legacy_trace_recovery_is_unambiguous_and_never_uses_aggregate_code(self):
        code = 'result = ee.Image(1)'
        def old(name): return {'name':name,'url':URL.format(name=name),'bounds':[100,10,101,11]}
        messages = [{'role':'assistant','job_id':'legacy','layers':[old('A'),old('B')], 'code':'DO NOT SPLIT THIS',
                     'trace':[{'kind':'tool','name':'gee_layer','status':'done',
                               'arguments':json.dumps({'name':name,'code':code+f' # {name}','min':0,'max':1})} for name in ['A','B']]}]
        restored = restore_generation_recipes(messages,'webgis-old')[0]['layers']
        self.assertEqual(restored[0]['code'],code+' # A')
        self.assertTrue(restored[0]['reloadable'])
        missing = restore_generation_recipes([{'role':'assistant','job_id':'old','layers':[old('C')],'code':code}],self.cid)
        self.assertFalse(missing[0]['layers'][0]['reloadable'])
        ambiguous = [{'role':'assistant','layers':[old('A'),old('A')],'trace':messages[0]['trace']}]
        self.assertFalse(restore_generation_recipes(ambiguous,self.cid)[0]['layers'][0]['reloadable'])
        with self.assertRaisesRegex(ValueError,'original analysis region'):
            replay_payload({'version':1,'code':'result = ee.Image(1).clip(analysis_region)'})

    def test_owned_preview_and_reload_are_hidden_from_other_browsers(self):
        preview = self.job['output']['layers'][0]['thumbnail']['url']
        outsider = client_for(self.controller)
        self.assertEqual(self.client.get(preview).status_code, 200)
        self.assertEqual(outsider.get(preview).status_code, 404)
        self.assertEqual(outsider.post(f'/api/harness/conversations/{self.cid}/layers/{self.layer_id}/reload').status_code, 404)
        self.client.delete(f'/api/harness/conversations/{self.cid}')
        self.assertEqual(self.client.get(preview).status_code, 404)
