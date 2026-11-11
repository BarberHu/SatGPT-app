import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from harness.app import server
from harness.app.agent import HarnessAgent, conversation_prompt
from harness.app.analysis_region import validate_analysis_region
from harness.app.controller import TaskController
from harness.app.gee_worker import run_code, execute


TRIANGLE = {'type': 'Polygon', 'coordinates': [[[113.6,34.7],[113.64,34.7],[113.62,34.74],[113.6,34.7]]]}


class CaptureAgent:
    runs = []
    def __init__(self, *_): pass
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def set_analysis_context(self, job): self.context = copy.deepcopy(job)
    def run(self, prompt, session_id, **_):
        self.runs.append((prompt, session_id, self.context))
        return 'Scope recorded.'


class GeometryEE:
    Geometry = staticmethod(lambda geometry: {'exact': copy.deepcopy(geometry)})


class AnalysisRegionTests(unittest.TestCase):
    def test_geometry_contract_rejects_invalid_and_limits(self):
        self.assertEqual(validate_analysis_region(TRIANGLE), TRIANGLE)
        multi = {'type': 'MultiPolygon', 'coordinates': [TRIANGLE['coordinates']]}
        self.assertEqual(validate_analysis_region(multi), multi)
        with self.assertRaises(ValueError):
            validate_analysis_region({'type':'MultiPolygon', 'coordinates':[TRIANGLE['coordinates'],TRIANGLE['coordinates']]})
        invalid = [[], {}, {'type': 'Point', 'coordinates': [1,2]},
                   {'type': 'Polygon', 'coordinates': []}]
        for ring in [ [[0,0],[1,0],[0,1]], [[0,0],[181,0],[1,1],[0,0]],
                      [[0,0],[10**1000,0],[1,1],[0,0]],
                      [[0,0],[float('nan'),0],[1,1],[0,0]], [[0,0],[True,0],[1,1],[0,0]],
                      [[0,0],[1,1],[2,2],[0,0]], [[0,0],[2,2],[0,2],[1,0],[0,0]],
                      [[0,0],[1,0],[0,1],[0,0]] * 600,
                      [[0,0],[100,0],[100,60],[0,60],[0,0]] ]:
            invalid.append({'type':'Polygon', 'coordinates':[ring]})
        for value in invalid:
            with self.subTest(value=str(value)[:80]), self.assertRaises(ValueError):
                validate_analysis_region(value)
        original = copy.deepcopy(TRIANGLE)
        normalized = validate_analysis_region(original)
        original['coordinates'][0][1][0] = 0
        self.assertEqual(normalized, TRIANGLE)

    def test_http_snapshots_history_sessions_old_bounds_and_agent_prompt(self):
        CaptureAgent.runs = []
        with tempfile.TemporaryDirectory() as temporary, patch.dict('os.environ',
                {'DSH_PROVIDER':'deepseek-official', 'DEEPSEEK_API_KEY':'test-only-key'}):
            controller = TaskController(Path(temporary), agent_factory=CaptureAgent)
            app = FastAPI(); app.include_router(server.router); app.state.controller = controller
            client = TestClient(app)
            try:
                response = client.post('/api/harness/tasks', json={'prompt':'Analyze here', 'bounds':[0,0,1,1],
                                                                'analysis_region':{'type':'Point'}})
                self.assertEqual(response.status_code, 400)
                self.assertEqual(controller.conversation()['messages'], [])
                # A later wrapped/out-of-range viewport must not invalidate an
                # already-confirmed polygon; only geometry-derived bounds apply.
                body = {'prompt':'Analyze here', 'bounds':[-200,-40,200,40], 'analysis_region':copy.deepcopy(TRIANGLE)}
                response = client.post('/api/harness/tasks', json=body)
                self.assertEqual(response.status_code, 202)
                job = response.json(); cid = job['conversation_id']
                body['analysis_region']['coordinates'][0][0][0] = 0
                while job['status'] not in {'completed','failed'}:
                    job = controller.wait_for_job(job['id'], job['revision'], 5)
                self.assertEqual(job['status'], 'completed')
                self.assertEqual(job['analysis_region'], TRIANGLE)
                self.assertEqual(job['bounds'], [113.6,34.7,113.64,34.74])
                messages = controller.conversation()['messages']
                self.assertEqual(len(messages), 2)
                self.assertEqual(messages[0]['job_id'], job['id'])
                self.assertEqual(messages[0]['analysis_region'], TRIANGLE)
                prompt, session_id, context = CaptureAgent.runs[0]
                self.assertEqual(session_id, cid)
                self.assertEqual(context['analysis_region'], TRIANGLE)
                self.assertIn(json.dumps(TRIANGLE), prompt)
                controller.new_conversation()
                old = client.post('/api/harness/tasks', json={'prompt':'Knowledge question', 'bounds':[100,10,101,11]}).json()
                while old['status'] not in {'completed','failed'}:
                    old = controller.wait_for_job(old['id'], old['revision'], 5)
                self.assertIsNone(old['analysis_region'])
                self.assertNotEqual(old['conversation_id'], cid)
                self.assertEqual(controller.conversation(cid)['messages'][0]['analysis_region'], TRIANGLE)
                controller.activate_conversation(cid)
                self.assertEqual(controller.conversation()['messages'][0]['analysis_region'], TRIANGLE)
            finally:
                controller.close()

    def test_runtime_context_file_and_fresh_worker_scopes(self):
        with tempfile.TemporaryDirectory() as temporary:
            home = Path(temporary)
            agent = HarnessAgent(home, home, 'webgis-test')
            job = {'id':'one', 'conversation_id':'webgis-test', 'bounds':[0,0,1,1], 'analysis_region':TRIANGLE}
            agent.set_analysis_context(job)
            context = json.loads(agent.context_file.read_text())
            result = run_code(GeometryEE, 'result = [analysis_region, analysis_region_geojson]', context)
            self.assertEqual(result, [{'exact':TRIANGLE}, TRIANGLE])
            run_code(GeometryEE, 'analysis_region_geojson["coordinates"][0][0][0] = 0\nresult = 1', context)
            self.assertEqual(context['analysis_region'], TRIANGLE)
            second = {**context, 'task_id':'two', 'analysis_region':None, 'bounds':[100,10,101,11]}
            self.assertEqual(run_code(GeometryEE, 'result = analysis_region_geojson', second)['coordinates'][0][0], [100,10])
            self.assertEqual(run_code(GeometryEE, 'result = analysis_region_geojson', context), TRIANGLE)
            with self.assertRaises(NameError): run_code(GeometryEE, 'result = analysis_region')
            agent.__exit__(None,None,None)
            self.assertFalse(agent.context_file.exists())

    def test_eval_worker_uses_exact_geometry(self):
        with patch('harness.app.gee_worker.earth_engine', return_value=GeometryEE):
            result = execute({'operation':'eval', 'project':'offline',
                              'analysis_context':{'analysis_region':TRIANGLE}, 'code':'result = analysis_region'})
        self.assertEqual(result, {'result':{'exact':TRIANGLE}})

    def test_prompt_rules_are_present_without_changing_normal_knowledge_behavior(self):
        prompt = conversation_prompt('compare here and Zhengzhou', [0,0,1,1], [], TRIANGLE)
        for rule in ['ordinary knowledge', 'BEFORE executing', 'Do not repeatedly ask', 'multi-region',
                     'model-guessed coordinates', 'never invent', 'actual scope used', 'filterBounds',
                     'not a guaranteed geographic conflict detector']:
            self.assertIn(rule, prompt)


if __name__ == '__main__': unittest.main()
