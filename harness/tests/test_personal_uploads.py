from dataclasses import replace
import csv
import io
import json
import uuid
from pathlib import Path
from unittest.mock import patch

from harness.tests.test_personal import PersonalFixture
from harness.app.personal.settings import PersonalError
from harness.app.personal.upload_validation import geojson_csv, geotiff_metadata

GEOJSON = {'type': 'FeatureCollection', 'features': [{'type': 'Feature',
    'geometry': {'type': 'Point', 'coordinates': [113, 34]}, 'properties': {'name': 'sample', 'population': 12}}]}


class UploadTests(PersonalFixture):
    def test_a_lost_import_response_reconciles_the_original_operation_instead_of_duplicating_it(self):
        row = self.new(); self.send(row)
        original = self.cloud.import_asset
        def lost(owner, upload):
            original(owner, upload)
            raise PersonalError(503, 'Simulated lost response')
        with patch.object(self.cloud, 'import_asset', side_effect=lost):
            self.service.uploads.step(self.first, row['id'])
        self.assertTrue(self.service.store.get('uploads', self.first, row['id'])['import_submitting'])
        self.service.uploads.step(self.first, row['id'])
        self.assertEqual(self.service.store.get('uploads', self.first, row['id'])['status'], 'ingesting')
        self.assertEqual(len(self.cloud.import_calls), 1)

    def new(self, name='observations.geojson'):
        return self.service.uploads.create(self.first, name, 'projects/test-project/assets/upload-' + uuid.uuid4().hex, str(uuid.uuid4()))

    def send(self, row, data=None):
        headers = self.login(self.first)
        return self.client.put('/api/personal/uploads/' + row['id'] + '/content',
                               content=json.dumps(GEOJSON).encode() if data is None else data, headers=headers)

    def test_geojson_preserves_points_and_properties_without_changing_aoi(self):
        row = self.new(); self.assertEqual(self.send(row).status_code, 200)
        self.service.uploads.step(self.first, row['id'])
        stored = self.service.store.get('uploads', self.first, row['id'])
        self.assertEqual(stored['status'], 'ingesting')
        content = (self.service.uploads.root / (row['id'] + '.csv')).read_text(encoding='utf-8')
        parsed = next(csv.DictReader(io.StringIO(content)))
        self.assertEqual(json.loads(parsed['.geo'])['type'], 'Point')
        self.assertEqual(parsed['population'], '12')
        self.assertEqual(stored['metadata']['column_types']['population'], 'COLUMN_DATA_TYPE_LONG')
        self.assertFalse(self.service.controller(self.first).conversation()['messages'])

    def test_only_confirmed_readable_imports_become_analysis_inputs(self):
        row = self.new(); self.send(row); self.service.uploads.step(self.first, row['id'])
        stored = self.service.store.get('uploads', self.first, row['id'])
        self.assertNotIn('data_ref', stored)
        with self.assertRaises(PersonalError): self.service.execution(self.first, [row['id']])
        self.cloud.operations[stored['operation']] = {'done': True}
        self.service.uploads.step(self.first, row['id'])
        self.assertNotEqual(self.service.store.get('uploads', self.first, row['id'])['status'], 'ready')
        self.cloud.records[row['asset_id']] = {'name': row['asset_id'], 'type': 'TABLE'}
        self.service.uploads.step(self.first, row['id'])
        stored = self.service.store.get('uploads', self.first, row['id'])
        self.assertEqual(stored['status'], 'ready')
        self.assertEqual(self.service.execution(self.first, [stored['data_ref']])['data_refs'][0]['asset_id'], row['asset_id'])

    def test_actual_stream_limit_and_cross_owner_content_are_enforced(self):
        self.service.settings = replace(self.settings, vector_limit=8)
        row = self.new()
        self.login(self.second)
        result = self.client.put('/api/personal/uploads/' + row['id'] + '/content', content=b'x', headers={'X-SatGPT-CSRF': self.csrf})
        self.assertEqual(result.status_code, 404)
        self.assertEqual(self.send(row, b'0123456789').status_code, 413)
        self.assertFalse((self.service.uploads.root / (row['id'] + '.source')).exists())
        self.assertFalse(self.cloud.import_calls)

    def test_idempotency_conflicts_and_existing_assets_never_overwrite(self):
        row = self.new()
        self.assertEqual(self.service.uploads.create(self.first, row['filename'], row['asset_id'], row['idempotency_key'])['id'], row['id'])
        with self.assertRaises(PersonalError):
            self.service.uploads.create(self.first, 'changed.geojson', row['asset_id'], row['idempotency_key'])
        with self.assertRaises(PersonalError):
            self.service.uploads.create(self.first, 'data.geojson', 'projects/test-project/assets/private', str(uuid.uuid4()))
        with self.assertRaises(PersonalError):
            self.service.uploads.create(self.first, '../data.geojson', row['asset_id'], str(uuid.uuid4()))

    def test_restart_preserves_remote_operation_and_cancellation_is_confirmed(self):
        row = self.new(); self.send(row); self.service.uploads.step(self.first, row['id'])
        stored = self.service.store.get('uploads', self.first, row['id'])
        from harness.app.personal.uploads import Uploads
        restarted = Uploads(self.service, autostart=False)
        self.addCleanup(restarted.close)
        self.assertEqual(restarted.store.get('uploads', self.first, row['id'])['operation'], stored['operation'])
        restarted.cancel(self.first, row['id'])
        self.assertEqual(restarted.store.get('uploads', self.first, row['id'])['status'], 'cancel_requested')
        with self.assertRaises(PersonalError): restarted.cleanup(self.first, row['id'])
        restarted.step(self.first, row['id'])
        self.assertEqual(restarted.store.get('uploads', self.first, row['id'])['status'], 'cancelled')
        restarted.cleanup(self.first, row['id'])
        self.assertTrue(self.cloud.cleaned)
        self.assertEqual(len(self.cloud.import_calls), 1)

    def test_cancel_during_storage_upload_does_not_start_import(self):
        row = self.new(); self.send(row)
        self.cloud.stage_hook = lambda: self.service.uploads.cancel(self.first, row['id'])
        self.service.uploads.step(self.first, row['id'])
        self.assertEqual(self.service.store.get('uploads', self.first, row['id'])['status'], 'cancelled')
        self.assertFalse(self.cloud.import_calls)

    def test_reconnect_requires_explicit_upload_resume_and_does_not_claim_remote_cancel(self):
        row = self.new(); self.send(row); self.service.uploads.step(self.first, row['id'])
        self.service.disconnect(self.first)
        self.service.uploads.step(self.first, row['id'])
        stored = self.service.store.get('uploads', self.first, row['id'])
        self.assertEqual(stored['status'], 'ingesting')
        self.assertIn('Reconnect', stored['error'])
        self.service.store.save_token(self.first, {'access_token': 'new', 'scope': ['https://www.googleapis.com/auth/earthengine', 'https://www.googleapis.com/auth/devstorage.read_write'], 'expires_at': 9999999999})
        self.service.uploads.resume(self.first, row['id'])
        self.service.uploads.step(self.first, row['id'])
        self.assertEqual(self.service.store.get('uploads', self.first, row['id'])['status'], 'ingesting')
        self.assertEqual(len(self.cloud.import_calls), 1)

    def test_validation_rejects_invalid_geometry_nested_values_and_reserved_fields(self):
        import copy
        for mutate in [lambda d: d['features'][0]['geometry'].update(coordinates=[100000, 20]),
                       lambda d: d['features'][0]['properties'].update(nested={'x': 1}),
                       lambda d: d['features'][0]['properties'].update({'.geo': 'collision'}),
                       lambda d: d['features'][0]['properties'].update(flag=True),
                       lambda d: d['features'][0].update(geometry=None)]:
            data = copy.deepcopy(GEOJSON); mutate(data)
            path = self.root / 'invalid.json'; path.write_text(json.dumps(data), encoding='utf-8')
            with self.assertRaises(PersonalError): geojson_csv(path, self.root / 'converted.csv')

    def test_real_geotiff_reader_preserves_nodata_band_names_and_crs(self):
        import numpy as np
        import rasterio
        from rasterio.transform import from_origin
        path = self.root / 'small.tif'
        with rasterio.open(path, 'w', driver='GTiff', width=2, height=2, count=1, dtype='uint8',
                           crs='EPSG:4326', transform=from_origin(113, 35, .1, .1), nodata=255) as out:
            out.write(np.array([[1,2],[3,255]], dtype='uint8'), 1); out.set_band_description(1, 'land_class')
        before = path.read_bytes()
        metadata = geotiff_metadata(path)
        self.assertEqual(metadata['bands'], ['land_class']); self.assertEqual(metadata['nodata'], [255])
        self.assertEqual(metadata['crs'], 'EPSG:4326'); self.assertEqual(path.read_bytes(), before)
        path.write_bytes(b'not a TIFF')
        with self.assertRaises(PersonalError): geotiff_metadata(path)
