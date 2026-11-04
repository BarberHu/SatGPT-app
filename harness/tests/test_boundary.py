import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import TaskController, layer_code_bounds, layer_focus_bounds, validate_bounds
from harness.app.gee_worker import checked_code


class FakeAgent:
    def __init__(self, workspace, home, session_id):
        self.root = home.parent.parent

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def run(self, prompt, session_id, on_event=None, on_stream=None):
        event_file = self.root / 'state' / 'gee-tool-events.jsonl'
        event_file.write_text(json.dumps({
            'layer': {
                'name': 'Elevation',
                'url': 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',
            },
            'code': 'result = ee.Image("USGS/SRTMGL1_003")',
        }) + '\n', encoding='utf-8')
        return 'A map layer is ready.'


class RemoteRegionAgent(FakeAgent):
    def run(self, prompt, session_id, on_event=None, on_stream=None):
        event_file = self.root / 'state' / 'gee-tool-events.jsonl'
        event_file.write_text(json.dumps({
            'layer': {
                'name': 'Zhengzhou flood',
                'url': 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}',
            },
            'code': 'region = ee.Geometry.Rectangle([113.45, 34.30, 114.20, 35.00])\n'
                    'result = ee.Image("USGS/SRTMGL1_003").clip(region)',
        }) + '\n', encoding='utf-8')
        return 'The Zhengzhou layer is ready.'


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
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary, patch.dict(
            'os.environ', {'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key'}
        ):
            controller = TaskController(Path(temporary), agent_factory=RemoteRegionAgent)
            try:
                job = controller.create('Analyze Zhengzhou', taihu)
                finished = controller.wait_for_job(job['id'], 0, timeout=5)
                while finished['status'] not in {'completed', 'failed'}:
                    finished = controller.wait_for_job(job['id'], finished['revision'], timeout=5)
                self.assertEqual(finished['status'], 'completed')
                self.assertEqual(finished['output']['layers'][0]['bounds'], zhengzhou)
            finally:
                controller.close()

    def test_committed_tool_result_becomes_map_command(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as temporary, patch.dict(
            'os.environ', {'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key'}
        ):
            controller = TaskController(Path(temporary), agent_factory=FakeAgent)
            try:
                job = controller.create('Show elevation', [100, 10, 101, 11])
                finished = controller.wait_for_job(job['id'], 0, timeout=5)
                while finished['status'] not in {'completed', 'failed'}:
                    finished = controller.wait_for_job(job['id'], finished['revision'], timeout=5)
                self.assertEqual(finished['status'], 'completed')
                self.assertEqual(finished['output']['layers'][0]['name'], 'Elevation')
                self.assertEqual(controller.conversation()['messages'][-1]['layers'][0]['name'], 'Elevation')
                self.assertIsNone(controller.conversation()['messages'][-1]['layers'][0]['bounds'])
            finally:
                controller.close()


if __name__ == '__main__':
    unittest.main()
