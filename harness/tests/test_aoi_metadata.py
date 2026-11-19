import copy
import tempfile
import unittest
from pathlib import Path
from harness.app.controller import TaskController
from harness.app.analysis_region import validate_analysis_aoi
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, result, task_body, wait_for_task


class AoiMetadataTests(unittest.TestCase):
    def test_reference_validation_is_display_only_and_backwards_compatible(self):
        geometry = {'type': 'Polygon'}
        self.assertIsNone(validate_analysis_aoi(None, None))
        self.assertEqual(validate_analysis_aoi({'label':' Basin '}, geometry), {'label':'Basin'})
        for metadata, region in [({'label':'Basin'},None), ({'label':'x','id':'a','revision':True},geometry),
                                 ({'label':'x','id':'../other','revision':1},geometry), ({'label':' '*3},geometry)]:
            with self.assertRaises(ValueError): validate_analysis_aoi(metadata, region)

    def test_http_history_job_and_replay_keep_the_submitted_name_revision_and_full_geometry(self):
        geometry = {'type':'Polygon','coordinates':[[[100,10],[101,10],[101,11],[100,11],[100,10]],
                                                   [[100.2,10.2],[100.4,10.2],[100.4,10.4],[100.2,10.2]]]}
        submitted = copy.deepcopy(geometry)
        metadata = {'label':'Original basin','id':'saved-basin','revision':1}
        def run(ctx, **_):
            return result(ctx=ctx, artifacts=[{'code': 'result = ee.Image(1)',
                                               'layer': {'name':'Elevation', 'url':'/test-layer'}}])
        with tempfile.TemporaryDirectory() as folder:
            controller = TaskController(Path(folder), runtime_factory=lambda *a: SimulatedRuntime(*a, run=run))
            try:
                client = client_for(controller)
                cid = new_chat(client)
                response = client.post('/api/harness/tasks', json=task_body(cid, analysis_region=geometry, analysis_aoi=metadata))
                self.assertEqual(response.status_code, 202)
                metadata['label'] = 'Changed later'
                geometry['coordinates'][0][0][0] = 0
                job = wait_for_task(client, response.json()['id'])
                self.assertEqual(job['status'], 'completed')
                message = client.get(f'/api/harness/conversations/{cid}').json()['messages'][0]
                self.assertEqual(message['analysis_region'],submitted)
                self.assertEqual(message['analysis_aoi'],{'label':'Original basin','id':'saved-basin','revision':1})
                context = job['output']['layers'][0]['generation']['analysis_context']
                self.assertEqual(context['analysis_region'],submitted)
                self.assertEqual(context['analysis_aoi']['label'],'Original basin')
            finally: controller.close()
