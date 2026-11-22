import json
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
import unittest
from unittest.mock import Mock, patch

import numpy as np
from shapely.geometry import box, mapping

from harness.app.agent import conversation_prompt
from harness.app.controller import TaskController
from harness.app.flood_results import load, read_grid_pixels, save, summarize_pixels
from harness.app.road_flood_analysis import road_source, split_line, totals
from harness.app.road_snapshot import query_snapshot


class FloodRoadTests(unittest.TestCase):
    def test_large_flood_grid_reads_aligned_row_blocks(self):
        grid = {'x': 100, 'y': 200, 'scale': 10, 'width': 2, 'height': 5, 'crs': 'EPSG:32642'}
        expected = np.array([[0, 1], [2, 255], [254, 0], [1, 2], [0, 1]], dtype=np.uint8)
        compute = Mock(side_effect=[{'flood_class': block} for block in (expected[:2], expected[2:4], expected[4:])])
        ee = SimpleNamespace(data=SimpleNamespace(computePixels=compute))
        with patch('harness.app.flood_results.MAX_REQUEST_CELLS', 4):
            np.testing.assert_array_equal(read_grid_pixels(ee, 'image', grid), expected)
        requests = [call.args[0]['grid'] for call in compute.call_args_list]
        self.assertEqual([row['dimensions']['height'] for row in requests], [2, 2, 1])
        self.assertEqual([row['affineTransform']['translateY'] for row in requests], [200, 180, 160])
        self.assertEqual([row['affineTransform']['translateX'] for row in requests], [100, 100, 100])

    def test_centerline_uses_disjoint_cell_lengths(self):
        grid = {'x': 0, 'y': 10, 'scale': 10}
        pixels = np.array([[1, 1, 0, 255]], np.uint8)
        lengths, fragments = split_line([(0, 5), (15, 5), (40, 5)], pixels, grid)
        self.assertEqual(totals(lengths), {'dry_m': 10, 'flood_m': 20, 'excluded_m': 0,
                                          'unobserved_m': 10, 'total_m': 40, 'observed_m': 30})
        self.assertEqual(len(fragments), 1)
        self.assertEqual((fragments[0][0], fragments[0][-1]), ((0, 5), (20, 5)))

    def test_zero_and_missing_flood_lengths_are_distinct(self):
        grid = {'x': 0, 'y': 10, 'scale': 10}
        pixels = np.array([[0, 254], [2, 255]], np.uint8)
        dry, _ = split_line([(0, 5), (10, 5)], pixels, grid)
        boundary, fragments = split_line([(0, 0), (20, 0)], pixels, grid)
        self.assertEqual(totals(dry)['flood_m'], 0)
        self.assertEqual(totals(boundary)['flood_m'], None)
        self.assertEqual(boundary, [0, 0, 10, 10])
        self.assertEqual(fragments, [])

    def test_pixels_keep_dry_unknown_excluded_and_outside_separate(self):
        pixels = np.array([[0, 1, 2, 255, 254]], np.uint8)
        stats = summarize_pixels(pixels, 10, 0.75)
        self.assertEqual(stats['flood_km2'], .0001)
        self.assertEqual(stats['aoi_km2'], .0004)
        self.assertEqual(stats['observed_fraction'], .75)
        self.assertEqual(stats['classifiable_fraction'], .5)
        with self.assertRaisesRegex(ValueError, 'insufficient'):
            summarize_pixels(pixels, 10, .9)
        with self.assertRaisesRegex(ValueError, 'classification'):
            summarize_pixels(np.array([[1, 253]], np.uint8), 10, .5)

    def test_only_durable_completed_results_enter_the_prompt_as_summaries(self):
        with TemporaryDirectory() as tmp:
            controller = object.__new__(TaskController)
            controller.state = Path(tmp)
            owner, cid, job = 'owner', 'conversation', '1' * 32
            region = {'type': 'Polygon', 'coordinates': [[[0, 0], [1, 0], [1, 1], [0, 0]]]}
            bounds = [0, 0, 1, 1]
            directory = controller._artifact_fields(owner, cid, job)['artifact_dir']
            recipe = {'version': 1, 'grid': {'height': 1, 'width': 1}, 'geometry': region}
            ref = save(directory, recipe, np.array([[1]], np.uint8))
            loaded, pixels = load(directory, ref)
            self.assertEqual(loaded, recipe)
            self.assertEqual(int(pixels[0, 0]), 1)
            del pixels
            messages = [{'role': 'user', 'job_id': job, 'bounds': bounds, 'analysis_region': region},
                        {'role': 'assistant', 'job_id': job, 'status': 'completed',
                         'layers': [{'flood_result': {'ref': ref, 'event': 'March', 'observed_at': '2020-03-01'}}]}]
            self.assertEqual(controller._published_floods(owner, cid, messages)[ref]['analysis_region'], region)
            self.assertEqual(controller._published_floods('other', cid, messages), {})
            messages[-1]['status'] = 'cancelled'
            self.assertEqual(controller._published_floods(owner, cid, messages), {})
            prompt = conversation_prompt('Roads from the prior result', bounds, [], region,
                                         published_floods=[{'ref': ref, 'bounds': bounds}])
            self.assertNotIn(json.dumps(region), prompt)
            self.assertIn(ref, prompt)

    def test_regional_snapshot_scope_and_flood_binding(self):
        with TemporaryDirectory() as tmp:
            root = Path(tmp)
            snapshot = root / 'snapshot.json'
            snapshot.write_text(json.dumps({'coverage': mapping(box(0, 0, 10, 10)), 'category': 'major',
                'source': 'Test snapshot', 'source_sha256': 'test', 'osm_data_time': '2020-01-01', 'skipped_geometry': 0,
                'features': [{'properties': {'osm_type': 'way', 'osm_id': '1', 'category': 'primary'},
                              'geometry': {'type': 'LineString', 'coordinates': [[0, 5], [10, 5]]}}]}), encoding='utf-8')
            summary, content = query_snapshot(snapshot, 'major', box(1, 1, 9, 9))
            self.assertEqual(summary['count'], 1)
            self.assertIsNone(query_snapshot(snapshot, 'major', box(1, 1, 11, 9)))
            self.assertIsNone(query_snapshot(snapshot, 'local', box(1, 1, 9, 9)))
            result = json.loads(content)
            self.assertEqual(result['features'][0]['geometry']['coordinates'], [[1, 5], [9, 5]])
            osm_ref, flood_ref = 'a' * 32, 'b' * 32
            (root / f'{osm_ref}.geojson').write_text(json.dumps({**result, 'flood_result_ref': flood_ref}), encoding='utf-8')
            self.assertEqual(road_source(root, osm_ref, flood_ref)['flood_result_ref'], flood_ref)
            with self.assertRaisesRegex(ValueError, 'Query the roads again'):
                road_source(root, osm_ref, 'c' * 32)
