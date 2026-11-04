import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import TaskController


class ConversationTests(unittest.TestCase):
    def wait(self, controller, job):
        current = job
        while current['status'] not in {'completed', 'failed'}:
            current = controller.wait_for_job(current['id'], current['revision'], 3)
        self.assertEqual(current['status'], 'completed', current['error'])

    def test_archive_restore_continue_and_restart_keep_session_identity(self):
        calls, opened, closed = [], [], []
        class Agent:
            def __init__(self, workspace, home, session_id): self.id = session_id
            def __enter__(self): opened.append(self.id); return self
            def __exit__(self, *_): closed.append(self.id)
            def run(self, prompt, session_id, **_):
                if self.id != session_id: raise AssertionError('wrong DSH session')
                calls.append(session_id)
                return f'reply {calls.count(session_id)}'

        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder, patch.dict('os.environ', {
            'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key',
        }):
            root = Path(folder)
            controller = TaskController(root, agent_factory=Agent)
            try:
                first = controller.conversation()['conversation_id']
                self.wait(controller, controller.create('first conversation', [100, 10, 101, 11], first))
                second = controller.new_conversation()['conversation_id']
                self.wait(controller, controller.create('second conversation', [100, 10, 101, 11], second))
                items = controller.list_conversations()
                self.assertEqual({item['id'] for item in items}, {first, second})
                self.assertEqual(next(item['title'] for item in items if item['id'] == first), 'first conversation')
                restored = controller.activate_conversation(first)
                self.assertEqual(restored['conversation_id'], first)
                self.assertEqual(restored['messages'][0]['content'], 'first conversation')
                with self.assertRaises(RuntimeError):
                    controller.create('stale send', [100, 10, 101, 11], second)
                self.wait(controller, controller.create('continue first', [100, 10, 101, 11], first))
                self.assertEqual(controller.conversation()['messages'][-1]['content'], 'reply 2')
                self.assertEqual(opened, [first, second, first])
                self.assertEqual(closed, [first, second])
                with self.assertRaises(ValueError): controller.activate_conversation('../secret')
                with self.assertRaises(FileNotFoundError): controller.activate_conversation('webgis-missing')
            finally:
                controller.close()
            restarted = TaskController(root, agent_factory=Agent)
            try:
                self.assertEqual(restarted.conversation()['conversation_id'], first)
                self.assertEqual(restarted.conversation()['messages'][-1]['content'], 'reply 2')
                restored = restarted.activate_conversation(second)
                self.assertEqual(restored['messages'][0]['content'], 'second conversation')
                self.assertEqual(restored['messages'][-1]['content'], 'reply 1')
            finally:
                restarted.close()

    def test_switching_during_task_keeps_results_in_the_original_conversation(self):
        arrived, release = threading.Event(), threading.Event()
        class Agent:
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def run(self, *_, **__): arrived.set(); release.wait(3); return 'done'
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder, patch.dict('os.environ', {
            'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key',
        }):
            controller = TaskController(Path(folder), agent_factory=Agent)
            try:
                first = controller.conversation()['conversation_id']
                job = controller.create('running check', [100, 10, 101, 11])
                self.assertTrue(arrived.wait(2))
                second = controller.new_conversation()['conversation_id']
                listed = {item['id']: item for item in controller.list_conversations()}
                self.assertEqual(listed[first]['active_task'], job['id'])
                self.assertEqual(listed[first]['task_status'], 'running')
                self.assertEqual(listed[first]['latest_task'], {'id': job['id'], 'status': 'running'})
                self.assertIsNone(listed[second]['task_status'])
                self.assertNotEqual(first, second)
                self.assertEqual(controller.conversation()['messages'], [])
                self.assertEqual(controller.activate_conversation(first)['active_task'], job['id'])
                controller.activate_conversation(second)
                release.set()
                self.wait(controller, controller.get(job['id']))
                self.assertEqual(controller.conversation()['messages'], [])
                saved = controller.conversation(first)
                self.assertIsNone(saved['active_task'])
                self.assertTrue(all(item['task_status'] is None for item in controller.list_conversations()))
                self.assertEqual(next(item['latest_task'] for item in controller.list_conversations() if item['id'] == first),
                                 {'id': job['id'], 'status': 'completed'})
                self.assertEqual([m['content'] for m in saved['messages']], ['running check', 'done'])
                self.assertEqual(controller.activate_conversation(first)['messages'], saved['messages'])
            finally:
                release.set()
                controller.close()

    def test_stop_running_and_queued_tasks_is_idempotent_and_allows_followup(self):
        arrived, release = threading.Event(), threading.Event()
        calls, cancelled = [], []
        class Agent:
            def __init__(self, _, __, session_id): self.id = session_id
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def cancel(self): cancelled.append(self.id); release.set()
            def run(self, *_, on_stream, **__):
                calls.append(self.id)
                if len(calls) == 1:
                    on_stream({'type': 'start', 'run_id': 'run', 'attempt_id': 'a', 'sequence': 1, 'revision': 1})
                    arrived.set()
                    release.wait(3)
                    on_stream({'type': 'delta', 'run_id': 'run', 'attempt_id': 'a', 'sequence': 2,
                               'revision': 2, 'index': 0, 'text': 'late text'})
                return 'late answer' if len(calls) == 1 else 'followup answer'

        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder, patch.dict('os.environ', {
            'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key',
        }):
            controller = TaskController(Path(folder), agent_factory=Agent)
            try:
                first = controller.conversation()['conversation_id']
                running = controller.create('stop this run', [100, 10, 101, 11])
                self.assertTrue(arrived.wait(2))
                with self.assertRaises(RuntimeError): controller.create('duplicate run', [100, 10, 101, 11])
                second = controller.new_conversation()['conversation_id']
                queued = controller.create('queued run', [100, 10, 101, 11])
                self.assertEqual(queued['status'], 'queued')
                listed = {item['id']: item for item in controller.list_conversations()}
                self.assertEqual(listed[first]['task_status'], 'running')
                self.assertEqual(listed[second]['task_status'], 'queued')
                self.assertEqual(controller.cancel(queued['id'])['status'], 'cancelled')
                self.assertIsNone(next(item['task_status'] for item in controller.list_conversations() if item['id'] == second))
                self.assertEqual(controller.cancel(running['id'])['status'], 'cancelled')
                self.assertEqual(controller.cancel(running['id'])['status'], 'cancelled')
                followup = controller.create('follow up', [100, 10, 101, 11])
                self.wait(controller, followup)
                self.assertEqual(calls, [first, second])
                self.assertEqual(cancelled, [first])
                self.assertEqual(controller.get(running['id'])['status'], 'cancelled')
                stream = controller.streams[running['id']]
                self.assertTrue(stream.terminal)
                self.assertIsNone(stream.read()[0]['answer'])
                stream.update(status='completed', output={'message': 'late overwrite'})
                self.assertEqual(stream.read()[0]['task']['status'], 'cancelled')
                first_messages = controller.conversation(first)['messages']
                self.assertEqual(len(first_messages), 2)
                self.assertEqual(first_messages[-1]['status'], 'cancelled')
                self.assertNotIn('late answer', str(first_messages))
                second_messages = controller.conversation()['messages']
                self.assertEqual([m.get('status') for m in second_messages if m['role'] == 'assistant'], ['cancelled', 'completed'])
                completed = controller.get(followup['id'])
                self.assertEqual(controller.cancel(followup['id']), completed)
                with self.assertRaises(FileNotFoundError): controller.cancel('missing')
            finally:
                release.set()
                controller.close()

    def test_stop_during_initialization_never_sends_a_prompt(self):
        initializing, release = threading.Event(), threading.Event()
        calls = []
        class Agent:
            def __init__(self, *_): pass
            def __enter__(self): initializing.set(); release.wait(3); return self
            def __exit__(self, *_): pass
            def cancel(self): release.set()
            def run(self, *_, **__): calls.append('prompt'); return 'unexpected'
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder, patch.dict('os.environ', {
            'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key',
        }):
            controller = TaskController(Path(folder), agent_factory=Agent)
            try:
                job = controller.create('stop startup', [100, 10, 101, 11])
                self.assertTrue(initializing.wait(2))
                self.assertEqual(controller.cancel(job['id'])['status'], 'cancelled')
            finally:
                release.set()
                controller.close()
            self.assertEqual(calls, [])
