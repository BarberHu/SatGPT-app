import unittest
from types import SimpleNamespace
from unittest.mock import Mock, patch

from harness.app.agent import conversation_prompt, describe_run_failure
from harness.app.controller import validate_bounds
from harness.app.gee_worker import checked_code, execute as gee_execute
from harness.app.trace import clean_text


class EnglishInterfaceTests(unittest.TestCase):
    def test_prompt_defaults_to_english_without_rewriting_user_content(self):
        user = '显示郑州的洪水范围'
        prompt = conversation_prompt(user, [100, 10, 101, 11], [])
        self.assertIn('Use English by default', prompt)
        self.assertIn('legend labels', prompt)
        self.assertIn('Follow an explicit user request for another language', prompt)
        self.assertTrue(prompt.endswith(user))

    def test_prompt_provides_request_time_and_valid_gee_example(self):
        submitted = '2026-11-19T03:40:59.863108+00:00'
        prompt = conversation_prompt('Find recent imagery', [100, 10, 101, 11], [], created_at=submitted)
        self.assertIn(f'Request submitted at {submitted} (UTC).', prompt)
        self.assertIn('system:time_start', prompt)
        self.assertIn('gee_check', prompt)
        examples = [block.split('\n```', 1)[0] for block in prompt.split('```python\n')[1:]]
        self.assertEqual(len(examples), 3)
        for example in examples:
            with self.subTest(example=example):
                self.assertEqual(gee_execute({'operation': 'check', 'code': example}),
                                 {'valid': True, 'errors': [], 'warnings': []})

    def test_gee_preflight_rejects_unsupported_python_with_repairs(self):
        cases = [
            ('import ee\nresult = 1', 'ee is already available'),
            ('print(1)\nresult = 1', 'Assign the output to result'),
            ('def mask(img):\n    return img\nresult = 1', 'Use an inline lambda'),
            ("stats = {'count': 1}\nstats", 'Write result = stats'),
            ("{'count': 1}", 'result = {...}'),
        ]
        for code, hint in cases:
            with self.subTest(code=code):
                report = gee_execute({'operation': 'check', 'code': code})
                self.assertFalse(report['valid'])
                self.assertIn(hint, report['errors'][0])

    def test_gee_eval_and_check_reject_a_numeric_crs_transform_before_earth_engine(self):
        cases = [
            'result = image.reduceRegion(reducer, analysis_region, 30, None, 1e9)',
            'result = image.reduceRegion(reducer, analysis_region, 30, None, 100000000, False)',
            'result = image.reduceRegion(reducer, analysis_region, 30, None, 1000000000, False, 1000000000)',
            'image = ee.Image(1)\nresult = image.reduceRegion(crsTransform=-1000)',
        ]
        with patch('harness.app.gee_worker.earth_engine') as earth_engine:
            for code in cases:
                with self.subTest(code=code):
                    report = gee_execute({'operation': 'check', 'code': code})
                    self.assertFalse(report['valid'])
                    line = len(code.splitlines())
                    self.assertIn(f'(line {line})', report['errors'][0])
                    self.assertIn('maxPixels=<integer>', report['errors'][0])
                    with self.assertRaises(ValueError) as error:
                        gee_execute({'operation': 'eval', 'code': code, 'project': 'offline'})
                    self.assertEqual(str(error.exception), report['errors'][0])
            earth_engine.assert_not_called()

    def test_gee_check_keeps_valid_reduce_region_argument_forms(self):
        cases = [
            'result = image.reduceRegion(reducer=reducer, scale=30, maxPixels=100_000_000)',
            'result = image.reduceRegion(reducer, analysis_region, None, crs, [30, 0, 0, 0, -30, 0])',
            'result = image.reduceRegion(reducer, analysis_region, 30, crs, None)',
            'result = image.reduceRegion(reducer, analysis_region, None, crs, transform)',
            'result = image.reduceRegion(crsTransform=ee.List(transform))',
            'result = image.reduceRegion(*args, 1, 2, 3, 4)',
            'result = images.map(lambda image: image.select("B4"))',
        ]
        for code in cases:
            with self.subTest(code=code):
                self.assertTrue(gee_execute({'operation': 'check', 'code': code})['valid'])

    def test_gee_eval_and_check_reject_known_bad_collection_callbacks_locally(self):
        cases = [
            ('scenes = ee.ImageCollection("CHIRPS").filterBounds(analysis_region)\n'
             'result = scenes.sort("system:time_start").map(lambda image: ee.Date(image.get("system:time_start")).format("YYYY-MM-dd"))',
             2, 'aggregate_array'),
            ('collection = ee.ImageCollection("CHIRPS").filterBounds(analysis_region)\n'
             'sub = collection.filterDate("2024-07-08", "2024-07-15").select("precipitation")\n'
             'result = sub.map(lambda img: ee.Image(img).reduceRegion(geometry=analysis_region, scale=5500).set("t", img.get("system:time_start")))',
             3, 'returns a dictionary'),
            ('result = ee.FeatureCollection("table").map(algorithm=lambda feature: ee.Date(feature.get("date")).format("YYYY"))',
             1, 'ee.Feature'),
        ]
        with patch('harness.app.gee_worker.earth_engine') as earth_engine:
            for code, line, hint in cases:
                with self.subTest(code=code):
                    report = gee_execute({'operation': 'check', 'code': code})
                    self.assertFalse(report['valid'])
                    error = report['errors'][0]
                    self.assertIn(f'(line {line})', error)
                    self.assertIn(hint, error)
                    with self.assertRaises(ValueError) as rejected:
                        gee_execute({'operation': 'eval', 'code': code, 'project': 'offline'})
                    self.assertEqual(str(rejected.exception), error)
            earth_engine.assert_not_called()

    def test_collection_callback_check_preserves_valid_and_unknown_types(self):
        cases = [
            'result = ee.ImageCollection("CHIRPS").map(lambda image: image.set("mean", image.reduceRegion(scale=5500)))',
            'result = ee.FeatureCollection("table").map(lambda feature: feature.set("year", ee.Date(feature.get("date")).format("YYYY")))',
            'dates = ee.ImageCollection("CHIRPS").aggregate_array("system:time_start")\n'
            'result = ee.List(dates).map(lambda ms: ee.Date(ms).format("YYYY-MM-dd"))',
            'result = records.map(lambda ms: ee.Date(ms).format("YYYY"))',
            'records = ee.ImageCollection("CHIRPS")\n'
            'records = ee.List(values)\nresult = records.map(lambda ms: ee.Date(ms).format("YYYY"))',
            'records = ee.ImageCollection("CHIRPS")\nmatch ee.List(values):\n'
            '    case records:\n        value = 1\nresult = records.map(lambda ms: ee.Date(ms).format("YYYY"))',
            'records = ee.ImageCollection("CHIRPS")\n'
            'result = records.map(lambda records: records.set("days", ee.List(values).map(lambda ms: ee.Date(ms).format("YYYY"))))',
        ]
        for code in cases:
            with self.subTest(code=code):
                self.assertTrue(gee_execute({'operation': 'check', 'code': code})['valid'])

    def test_gee_eval_automatically_checks_then_returns_keyword_reductions(self):
        value = SimpleNamespace(getInfo=Mock(return_value={'constant': 1}))
        reduce_region = Mock(return_value=value)
        ee = SimpleNamespace(Image=Mock(return_value=SimpleNamespace(reduceRegion=reduce_region)))
        with patch('harness.app.gee_worker.earth_engine', return_value=ee) as earth_engine:
            with self.assertRaisesRegex(ValueError, 'top-level assignments.*Use an inline lambda'):
                gee_execute({'operation': 'eval', 'code': 'def f():\n    return 1\nresult = f()', 'project': 'offline'})
            earth_engine.assert_not_called()
            output = gee_execute({
                'operation': 'eval', 'project': 'offline',
                'code': 'result = ee.Image(1).reduceRegion(scale=30, maxPixels=100_000_000)',
            })
        self.assertEqual(output, {'result': {'constant': 1}})
        reduce_region.assert_called_once_with(scale=30, maxPixels=100_000_000)
        value.getInfo.assert_called_once_with()

    def test_user_visible_errors_and_redactions_are_english(self):
        with self.assertRaisesRegex(ValueError, 'west,south,east,north'):
            validate_bounds([])
        with self.assertRaisesRegex(ValueError, 'assign a value to result'):
            checked_code('value = 1')
        result = SimpleNamespace(finish_reason='failed', events=[{
            'type': 'turn/end', 'data': {'reason': {'error': {'code': 'AUTH'}}}}])
        self.assertIn('rejected the API key', describe_run_failure(result, 'aihubmix'))
        self.assertNotIn('test-secret', clean_text('test-secret', ['test-secret']))
        self.assertIn('REDACTED', clean_text('test-secret', ['test-secret']))


if __name__ == '__main__':
    unittest.main()
