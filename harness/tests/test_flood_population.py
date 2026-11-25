import unittest
from unittest.mock import Mock, patch

import numpy as np
from shapely.geometry import Polygon, box, mapping

from harness.app import gee_worker
from harness.app.flood_population import (
    FLOOD_BANDS, GFD, check_overlap_budget, display_code, estimate, native_window, prepare, summarize,
)


def projection(width):
    return {'crs': 'EPSG:4326', 'transform': [width, 0, 0, 0, -1, 1]}


class FloodPopulationTests(unittest.TestCase):
    def test_overlap_fraction_uses_full_population_cell_and_ignores_masked_cells(self):
        bounds = (0.5, 0, 3.5, 1)
        flood_grid = native_window(projection(1), bounds)
        pop_grid = native_window(projection(2), bounds)
        result = summarize(bounds, flood_grid, pop_grid, np.array([[1, 0, 1, 1]], dtype=bool),
                           np.array([[1, 0, 0, 1]], dtype=bool), np.array([[8, -9999]]))
        self.assertEqual(result['status'], 'ok')
        self.assertAlmostEqual(result['exposed_people'], 2)
        self.assertAlmostEqual(result['joint_valid_fraction'], 1 / 6)

    def test_valid_zero_and_missing_population_are_distinct(self):
        bounds = (0, 0, 1, 1)
        grid = native_window(projection(1), bounds)
        observed, dry = np.array([[True]]), np.array([[False]])
        zero = summarize(bounds, grid, grid, observed, dry, np.array([[0]]))
        missing = summarize(bounds, grid, grid, observed, observed, np.array([[-9999]]))
        self.assertEqual((zero['status'], zero['exposed_people'], zero['joint_valid_fraction']), ('ok', 0, 1))
        self.assertEqual((missing['status'], missing['exposed_people']), ('no_joint_coverage', None))

    def test_validates_scope_and_raster_budgets(self):
        payload = {'event_id': 4020, 'country': 'IDN', 'year': 2013, 'exclude_permanent_water': True,
                   'analysis_context': {'analysis_region': mapping(box(0, 0, 1, 1))}}
        self.assertEqual(prepare(payload), (0, 0, 1, 1))
        payload['analysis_context']['analysis_region'] = mapping(Polygon([(0, 0), (1, 0), (1, 1), (0, 0)]))
        with self.assertRaisesRegex(ValueError, 'rectangle'):
            prepare(payload)
        with self.assertRaisesRegex(ValueError, 'pixel budget'):
            native_window(projection(0.000001), (0, 0, 3, 1))
        rotated = {'crs': 'EPSG:4326', 'transform': [1, 0.1, 0, 0, -1, 1]}
        with self.assertRaisesRegex(ValueError, 'unrotated'):
            native_window(rotated, (0, 0, 1, 1))
        grid = native_window(projection(1), (0, 0, 1, 1))
        with patch('harness.app.flood_population.MAX_OVERLAP_CELLS', 2):
            with self.assertRaisesRegex(ValueError, 'calculation budget'):
                check_overlap_budget(grid, grid)

    def test_no_valid_or_eligible_flood_observation_stops_before_worldpop(self):
        bounds = (0, 0, 1, 1)
        args = {'event_id': 3893, 'country': 'FJI', 'year': 2012, 'exclude_permanent_water': True}
        for clear, permanent, status in ((0, 0, 'no_flood_observations'), (2, 1, 'no_eligible_flood_observations'),
                                         (2, -9999, 'no_eligible_flood_observations')):
            with self.subTest(status=status, permanent=permanent):
                ee = Mock()
                ee.Dictionary.return_value.getInfo.return_value = {'count': 1, 'start': [], 'end': []}
                ee.Image.return_value.select.return_value.projection.return_value.getInfo.return_value = projection(1)
                ee.data.computePixels.return_value = np.array([[(1, clear, permanent)]],
                                                               dtype=[(band, 'f4') for band in FLOOD_BANDS])
                result = estimate(ee, args, bounds)
                self.assertEqual(result['status'], status)
                self.assertIsNone(result['exposed_people'])
                ee.ImageCollection.assert_called_once_with(GFD)

    def test_optional_layer_retains_statistics_and_original_scope(self):
        context = {'bounds': [0, 0, 1, 1], 'analysis_region': mapping(box(0, 0, 1, 1))}
        payload = {'operation': 'flood_population', 'project': 'test', 'event_id': 4020, 'country': 'IDN',
                   'year': 2013, 'exclude_permanent_water': True, 'analysis_context': context}
        stats = {'status': 'ok', 'exposed_people': 12, 'joint_valid_flood_area_km2': 0.2,
                 'population_year': 2013, 'event_id': 4020}
        ee = Mock()
        with patch.object(gee_worker, 'earth_engine', return_value=ee), patch(
                'flood_population.estimate', side_effect=lambda *_: dict(stats)), patch.object(
                gee_worker, 'run_code') as run, patch.object(gee_worker, 'create_map_layer',
                return_value={'name': 'Test layer', 'visualization': {}}), patch.object(
                gee_worker, 'attach_thumbnail'):
            self.assertEqual(gee_worker.execute(payload), stats)
            run.assert_not_called()
            output = gee_worker.execute({**payload, 'show_on_map': True})
            code = display_code(payload)
            run.assert_called_once_with(ee, code, context, clip_result=True)
            gee_worker.checked_code(code)
            self.assertEqual(output['display_code'], code)
            self.assertEqual(output['map_status'], 'published')
            self.assertEqual(output['exposed_people'], 12)
            run.side_effect = RuntimeError('Map unavailable')
            self.assertEqual(gee_worker.execute({**payload, 'show_on_map': True}), {**stats, 'map_status': 'failed'})

    def test_layer_skips_unavailable_support_and_empty_flood_overlap(self):
        for status, people, area, outcome in [('no_joint_coverage', None, None, 'no_valid_exposure'),
                                               ('ok', 0, 0, 'no_joint_flood')]:
            with self.subTest(status=status), patch.object(gee_worker, 'run_code') as run:
                output = {'status': status, 'exposed_people': people, 'joint_valid_flood_area_km2': area}
                gee_worker.add_population_layer(None, {}, output)
                run.assert_not_called()
                self.assertEqual(output['map_status'], outcome)
                self.assertEqual(output['exposed_people'], people)
