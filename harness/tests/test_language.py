import ast
import re
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from types import SimpleNamespace
from unittest.mock import Mock, patch

from harness.app.agent import conversation_prompt, describe_run_failure
from harness.app.bootstrap import ensure_plugin
from harness.app.controller import validate_bounds
from harness.app.gee_worker import checked_code, execute as gee_execute
from harness.app.trace import clean_text


HARNESS = Path(__file__).resolve().parents[1]
SYSTEM_PROMPT = (HARNESS / 'integrations' / 'gee-tools' / 'system-prompt.md').read_text(encoding='utf-8')
SKILLS = HARNESS / 'skills'


def python_examples(skill):
    text = (SKILLS / skill / 'SKILL.md').read_text(encoding='utf-8')
    return re.findall(r'```python\n(.*?)\n```', text, re.DOTALL)


class SkillBootstrapTests(unittest.TestCase):
    def test_sdk_bootstrap_installs_and_updates_only_the_managed_skills(self):
        names = ('flood-extent', 'flood-exposure', 'sentinel2-latest', 'rainfall-analysis')
        with TemporaryDirectory() as temp:
            home = Path(temp)
            unrelated = home / 'skills' / 'other-skill' / 'SKILL.md'
            unrelated.parent.mkdir(parents=True)
            unrelated.write_text('keep this', encoding='utf-8')
            ensure_plugin(home)
            installed = home / 'profiles/sdk/node_modules/@local/webgis-gee-tools/system-prompt.md'
            self.assertEqual(installed.read_text(encoding='utf-8'), SYSTEM_PROMPT)
            for name in names:
                with self.subTest(name=name):
                    actual = home / 'skills' / name / 'SKILL.md'
                    self.assertEqual(actual.read_bytes(), (SKILLS / name / 'SKILL.md').read_bytes())
                    actual.write_text('previous version', encoding='utf-8')

            ensure_plugin(home)
            for name in names:
                with self.subTest(updated=name):
                    actual = home / 'skills' / name / 'SKILL.md'
                    self.assertEqual(actual.read_bytes(), (SKILLS / name / 'SKILL.md').read_bytes())
            self.assertEqual(unrelated.read_text(encoding='utf-8'), 'keep this')


