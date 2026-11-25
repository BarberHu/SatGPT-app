import json
from pathlib import Path
import subprocess
import sys
from threading import Barrier, Event, get_ident
import unittest
from unittest.mock import patch

from harness.app import gee_worker


class GeeTimingTests(unittest.TestCase):
    def test_two_requests_overlap_and_results_remain_in_order(self):
        both_started = Barrier(2, timeout=3)
        second_finished = Event()
        requests = []

        def read(index):
            gee_worker.count_http_request()
            if index < 2:
                both_started.wait()
            if index == 0 and not second_finished.wait(3):
                raise AssertionError('Second request did not finish')
            if index == 1:
                second_finished.set()
            return index

        token = gee_worker._HTTP_REQUESTS.set(requests)
        try:
            self.assertEqual(list(gee_worker.map_two_gee_requests(read, range(3))), [0, 1, 2])
        finally:
            gee_worker._HTTP_REQUESTS.reset(token)
        self.assertEqual(len(requests), 3)
        self.assertEqual(list(gee_worker.map_two_gee_requests(lambda _: get_ident(), range(1))), [get_ident()])

    def test_failed_request_stops_following_batches(self):
        def read(index):
            if index == 1:
                raise RuntimeError('GEE request failed')
            self.assertEqual(index, 0)
            return index

        with self.assertRaisesRegex(RuntimeError, 'GEE request failed'):
            list(gee_worker.map_two_gee_requests(read, range(4)))

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
