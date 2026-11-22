import json
from pathlib import Path
import tempfile
from unittest.mock import patch

import ee
from ee import apitestcase

from harness.app import gee_worker
import osm_raster_analysis as joint


REF = 'c' * 32
BOUNDS = [10, 20, 10.02, 20.02]
REGION = {'type': 'Polygon', 'coordinates': [[[10, 20], [10.01, 20], [10.01, 20.02], [10, 20.02], [10, 20]]]}


def feature(kind, osm_type, osm_id, coordinates):
    return {'type': 'Feature', 'geometry': {'type': kind, 'coordinates': coordinates},
            'properties': {'osm_type': osm_type, 'osm_id': str(osm_id)}}


def rows(values):
    return {'type': 'FeatureCollection', 'features': [
        {'type': 'Feature', 'geometry': None, 'properties': {'osm_key': key, **value}}
        for key, value in values.items()]}


class OSMRasterAnalysisTests(apitestcase.ApiTestCase):
    def setUp(self):
        super().setUp()
        folder = self.enterContext(tempfile.TemporaryDirectory())
        self.path = Path(folder, REF + '.geojson')
        self.payload = dict(operation='osm_analysis', project='fixture', artifact_dir=folder, osm_ref=REF,
                            code="result = ee.Image(1).rename('flood')", mode='point_sample', band='flood',
                            crs='EPSG:3857', scale=10, raster_source='Fixture raster', observed_at='2026-01-01',
                            analysis_context={'bounds': BOUNDS, 'analysis_region': REGION})

    def source(self, features):
        source = {'type': 'FeatureCollection', 'features': features, 'attribution': 'OpenStreetMap',
                  'osm_data_time': '2026-01-02', 'license_url': 'https://www.openstreetmap.org/copyright'}
        self.path.write_text(json.dumps(source), encoding='utf-8')

    def test_indexed_poi_reuses_saved_scope_or_rejects_conflicting_selection(self):
        record = {'geometry': REGION, 'bounds': [10, 20, 10.01, 20.02], 'legacy_ref': REF, 'task_id': 'prior'}
        payload = {**self.payload, 'osm_ref': None, 'osm_data_ref': 'g_' + REF, 'geo_context': {'owner': 'test'}}
        with patch.object(joint, 'get', return_value=record) as get, patch.object(
                joint, 'artifact_directory', return_value=self.path.parent / 'prior'):
            moved = {**payload, 'analysis_context': {'bounds': [11, 20, 11.02, 20.02], 'analysis_region': None}}
            resolved = joint.resolve_input(moved)
            self.assertEqual(resolved['analysis_context']['bounds'], record['bounds'])
            self.assertEqual(resolved['analysis_context']['analysis_region'], REGION)
            self.assertEqual(resolved['osm_input_dir'], self.path.parent / 'prior')
            self.assertEqual(resolved['artifact_dir'], payload['artifact_dir'])
            get.assert_called_once_with(payload['geo_context'], 'g_' + REF, ('pois',))
            with self.assertRaisesRegex(ValueError, 'match the saved OSM area'):
                joint.resolve_input({**payload, 'analysis_context': {'analysis_region': {
                    'type': 'Polygon', 'coordinates': [[[11, 20], [11.01, 20], [11.01, 20.02], [11, 20]]]}}})

    def run_worker(self, values):
        with patch.object(gee_worker, 'earth_engine', return_value=ee), patch.object(
                ee.data, 'computeValue', return_value=rows(values)) as request:
            result = gee_worker.execute(self.payload)
        request.assert_called_once()
        return result, request.call_args.args[0].serialize()

    def test_point_sampling_preserves_colocated_features_valid_zero_and_masked_point(self):
        points = [feature('Point', 'node', 1, [10.005, 20.005]), feature('Point', 'way', 1, [10.005, 20.005]),
                  feature('Point', 'node', 2, [10.006, 20.005]), feature('Point', 'node', 3, [10.007, 20.005])]
        self.source(points)
        self.payload.update(hit_value=1, show_on_map=True)
        result, graph = self.run_worker({'node/2': {'sample_value': 0}, 'way/1': {'sample_value': 1},
                                         'node/1': {'sample_value': 1}})
        self.assertIn('Image.sampleRegions', graph)
        self.assertIn('EPSG:3857', graph)
        summary = result['summary']
        self.assertEqual(summary['hit_count'], 2)
        self.assertEqual(summary['coverage_counts'], {'complete': 3, 'partial': 0, 'none': 1})
        self.assertEqual([row['sample_value'] for row in summary['examples']], [1, 1, 0, None])
        self.assertEqual(result['layer']['bounds'], [10, 20, 10.01, 20.02])
        output = self.path.with_name(result['layer']['artifact_ref'] + '.geojson')
        layer = json.loads(output.read_text(encoding='utf-8'))
        self.assertEqual([row['geometry'] for row in layer['features']], [p['geometry'] for p in points])
        self.assertEqual(layer['features'][-1]['properties']['analysis_status'], 'no_data')
        self.assertEqual(layer['analysis']['observed_at'], '2026-01-01')
        with self.assertRaisesRegex(ValueError, 'OSM query'):
            joint.prepare({**self.payload, 'osm_ref': output.stem})

    def test_building_uses_original_clipped_geometry_and_distinguishes_dry_partial_and_missing(self):
        # The source polygon ends at the AOI edge, exactly as returned by the OSM query.
        polygon = [[[10.005, 20.005], [10.01, 20.005], [10.01, 20.01], [10.005, 20.01], [10.005, 20.005]]]
        buildings = [feature('Polygon', 'way', n, polygon) for n in range(1, 5)]
        self.source(buildings)
        self.payload.update(mode='building_flood', show_on_map=True, crs_transform=[10, 0, 0, 0, -10, 0])
        del self.payload['scale']
        result, graph = self.run_worker({
            'way/1': {'grid_area_m2': 100, 'observed_area_m2': 50, 'flood_area_m2': 25},
            'way/2': {'grid_area_m2': 100, 'observed_area_m2': 100, 'flood_area_m2': 0},
            'way/3': {'grid_area_m2': 100}, 'way/4': {},
        })
        for operation in ('Image.pixelArea', 'Image.reduceRegions', 'Reducer.sum', 'maxPixelsPerRegion', 'crsTransform'):
            self.assertIn(operation, graph)
        self.assertEqual(result['summary']['hit_count'], 1)
        self.assertEqual(result['summary']['coverage_counts'], {'complete': 1, 'partial': 1, 'none': 2})
        self.assertEqual([row['flood_area_m2'] for row in result['summary']['examples']], [25, 0, None, None])
        self.assertEqual([row['coverage_fraction'] for row in result['summary']['examples']], [.5, 1, 0, None])
        layer = json.loads(self.path.with_name(result['layer']['artifact_ref'] + '.geojson').read_text(encoding='utf-8'))
        self.assertEqual(layer['features'][0]['geometry']['coordinates'], polygon)

    def test_empty_upstream_artifact_and_bad_parameters_fail_before_earth_engine(self):
        self.source([])
        cases = [({}, 'nonempty GeoJSON'), ({'osm_ref': '../' + REF}, 'artifact_ref'),
                 ({'osm_ref': 'd' * 32}, 'unavailable in this task'), ({'scale': 0}, 'finite positive'),
                 ({'crs_transform': [1, 0, 0, 0, -1, 0]}, 'exactly one'), ({'code': 'import os'}, 'Remove the import')]
        with patch.object(gee_worker, 'earth_engine') as initialize:
            for changes, message in cases:
                with self.subTest(changes=changes), self.assertRaisesRegex(ValueError, message):
                    gee_worker.execute({**self.payload, **changes})
            initialize.assert_not_called()

    def test_geometry_and_artifact_limits_fail_before_earth_engine(self):
        point = feature('Point', 'node', 1, [10.005, 20.005])
        with patch.object(gee_worker, 'earth_engine') as initialize:
            self.source([point] * (joint.MAX_FEATURES + 1))
            with self.assertRaisesRegex(ValueError, '1,000 features'):
                gee_worker.execute(self.payload)
            self.path.write_bytes(b' ' * (joint.MAX_INPUT_BYTES + 1))
            with self.assertRaisesRegex(ValueError, 'byte budget'):
                gee_worker.execute(self.payload)
            self.source([point])
            with self.assertRaisesRegex(ValueError, 'geometry does not match'):
                gee_worker.execute({**self.payload, 'mode': 'building_flood'})
            initialize.assert_not_called()

    def test_all_masked_points_are_reported_without_a_false_hit_count(self):
        self.source([feature('Point', 'node', 1, [10.005, 20.005])])
        result, _ = self.run_worker({})
        self.assertEqual(result['summary']['status'], 'no_raster_coverage')
        self.assertNotIn('hit_count', result['summary'])
        self.assertNotIn('layer', result)