class EnglishInterfaceTests(unittest.TestCase):
    def test_prompt_defaults_to_english_without_rewriting_user_content(self):
        user = '显示郑州的洪水范围'
        prompt = conversation_prompt(user, [100, 10, 101, 11], [])
        self.assertIn('Use English by default', SYSTEM_PROMPT)
        self.assertIn('legend labels', SYSTEM_PROMPT)
        self.assertIn('Follow an explicit user request for another language', SYSTEM_PROMPT)
        self.assertTrue(prompt.endswith(user))
        self.assertNotIn('Use English by default', prompt)

    def test_turn_keeps_request_time_and_gives_examples_only_to_skills(self):
        submitted = '2026-11-19T03:40:59.863108+00:00'
        prompt = conversation_prompt('Find recent imagery', [100, 10, 101, 11], [], created_at=submitted)
        self.assertIn(f'Request submitted at {submitted} (UTC).', prompt)
        self.assertNotIn('```python', prompt)
        self.assertIn('system:time_start', SYSTEM_PROMPT)
        self.assertIn('Normal tools validate scripts locally', SYSTEM_PROMPT)
        self.assertIn('Use `gee_check` for debugging', SYSTEM_PROMPT)
        examples = python_examples('sentinel2-latest') + python_examples('rainfall-analysis')
        self.assertEqual(len(examples), 4)
        for example in examples:
            with self.subTest(example=example):
                self.assertEqual(gee_execute({'operation': 'check', 'code': example}),
                                 {'valid': True, 'errors': [], 'warnings': []})

    def test_rainfall_examples_bind_each_period_and_use_original_masks(self):
        skill = (SKILLS / 'rainfall-analysis' / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('Empty, null, or failed queries require permission before widening scope', SYSTEM_PROMPT)
        self.assertIn('Skip collection-wide totals and date ranges.', skill)
        self.assertIn('A valid zero stays zero; report a null mean as missing.', skill)
        self.assertIn('Follow an explicit user request for another language or output format', SYSTEM_PROMPT)
        examples = python_examples('rainfall-analysis')
        for example in examples:
            tree = ast.parse(example)
            methods = [node for node in ast.walk(tree) if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)]
            dates = [tuple(arg.value for arg in node.args) for node in methods if node.func.attr == 'filterDate']
            self.assertCountEqual(dates, [('FIRST_START_UTC', 'FIRST_END_UTC'), ('SECOND_START_UTC', 'SECOND_END_UTC')])
            names = {node.func.attr for node in methods}
            self.assertIn('filterBounds', names)
            self.assertFalse(names & {'Rectangle', 'Point', 'bounds', 'buffer', 'unmask', 'selfMask', 'updateMask', 'map'})
        self.assertIn('geometry=analysis_region', examples[1])
        self.assertIn('first.sum().reduceRegion', examples[1])
        self.assertIn('second.sum().reduceRegion', examples[1])

    def test_flood_approval_lives_in_system_prompt_and_skill_respects_approved_fallback(self):
        for rule in ('Wait for explicit approval of that plan', 'Map-area confirmation alone leaves the plan pending',
                     'Verify observations and coverage first', 'only after the primary query establishes its trigger',
                     'before widening the area or dates, relaxing sensor filters'):
            self.assertIn(rule, SYSTEM_PROMPT)
        skill = (SKILLS / 'flood-extent' / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn('only when the approved plan includes that fallback', skill)

    def test_flood_prompt_prioritizes_pixel_gated_multiscene_baseline(self):
        self.assertIn('check a multi-scene same-orbit pre-event baseline first', SYSTEM_PROMPT)
        self.assertIn('two valid baseline observations', SYSTEM_PROMPT)
        self.assertIn('classify each observation date separately', SYSTEM_PROMPT)
        skill = (SKILLS / 'flood-extent' / 'SKILL.md').read_text(encoding='utf-8')
        self.assertIn("per-pixel `count()`", skill)
        self.assertIn('per-pixel median of the eligible pre-event observations', skill)
        self.assertIn('single-scene fallback only if the approved plan permits it', skill)
        self.assertIn('Mask pixels that fail the sample or event-validity gate as unknown', skill)
        self.assertIn('use the historical dual-direction method when its support gate passes', skill)

    def test_flood_acquisition_example_passes_restricted_python_validation(self):
        examples = python_examples('flood-extent')
        self.assertEqual(len(examples), 1)
        self.assertEqual(gee_execute({'operation': 'check', 'code': examples[0]}),
                         {'valid': True, 'errors': [], 'warnings': []})

    def test_gee_eval_scene_metadata_normalizes_utc_and_preserves_generic_results(self):
        rows = [{'scene_id': 'baseline', 'time_ms': 1729508415870, 'role': 'baseline'},
                {'scene_id': 'event', 'time_ms': 1730372414630},
                {'scene_id': 'missing'}]
        inputs = {'operation': 'eval', 'code': 'result = []', 'project': 'example'}
        with patch('harness.app.gee_worker.earth_engine', return_value=SimpleNamespace()), \
                patch('harness.app.gee_worker.run_code', return_value=rows):
            formatted = gee_execute({**inputs, 'result_format': 'scene_metadata'})['result']
            self.assertEqual(gee_execute(inputs)['result'], rows)
        self.assertEqual([item['time_utc'] for item in formatted],
                         ['2024-10-21T11:00:15.870Z', '2024-10-31T11:00:14.630Z', None])
        self.assertEqual(formatted[1]['time_ms'], 1730372414630)
        self.assertEqual(formatted[0]['role'], 'baseline')

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
