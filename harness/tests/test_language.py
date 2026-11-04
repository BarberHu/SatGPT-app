import unittest
from types import SimpleNamespace

from harness.app.agent import conversation_prompt, describe_run_failure
from harness.app.controller import validate_bounds
from harness.app.gee_worker import checked_code
from harness.app.trace import clean_text


class EnglishInterfaceTests(unittest.TestCase):
    def test_prompt_defaults_to_english_without_rewriting_user_content(self):
        user = '显示郑州的洪水范围'
        prompt = conversation_prompt(user, [100, 10, 101, 11], [])
        self.assertIn('Use English by default', prompt)
        self.assertIn('legend labels', prompt)
        self.assertIn('Follow an explicit user request for another language', prompt)
        self.assertTrue(prompt.endswith(user))

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
