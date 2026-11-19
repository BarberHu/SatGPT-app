import copy
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.app.agent import conversation_prompt
from harness.app.analysis_region import validate_analysis_region
from harness.app.controller import TaskController
from harness.app.gee_worker import run_code, execute
from harness.app.stream_bridge import StreamBridge
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, result, task_body, wait_for_task


TRIANGLE = {'type': 'Polygon', 'coordinates': [[[113.6,34.7],[113.64,34.7],[113.62,34.74],[113.6,34.7]]]}


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
        captured = []
        def run(prompt, ctx, **_):
            captured.append((prompt, ctx))
            return result('Scope recorded.')
        with tempfile.TemporaryDirectory() as temporary:
            controller = TaskController(Path(temporary), runtime_factory=lambda *a: SimulatedRuntime(*a, run=run))
            try:
                client = client_for(controller)
                cid = new_chat(client)
                invalid = task_body(cid, analysis_region={'type':'Point'})
                self.assertEqual(client.post('/api/harness/tasks', json=invalid).status_code, 422)
                self.assertEqual(client.get(f'/api/harness/conversations/{cid}').json()['messages'], [])
                body = task_body(cid, bounds=[-200,-40,200,40], analysis_region=copy.deepcopy(TRIANGLE))
                response = client.post('/api/harness/tasks', json=body)
                self.assertEqual(response.status_code, 202)
                body['analysis_region']['coordinates'][0][0][0] = 0
                job = wait_for_task(client, response.json()['id'])
                self.assertEqual(job['status'], 'completed')
                self.assertEqual(job['analysis_region'], TRIANGLE)
                self.assertEqual(job['bounds'], [113.6,34.7,113.64,34.74])
                messages = client.get(f'/api/harness/conversations/{cid}').json()['messages']
                self.assertEqual(len(messages), 2)
                self.assertEqual(messages[0]['job_id'], job['id'])
                self.assertEqual(messages[0]['analysis_region'], TRIANGLE)
                prompt, context = captured[0]
                self.assertNotEqual(context['session_id'], cid)
                self.assertEqual(context['analysis_region'], TRIANGLE)
                self.assertIn(json.dumps(TRIANGLE), prompt)
                other = new_chat(client)
                sent = client.post('/api/harness/tasks', json=task_body(other, 'Knowledge question')).json()
                self.assertIsNone(wait_for_task(client, sent['id'])['analysis_region'])
                self.assertEqual(client.post(f'/api/harness/conversations/{cid}/activate').json()['messages'][0]['analysis_region'], TRIANGLE)
            finally:
                controller.close()

    def test_runtime_context_file_and_fresh_worker_scopes(self):
        with tempfile.TemporaryDirectory() as temporary:
            bridge = StreamBridge(Path(temporary))
            try:
                job = {'session_id':'satgpt-one', 'run_id':'r', 'task_id':'one',
                       'conversation_id':'webgis-test', 'bounds':[0,0,1,1], 'analysis_region':TRIANGLE}
                bridge.bind(job, lambda _: None)
                path = bridge.directory / 'satgpt-one.json'
                context = json.loads(path.read_text())
                self.assertEqual(run_code(GeometryEE, 'result = [analysis_region, analysis_region_geojson]', context),
                                 [{'exact':TRIANGLE}, TRIANGLE])
                run_code(GeometryEE, 'analysis_region_geojson["coordinates"][0][0][0] = 0\nresult = 1', context)
                self.assertEqual(context['analysis_region'], TRIANGLE)
                second = {**context, 'task_id':'two', 'analysis_region':None, 'bounds':[100,10,101,11]}
                self.assertEqual(run_code(GeometryEE, 'result = analysis_region_geojson', second)['coordinates'][0][0], [100,10])
                with self.assertRaises(NameError):
                    run_code(GeometryEE, 'result = analysis_region')
                bridge.unbind(job['session_id'], job['run_id'])
                self.assertFalse(path.exists())
            finally:
                bridge.close()

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
