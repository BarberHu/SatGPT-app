import asyncio
import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from deepseek_harness.api import Session
from deepseek_harness.client import HarnessClient, HarnessConfig
from harness.app.agent import HarnessAgent
from harness.app.controller import TaskController


class CancellationTests(unittest.TestCase):
    def test_agent_stop_closes_real_sdk_transport_and_unblocks_session_run(self):
        # A local protocol fixture holds a session open without calling a model.
        runtime = '''import json, sys
for line in sys.stdin:
    request = json.loads(line)
    if request['method'] == 'shutdown':
        print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': {}}), flush=True)
        break
    print(json.dumps({'jsonrpc': '2.0', 'id': request['id'], 'result': {'messageId': 'message'}}), flush=True)
    print(json.dumps({'jsonrpc': '2.0', 'method': 'session.event', 'params': {
        'sessionId': request['params']['sessionId'], 'event': {'type': 'agent/inbox/spliced',
        'data': {'inserted': [{'id': 'message'}]}}}}), flush=True)
'''
        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder:
            client = HarnessClient(HarnessConfig(shutdown_timeout_seconds=1),
                                   _launch_args=(sys.executable, '-u', '-c', runtime))
            client.start()
            process = client._proc
            agent = HarnessAgent(Path(folder), Path(folder), 'webgis-stop')
            agent.harness = SimpleNamespace(close=client.close)
            agent.session = Session(SimpleNamespace(client=client), 'webgis-stop')
            bridge = Mock()
            agent.bridge = bridge
            arrived = threading.Event()
            errors = []
            def run():
                try:
                    agent.run('hold open', 'webgis-stop', on_event=lambda _: arrived.set())
                except Exception as exc:
                    errors.append(exc)
            thread = threading.Thread(target=run)
            thread.start()
            try:
                self.assertTrue(arrived.wait(3))
                self.assertTrue(thread.is_alive())
                agent.cancel()
                thread.join(3)
                self.assertFalse(thread.is_alive())
                self.assertIsNotNone(process.poll())
                self.assertTrue(errors, 'closing the runtime must interrupt the SDK notification wait')
                self.assertIsNone(agent.session)
                bridge.close.assert_called_once()
                agent.cancel()
                bridge.close.assert_called_once()
            finally:
                client.close()
                thread.join(3)
                process.stdout.close()
                process.stderr.close()

    def test_http_stop_and_stream_terminal_snapshot_preserve_conversation_scope(self):
        from satgpt_backend import app
        arrived, release = threading.Event(), threading.Event()
        class Agent:
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def cancel(self): release.set()
            def run(self, *_, **__): arrived.set(); release.wait(3); return 'late'

        async def request(method, path):
            messages = []
            sent = False
            async def receive():
                nonlocal sent
                if not sent:
                    sent = True
                    return {'type': 'http.request', 'body': b''}
                await asyncio.Event().wait()
            async def send(message): messages.append(message)
            scope = {'type': 'http', 'asgi': {'version': '3.0', 'spec_version': '2.4'},
                     'http_version': '1.1', 'method': method, 'path': path, 'raw_path': path.encode(),
                     'query_string': b'', 'headers': [], 'scheme': 'http',
                     'client': ('127.0.0.1', 1234), 'server': ('localhost', 80)}
            await asyncio.wait_for(app(scope, receive, send), timeout=3)
            return messages[0]['status'], b''.join(m.get('body', b'') for m in messages[1:]).decode()

        with tempfile.TemporaryDirectory(dir=Path.cwd()) as folder, patch.dict('os.environ', {
            'DSH_PROVIDER': 'deepseek-official', 'DEEPSEEK_API_KEY': 'test-only-key',
        }):
            controller = TaskController(Path(folder), agent_factory=Agent)
            app.state.controller = controller
            try:
                first = controller.conversation()['conversation_id']
                job = controller.create('stop via http', [100, 10, 101, 11])
                self.assertTrue(arrived.wait(2))
                status, body = asyncio.run(request('POST', '/api/harness/conversation/new'))
                self.assertEqual(status, 200)
                second = json.loads(body)['conversation_id']
                status, body = asyncio.run(request('POST', f"/api/harness/tasks/{job['id']}/cancel"))
                self.assertEqual(status, 200)
                self.assertEqual(json.loads(body)['status'], 'cancelled')
                status, body = asyncio.run(request('GET', f'/api/harness/conversations/{first}'))
                self.assertEqual(status, 200)
                self.assertIsNone(json.loads(body)['active_task'])
                self.assertEqual(json.loads(body)['messages'][-1]['status'], 'cancelled')
                self.assertEqual(controller.conversation()['conversation_id'], second)
                self.assertEqual(controller.conversation()['messages'], [])
                status, body = asyncio.run(request('GET', f"/api/harness/tasks/{job['id']}/events"))
                self.assertEqual(status, 200)
                events = [json.loads(line[6:]) for line in body.splitlines() if line.startswith('data: ')]
                self.assertEqual(events[-1]['task']['status'], 'cancelled')
                self.assertIsNone(events[-1]['answer'])
                status, _ = asyncio.run(request('POST', '/api/harness/tasks/missing/cancel'))
                self.assertEqual(status, 404)
            finally:
                release.set()
                controller.close()
                del app.state.controller
