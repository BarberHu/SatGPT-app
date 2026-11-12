import copy
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient
from harness.app.server import router
from harness.app.controller import TaskController
from harness.app.analysis_region import validate_analysis_aoi
from harness.tests.test_boundary import FakeAgent


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
        with tempfile.TemporaryDirectory() as folder, patch.dict('os.environ', {
            'DSH_PROVIDER':'deepseek-official','DEEPSEEK_API_KEY':'test-only-key',
        }):
            controller = TaskController(Path(folder), agent_factory=FakeAgent)
            app = FastAPI(); app.include_router(router); app.state.controller = controller
            try:
                client = TestClient(app)
                response = client.post('/api/harness/tasks',json={'prompt':'Analyze this area','bounds':[0,0,1,1],
                                                               'analysis_region':geometry,'analysis_aoi':metadata})
                self.assertEqual(response.status_code,202,response.text)
                job = response.json(); metadata['label']='Changed later'; geometry['coordinates'][0][0][0]=0
                while job['status'] not in {'completed','failed'}:
                    job = controller.wait_for_job(job['id'],job['revision'],timeout=5)
                self.assertEqual(job['status'],'completed')
                message = controller.conversation()['messages'][0]
                self.assertEqual(message['analysis_region'],submitted)
                self.assertEqual(message['analysis_aoi'],{'label':'Original basin','id':'saved-basin','revision':1})
                context = job['output']['layers'][0]['generation']['analysis_context']
                self.assertEqual(context['analysis_region'],submitted)
                self.assertEqual(context['analysis_aoi']['label'],'Original basin')
            finally: controller.close()
