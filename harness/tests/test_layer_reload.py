import copy
import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from harness.app import server
from harness.app.controller import TaskController
from harness.app.layer_generation import LayerWorkerRunner, replay_payload, restore_generation_recipes

POLYGON = {'type':'Polygon','coordinates':[[[113.6,34.7],[113.64,34.7],[113.62,34.74],[113.6,34.7]]]}
URL = 'https://earthengine.googleapis.com/v1/projects/p/maps/{name}/tiles/{{z}}/{{x}}/{{y}}'


class TwoLayers:
    calls = 0
    def __init__(self, workspace, home, *_): self.root = home.parent.parent
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def run(self, *_, **__):
        type(self).calls += 1
        events = [{'code':f'result = ee.Image({i}).clip(analysis_region)',
                   'layer':{'name':'Same display name','url':URL.format(name=str(i)), 'bounds':[113.6,34.7,113.64,34.74],
                            'visualization':{'min':0,'max':i+1,'palette':['ffffff','0000ff']},
                            'metadata':{'source':'Test','created_at':'2020-01-01T00:00:00Z'}}} for i in range(2)]
        (self.root/'state'/'gee-tool-events.jsonl').write_text('\n'.join(json.dumps(e) for e in events)+'\n',encoding='utf-8')
        return 'Two layers.'


class LayerReloadTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict('os.environ',{'DSH_PROVIDER':'deepseek-official','DEEPSEEK_API_KEY':'test-only'})
        self.env.start(); self.addCleanup(self.env.stop)
        TwoLayers.calls = 0
        self.controller = TaskController(Path(self.temp.name),agent_factory=TwoLayers)
        self.addCleanup(self.controller.close)
        job = self.controller.create('Make two layers',[0,0,1,1],analysis_region=copy.deepcopy(POLYGON))
        for _ in range(10):
            if job['status'] in {'completed','failed'}: break
            job = self.controller.wait_for_job(job['id'],job['revision'],1)
        self.assertEqual(job['status'],'completed')
        self.job = job; self.cid = job['conversation_id']; self.layer_id = f"{job['id']}-0"

    def fresh(self,payload):
        return {'name':payload['visualization']['name'],'url':URL.format(name='fresh'),
                'bounds':payload['bounds'],'visualization':payload['visualization'],
                'metadata':{'source':'Test','created_at':'2099-01-01T00:00:00Z'}}

    def test_exact_per_layer_recipe_and_persistent_replay_without_new_chat(self):
        before = self.controller.conversation()['messages']
        first,second = before[-1]['layers']
        self.assertNotEqual(first['code'],second['code'])
        self.assertEqual(first['generation']['analysis_context']['analysis_region'],POLYGON)
        with patch.object(self.controller.layer_worker,'run',side_effect=self.fresh) as runner:
            result = self.controller.reload_layer(self.cid,self.layer_id)['layer']
        payload = runner.call_args.args[0]
        self.assertEqual(payload['layer_code'],first['code'])
        self.assertEqual(payload['analysis_context']['analysis_region'],POLYGON)
        self.assertEqual(result['generation'],first['generation'])
        self.assertEqual(result['metadata']['created_at'],first['metadata']['created_at'])
        self.assertEqual(result['reload_version'],1)
        self.assertEqual(len(self.controller.conversation()['messages']),2)
        self.assertEqual(self.controller.conversation()['messages'][-1]['layers'][1],second)
        self.assertEqual(TwoLayers.calls,1)
        restored = TaskController(Path(self.temp.name),agent_factory=TwoLayers)
        try:
            persisted = restored.conversation()['messages'][-1]['layers'][0]
            self.assertEqual(persisted['url'],result['url'])
            self.assertEqual(persisted['code'],first['code'])
        finally: restored.close()

    def test_failure_preserves_old_result_and_retry_remains_possible(self):
        before = self.controller.conversation()['messages'][-1]['layers'][0]
        with patch.object(self.controller.layer_worker,'run',side_effect=ValueError('GEE unavailable')):
            with self.assertRaises(ValueError): self.controller.reload_layer(self.cid,self.layer_id)
        self.assertEqual(self.controller.conversation()['messages'][-1]['layers'][0],before)
        with patch.object(self.controller.layer_worker,'run',side_effect=self.fresh):
            self.assertEqual(self.controller.reload_layer(self.cid,self.layer_id)['layer']['reload_version'],1)

    def test_duplicate_reload_and_conversation_switch_cannot_redirect_result(self):
        entered,released = threading.Event(),threading.Event()
        def holding(payload):
            entered.set(); self.assertTrue(released.wait(5)); return self.fresh(payload)
        with patch.object(self.controller.layer_worker,'run',side_effect=holding),ThreadPoolExecutor(1) as pool:
            future = pool.submit(self.controller.reload_layer,self.cid,self.layer_id)
            self.assertTrue(entered.wait(3))
            try:
                with self.assertRaisesRegex(RuntimeError,'already reloading'):
                    self.controller.reload_layer(self.cid,self.layer_id)
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    self.controller.delete_conversation(self.cid)
                new = self.controller.new_conversation()
                # Switching does not make a background reload safe to delete.
                with self.assertRaisesRegex(RuntimeError, 'busy'):
                    self.controller.delete_conversation(self.cid)
            finally: released.set()
            result = future.result(3)
        self.assertEqual(result['conversation_id'],self.cid)
        self.assertEqual(self.controller.conversation()['conversation_id'],new['conversation_id'])
        self.assertEqual(self.controller.conversation()['messages'],[])
        self.assertEqual(self.controller.conversation(self.cid)['messages'][-1]['layers'][0]['reload_version'],1)
        self.controller.delete_conversation(self.cid)
        with self.assertRaises(FileNotFoundError): self.controller.conversation(self.cid)

    def test_http_uses_saved_code_ignores_client_code_and_masks_service_urls(self):
        app = FastAPI(); app.include_router(server.router); app.state.controller = self.controller
        client = TestClient(app)
        path = f'/api/harness/conversations/{self.cid}/layers/{self.layer_id}/reload'
        with patch.object(self.controller.layer_worker,'run',side_effect=self.fresh) as run:
            result = client.post(path,json={'code':'import os','bounds':[0,0,1,1]})
        self.assertEqual(result.status_code,200)
        self.assertEqual(run.call_args.args[0]['layer_code'],self.job['output']['layers'][0]['code'])
        self.assertEqual(client.post(path.replace(self.layer_id,'missing-0')).status_code,404)
        with patch.object(self.controller.layer_worker,'run',side_effect=ValueError('Request https://service/private?token=hidden failed')):
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

    def test_runner_uses_existing_json_lines_protocol_and_captured_context(self):
        root = Path(self.temp.name)/'worker-test'; (root/'app').mkdir(parents=True)
        (root/'app'/'gee_worker.py').write_text(
            'import sys,json\nr=json.loads(sys.stdin.readline())\n'
            'print(json.dumps({"id":r["id"],"ok":True,"data":{"layer":{"echo":r["payload"]}}}))\n',encoding='utf-8')
        runner = LayerWorkerRunner(root)
        try:
            payload = replay_payload(self.job['output']['layers'][0]['generation'])
            response = runner.run(payload)
            self.assertEqual(response['echo']['analysis_context']['analysis_region'],POLYGON)
            self.assertEqual(response['echo']['layer_code'],payload['layer_code'])
        finally: runner.close()


if __name__ == '__main__': unittest.main()
