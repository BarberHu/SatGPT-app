import os
import tempfile
import unittest
from datetime import datetime
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import TaskController
from harness.app.turn_usage import summarize_turn_usage
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, result, task_body, wait_for_task


def turn_events(*, include_final=True):
    def event(seq, kind, **data):
        return {'seq': seq, 'type': kind, 'data': {'turn': 1, **data}}

    def sample(**usage):
        return {'type': 'chunk', 'chunk': {'type': 'usage', 'usage': usage}}

    retry = event(4, 'llm/retry-started', step=1, retry=1)
    return [
        event(1, 'turn/start'),
        event(2, 'step/start', step=1),
        event(3, 'assistant/attempt', step=1, stream=[
            sample(inputTokens=4, outputTokens=1, totalTokens=5),
            sample(inputTokens=4, outputTokens=2, totalTokens=6),
        ]),
        retry, retry,
        event(5, 'assistant/message', step=1, usage={'inputTokens': 10, 'outputTokens': 4, 'totalTokens': 18},
              stream=[sample(inputTokens=10, outputTokens=3, totalTokens=17)]),
        event(6, 'step/end', step=1),
        event(7, 'step/start', step=2),
        event(8, 'assistant/message', step=2, stream=[
            sample(inputTokens=6, outputTokens=2, cacheReadTokens=3, cacheWriteTokens=1),
        ] if include_final else []),
        event(9, 'step/end', step=2),
        event(10, 'turn/end'),
    ]


def at(value):
    return int(datetime.fromisoformat(value).timestamp() * 1000)


def priced_turn_events():
    events = turn_events()
    for event, clock in zip(events, ('00:59:57', '00:59:58', '00:59:59', '01:00:01', '01:00:01',
                                     '01:00:02', '01:00:03', '04:00:01', '04:00:02', '04:00:03', '04:00:04')):
        event['time'] = at(f'2026-11-23T{clock}Z')
    events[5]['data']['usage']['cacheReadTokens'] = 4
    events[8]['data']['stream'][0]['chunk']['usage'].update(cacheReadTokens=4, cacheWriteTokens=0)
    return events


