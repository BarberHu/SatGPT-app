import json
import tempfile
import unittest
import urllib.error
import urllib.request
import threading
from unittest.mock import patch
from pathlib import Path

from harness.app.stream_bridge import StreamBridge
from harness.app.task_stream import TaskStream
from harness.app.trace import add_harness_event
from harness.app.controller import TaskController


def frame(kind, attempt='a', sequence=1, revision=1, **extra):
    return dict(type=kind, run_id='run', attempt_id=attempt, sequence=sequence, revision=revision, **extra)


class StreamTests(unittest.TestCase):
    def feed(self, capacity=2048):
        return TaskStream(dict(id='task', conversation_id='session', status='running', trace=[]), capacity)

    def test_live_delta_then_canonical_replacement_and_completion(self):
        feed = self.feed()
        feed.frame(frame('start'))
        feed.frame(frame('delta', sequence=2, revision=3, index=2, text='partial'))
        live = feed.read()[0]
        self.assertEqual(live['answer']['text'], 'partial')
        self.assertEqual(live['task']['status'], 'running')
        delta = feed.read(1, 0)[0]
        self.assertEqual(delta['type'], 'answer.delta')
        self.assertNotIn('task', delta)
        self.assertNotIn('trace', delta)
        feed.frame(frame('end', sequence=3, revision=4, index=4,
                         outcome={'kind': 'committed', 'eventType': 'assistant/message', 'seq': 8},
                         settlement={'event_type': 'assistant/message', 'seq': 8, 'text': 'canonical'}))
        self.assertEqual(feed.read()[0]['answer']['text'], 'canonical')
        feed.update(status='completed', output={'message': 'final'})
        self.assertIsNone(feed.read()[0]['answer'])
        feed.frame(frame('start', attempt='late', revision=10))
        self.assertIsNone(feed.read()[0]['answer'])

    def test_retry_abandonment_interruption_and_stale_frames(self):
        for outcome, settlement in [({'kind': 'abandoned'}, {}),
                ({'kind': 'committed', 'eventType': 'assistant/attempt', 'seq': 2}, {}),
                ({'kind': 'committed', 'eventType': 'assistant/message', 'seq': 2},
                 {'event_type': 'assistant/message', 'seq': 2, 'text': 'interrupted', 'interrupted': True})]:
            feed = self.feed()
            feed.frame(frame('start'))
            feed.frame(frame('delta', sequence=2, revision=2, index=0, text='discard'))
            feed.frame(frame('end', sequence=3, revision=3, index=1, outcome=outcome, settlement=settlement))
            self.assertIsNone(feed.read()[0]['answer'])
            feed.frame(frame('start', attempt='b', revision=4))
            feed.frame(frame('delta', attempt='a', sequence=4, revision=5, index=2, text='late'))
            feed.frame(frame('delta', attempt='b', sequence=2, revision=6, index=0, text='new'))
            feed.frame(frame('delta', attempt='b', sequence=2, revision=6, index=0, text='new'))
            feed.frame(frame('start', attempt='a', revision=1))
            self.assertEqual(feed.read()[0]['answer']['text'], 'new')
            feed.update(status='failed')
            self.assertIsNone(feed.read()[0]['answer'])

    def test_replay_gap_and_refresh_snapshot(self):
        feed = self.feed(capacity=2)
        feed.frame(frame('start'))
        feed.frame(frame('delta', sequence=2, revision=2, index=0, text='a'))
        feed.frame(frame('delta', sequence=3, revision=3, index=1, text='b'))
        self.assertEqual([x['id'] for x in feed.read(1, 0)], [2, 3])
        self.assertEqual(feed.read(0, 0)[0]['type'], 'snapshot')
        self.assertEqual(feed.read()[0]['answer']['text'], 'ab')
        self.assertEqual(feed.read(3, 0), [])
        feed.frame(frame('delta', sequence=5, revision=4, index=2, text='gap'))
        self.assertIsNone(feed.read()[0]['answer'])

    def test_reasoning_is_separate_from_answer_and_committed_trace(self):
        feed = self.feed()
        feed.frame(frame('start', turn=1, step=1))
        feed.frame(frame('reasoning', sequence=2, revision=2, index=0, text='thinking '))
        feed.frame(frame('reasoning', sequence=3, revision=3, index=1, text='now'))
        self.assertEqual(feed.read()[0]['answer']['reasoning'], 'thinking now')
        delta = feed.read(2, 0)[0]
        self.assertEqual(delta['type'], 'reasoning.delta')
        self.assertNotIn('trace', delta)
        feed.frame(frame('end', sequence=4, revision=4, index=2,
                         outcome={'kind': 'committed', 'eventType': 'assistant/message', 'seq': 8},
                         settlement={'event_type': 'assistant/message', 'seq': 8,
                                     'text': 'answer', 'reasoning': 'canonical thought'}))
        self.assertEqual(feed.read()[0]['answer']['reasoning'], 'canonical thought')
        trace = []
        self.assertTrue(add_harness_event(trace, {'type': 'assistant/message', 'data': {
            'turn': 1, 'step': 1,
            'message': {'content': [{'type': 'text', 'text': 'answer'},
                                    {'type': 'reasoning', 'text': 'canonical thought'}]}}}))
        self.assertEqual(len(trace), 1)
        self.assertEqual(trace[0]['source'], 'reasoning')
        self.assertEqual(trace[0]['text'], 'canonical thought')
        self.assertNotIn('answer', str(trace))
        feed.update(status='completed')
        self.assertIsNone(feed.read()[0]['answer'])

    def test_reasoning_abandoned_attempt_is_withdrawn(self):
        feed = self.feed()
        feed.frame(frame('start'))
        feed.frame(frame('reasoning', sequence=2, revision=2, index=0, text='discard me'))
        feed.frame(frame('end', sequence=3, revision=3, index=1,
                         outcome={'kind': 'abandoned'}, settlement={}))
        self.assertIsNone(feed.read()[0]['answer'])
        feed.frame(frame('start', attempt='b', revision=4))
        self.assertEqual(feed.read()[0]['answer']['reasoning'], '')

    def test_loopback_auth_and_run_binding(self):
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
            bridge = StreamBridge(Path(folder))
            received = []
            try:
                bridge.bind('session', received.append)
                address = bridge.environment()['SATGPT_STREAM_ENDPOINT']
                def post(events, token):
                    request = urllib.request.Request(address, data=json.dumps(events).encode(),
                        headers={'Authorization': f'Bearer {token}'}, method='POST')
                    # Explicitly ignore ambient proxies for this local channel.
                    return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=2)
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    post([], 'wrong')
                self.assertEqual(caught.exception.code, 403)
                with post([{'session_id': 'other', 'run_id': bridge.binding['run_id']}], bridge.token): pass
                self.assertEqual(received, [])
                event = {**bridge.binding, 'type': 'drained'}
                with post([event], bridge.token): pass
                self.assertTrue(bridge.drained.is_set())
                self.assertEqual(received, [event])
                bridge.unbind()
                with post([event], bridge.token): pass
                self.assertEqual(len(received), 1)
            finally:
                bridge.close()

    def test_controller_exposes_draft_during_run_but_persists_only_final(self):
        arrived, release = threading.Event(), threading.Event()

        class LiveAgent:
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def run(self, prompt, session_id, on_event, on_stream):
                on_stream(frame('start'))
                on_stream(frame('delta', sequence=2, revision=2, index=0, text='live prefix'))
                arrived.set()
                if not release.wait(3): raise TimeoutError('test did not release model')
                return 'authoritative final'

        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder, patch.dict('os.environ', {
            'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key',
        }):
            controller = TaskController(Path(folder), agent_factory=LiveAgent)
            try:
                job = controller.create('stream check', [100, 10, 101, 11])
                self.assertTrue(arrived.wait(2))
                self.assertEqual(controller.streams[job['id']].read()[0]['answer']['text'], 'live prefix')
                self.assertEqual([m['role'] for m in controller.conversation()['messages']], ['user'])
                self.assertNotIn('live prefix', controller.chat_file.read_text(encoding='utf-8'))
                release.set()
                controller.pool.shutdown(wait=True)
                self.assertEqual(controller.get(job['id'])['status'], 'completed')
                self.assertIsNone(controller.streams[job['id']].read()[0]['answer'])
                history = controller.conversation()['messages']
                self.assertEqual([m['content'] for m in history if m['role'] == 'assistant'], ['authoritative final'])
            finally:
                release.set()
                controller.close()


if __name__ == '__main__':
    unittest.main()
