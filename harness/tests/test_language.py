import unittest
from types import SimpleNamespace

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