class TurnUsageTests(unittest.TestCase):
    def test_counts_attempts_once_including_cache_and_retry(self):
        self.assertEqual(summarize_turn_usage(turn_events()),
                         {'status': 'complete', 'input_tokens': 28, 'output_tokens': 8, 'total_tokens': 36})

    def test_missing_provider_usage_or_lifecycle_is_explicit(self):
        self.assertEqual(summarize_turn_usage(turn_events(include_final=False)),
                         {'status': 'partial', 'input_tokens': 18, 'output_tokens': 6, 'total_tokens': 24})
        self.assertEqual(summarize_turn_usage(turn_events()[:-1])['status'], 'partial')
        self.assertEqual(summarize_turn_usage([event for event in turn_events() if event['seq'] not in (7, 8, 9)])['status'],
                         'partial')
        self.assertEqual(summarize_turn_usage([]), {'status': 'unavailable'})

    def test_zero_filled_transport_failure_is_not_reported_as_usage(self):
        events = turn_events(include_final=False)
        events[2]['data']['stream'][-1]['chunk']['usage'] = {'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0}
        events[5]['data']['usage'] = {'inputTokens': 0, 'outputTokens': 0, 'totalTokens': 0}
        self.assertEqual(summarize_turn_usage(events), {'status': 'unavailable'})

    def test_sunday_reference_cost_uses_exact_reported_input_and_output(self):
        start = at('2026-11-22T07:37:20.029Z')
        events = [{'seq': seq, 'time': start + seq * 1_000, 'type': kind, 'data': {'turn': 1, **fields}}
                  for seq, (kind, fields) in enumerate([
                      ('turn/start', {}), ('step/start', {'step': 1}),
                      ('assistant/message', {'step': 1, 'usage': {
                          'inputTokens': 9825, 'outputTokens': 74, 'totalTokens': 9899},
                          'message': {'source': {'provider': 'aihubmix', 'model': 'deepseek-v4.1-flash-1017'}}}),
                      ('step/end', {'step': 1}), ('turn/end', {}),
                  ], 1)]
        self.assertEqual(Decimal(summarize_turn_usage(events)['estimated_cost']['amount']), Decimal('0.001568755'))

    def test_cost_uses_each_attempt_window_and_cache_read_rate(self):
        summary = summarize_turn_usage(priced_turn_events(), provider='aihubmix', model='deepseek-v4.1-flash-1017')
        self.assertEqual(summary['total_tokens'], 36)
        self.assertEqual(Decimal(summary['estimated_cost']['amount']), Decimal('0.000012122'))

    def test_cost_is_omitted_for_an_unpriceable_attempt(self):
        for case in ('unknown_cache_bucket', 'missing_usage', 'crosses_price_boundary', 'unknown_route'):
            with self.subTest(case):
                events = priced_turn_events()
                if case == 'unknown_cache_bucket':
                    del events[5]['data']['usage']['cacheReadTokens']
                elif case == 'missing_usage':
                    events[8]['data']['stream'] = []
                elif case == 'crosses_price_boundary':
                    events[2]['time'] = at('2026-11-23T01:00:00Z')
                else:
                    events[5]['data']['message'] = {'source': {'provider': 'aihubmix', 'model': 'unpriced-model'}}
                result = summarize_turn_usage(events, provider='aihubmix', model='deepseek-v4.1-flash-1017')
                self.assertEqual(result['status'], 'partial' if case == 'missing_usage' else 'complete')
                self.assertNotIn('estimated_cost', result)

    def test_development_receipt_stream_and_history_are_hidden_after_restart_with_default(self):
        def run(**_):
            answer = result()
            answer.events = priced_turn_events()
            return answer

        def runtime(*args):
            simulated = SimulatedRuntime(*args, run=run)
            simulated.provider = 'aihubmix'
            simulated.model = 'deepseek-v4.1-flash-1017'
            return simulated

        root = Path(__file__).resolve().parents[1]
        with tempfile.TemporaryDirectory() as directory:
            state = Path(directory)
            with patch.dict(os.environ, {'SATGPT_DEV_TURN_USAGE': '1'}):
                dev = TaskController(root, state=state, runtime_factory=runtime)
            client = client_for(dev)
            request = task_body(None)
            try:
                receipt = client.post('/api/harness/tasks', json=request).json()
                task_url = '/api/harness/tasks/' + receipt['id']
                chat_url = '/api/harness/conversations/' + receipt['conversation_id']
                settled = wait_for_task(client, receipt['id'])
                self.assertEqual(settled['dev_turn_usage']['total_tokens'], 36)
                self.assertEqual(Decimal(settled['dev_turn_usage']['estimated_cost']['amount']), Decimal('0.000012122'))
                self.assertIn('"dev_turn_usage"', client.get(task_url + '/events').text)
                self.assertIn('"estimated_cost"', client.get(task_url + '/events').text)
                history = client.get(chat_url).json()['messages']
                self.assertNotIn('dev_turn_usage', history[0])
                self.assertEqual(history[1]['dev_turn_usage'], settled['dev_turn_usage'])
            finally:
                dev.close()

            with patch.dict(os.environ):
                os.environ.pop('SATGPT_DEV_TURN_USAGE', None)
                normal = TaskController(root, state=state, runtime_factory=runtime)
            try:
                client.app.state.controller = normal
                self.assertFalse(normal.dev_turn_usage)
                responses = [client.get(task_url), client.get(task_url + '/events'), client.get(chat_url),
                             client.get('/api/harness/conversation'), client.post(task_url + '/cancel'),
                             client.post('/api/harness/tasks', json=request)]
                for response in responses:
                    response.raise_for_status()
                    self.assertNotIn('"dev_turn_usage"', response.text)
                    self.assertNotIn('"estimated_cost"', response.text)
                ordinary = client.post('/api/harness/tasks', json=task_body(None)).json()
                self.assertNotIn('dev_turn_usage', wait_for_task(client, ordinary['id']))
            finally:
                normal.close()
                client.close()
