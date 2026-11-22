import json
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

from harness.app import gee_worker


class GeeTimingTests(unittest.TestCase):
    def test_thumbnail_warmup_initializes_without_a_probe_and_reuses_the_session(self):
        payload = {'operation': 'layer_thumbnail_warmup', 'project': 'fixture'}
        cached_ee = object()
        timings = []
        token = gee_worker._TIMINGS.set(timings)
        try:
            with patch.multiple(gee_worker, _SESSION=None, _PROJECT=None):
                with patch.object(gee_worker, 'earth_engine', return_value=cached_ee) as initialize:
                    self.assertEqual(gee_worker.execute(payload), {'initialized': True})
                    initialize.assert_called_once_with('fixture')
                with patch.multiple(gee_worker, _SESSION=cached_ee, _PROJECT='fixture'):
                    self.assertEqual(gee_worker.execute(payload), {'initialized': True})
            self.assertEqual([entry['stage'] for entry in timings], ['ee_initialize', 'ee_reuse'])
        finally:
            gee_worker._TIMINGS.reset(token)

    def test_json_lines_timing_is_opt_in_and_covers_local_failures(self):
        requests = (('first', False, 'result = 1'), ('second', True, 'result = 1'),
                    ('third', True, 'print(1)'))
        lines = [json.dumps({'id': key, 'timing': enabled,
                             'payload': {'operation': 'eval' if key == 'third' else 'check', 'code': code}})
                 for key, enabled, code in requests]
        completed = subprocess.run([sys.executable, '-I', str(Path(gee_worker.__file__))],
                                   input='\n'.join(lines) + '\n', text=True, capture_output=True,
                                   check=True, timeout=15)
        first, second, third = map(json.loads, completed.stdout.splitlines())
        self.assertNotIn('timings', first)
        self.assertNotIn('http_requests', first)
        self.assertEqual(first['data'], second['data'])
        self.assertEqual(second['timings'][0]['stage'], 'validate')
        self.assertGreaterEqual(second['timings'][0]['duration_ms'], 0)
        self.assertEqual(second['http_requests'], 0)
        self.assertFalse(third['ok'])
        self.assertEqual(third['timings'][0]['outcome'], 'error')
        self.assertEqual(third['http_requests'], 0)
        self.assertEqual(set(third['timings'][0]), {'stage', 'duration_ms', 'outcome'})
