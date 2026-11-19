import tempfile
import unittest
from pathlib import Path

from harness.app.controller import TaskController, layer_code_bounds, layer_focus_bounds, validate_bounds
from harness.app.gee_worker import checked_code



from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, result, task_body, wait_for_task


class BoundaryTests(unittest.TestCase):
    def test_bounds_and_generated_code_are_checked(self):
        self.assertEqual(validate_bounds([100, 10, 101, 11]), [100, 10, 101, 11])
        with self.assertRaises(ValueError):
            validate_bounds([101, 10, 100, 11])
        with self.assertRaises(ValueError):
            checked_code('import os\nresult = 1')
        checked_code('result = ee.Image("USGS/SRTMGL1_003")')

    def test_layer_locator_uses_analysis_region_instead_of_request_viewport(self):
        taihu = [119.47, 30.57, 121.37, 31.82]
        zhengzhou = [113.45, 34.3, 114.2, 35.0]
        code = 'region = ee.Geometry.Rectangle([113.45, 34.30, 114.20, 35.00])'
        self.assertEqual(layer_code_bounds(code), zhengzhou)
        self.assertEqual(layer_focus_bounds({'layer': {}, 'code': code}), zhengzhou)
        self.assertEqual(layer_focus_bounds({'layer': {'bounds': zhengzhou}, 'code': code}), zhengzhou)
        self.assertEqual(layer_focus_bounds({'layer': {'bounds': taihu}, 'code': code}), zhengzhou)
        self.assertIsNone(layer_focus_bounds({'layer': {}, 'code': 'result = ee.Image(1)'}))

    def test_committed_tool_result_becomes_map_command(self):
        def run(ctx, **_):
            return result(ctx=ctx, artifacts=[
                {'code': 'result = ee.Image(1)', 'layer': {'name': 'Elevation', 'url': '/mock-tile'}}])
        with tempfile.TemporaryDirectory() as directory:
            controller = TaskController(Path(directory), runtime_factory=lambda *args: SimulatedRuntime(*args, run=run))
            try:
                client = client_for(controller)
                cid = new_chat(client)
                job = client.post('/api/harness/tasks', json=task_body(cid)).json()
                final = wait_for_task(client, job['id'])
                self.assertEqual(final['status'], 'completed')
                self.assertEqual(final['output']['layers'][0]['name'], 'Elevation')
                messages = client.get(f'/api/harness/conversations/{cid}').json()['messages']
                self.assertEqual(messages[-1]['layers'][0]['name'], 'Elevation')
                self.assertIsNone(messages[-1]['layers'][0]['bounds'])
            finally:
                controller.close()
