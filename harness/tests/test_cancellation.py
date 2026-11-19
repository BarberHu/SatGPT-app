
import json
import os
import tempfile
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import TaskController
from harness.tests.runtime_fixture import client_for, new_chat, task_body, wait_for_task


def emit(handler, body, tool_args=None):
    events = [{"type":"message_start","message":{"id":"msg_satgpt_probe","model":"smoke-model","usage":{"input_tokens":3,"output_tokens":0}}}]
    if tool_args is None:
        block, delta = {"type":"text","text":""}, {"type":"text_delta","text":body}
    else:
        block = {"type":"tool_use","id":"test_tool","name":"gee_check","input":{}}
        delta = {"type":"input_json_delta","partial_json":json.dumps(tool_args)}
    events.extend([
        {"type":"content_block_start","index":0,"content_block":block},
        {"type":"content_block_delta","index":0,"delta":delta},
    ])
    events.extend([
        {"type":"content_block_stop","index":0},
        {"type":"message_delta","delta":{"stop_reason":"tool_use" if tool_args else "end_turn"},"usage":{"output_tokens":3}},
        {"type":"message_stop"}
    ])
    for event in events:
        handler.wfile.write(f"event: {event['type']}\ndata: {json.dumps(event)}\n\n".encode())



class NativeCancellationTests(unittest.TestCase):
    def test_one_runtime_routes_native_runs_and_stops_only_target(self):
        arrived = threading.Barrier(3)
        release = threading.Event()
        offered_tools = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle(self):
                try:
                    super().handle()
                except ConnectionError:
                    pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
                presented = {tool['name'] for tool in data['tools']}
                offered_tools.append(presented)
                body = json.dumps(data['messages'])
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                if 'NATIVE_HOLD' in body:
                    try:
                        arrived.wait(10)
                        release.wait(10)
                    except threading.BrokenBarrierError:
                        return
                emit(self, 'offline native runtime result')

        model = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'DSH_PROVIDER':'deepseek-official', 'DSH_MODEL':'smoke-model',
            'DSH_REASONING_EFFORT':'default', 'DEEPSEEK_API_KEY':'local-fixture-key',
            'DEEPSEEK_BASE_URL':f'http://127.0.0.1:{model.server_port}',
        }):
            root = Path(__file__).resolve().parents[1]
            controller = TaskController(root, state=Path(directory))
            try:
                a, b = (client_for(controller) for _ in range(2))
                ca, cb = new_chat(a), new_chat(b)
                ta = a.post('/api/harness/tasks', json=task_body(ca, 'NATIVE_HOLD_A')).json()['id']
                tb = b.post('/api/harness/tasks', json=task_body(cb, 'NATIVE_HOLD_B')).json()['id']
                arrived.wait(10)
                self.assertEqual(len(offered_tools), 2)
                self.assertEqual(offered_tools[0], {'gee_check','gee_eval','gee_layer','gee_preview','gee_status','gee_catalog'})
                self.assertEqual(b.post(f'/api/harness/tasks/{ta}/cancel').status_code, 404)
                a.post(f'/api/harness/tasks/{ta}/cancel').raise_for_status()
                self.assertEqual(wait_for_task(a, ta)['status'], 'cancelled')
                self.assertEqual(b.get(f'/api/harness/tasks/{tb}').json()['status'], 'running')
                release.set()
                self.assertEqual(wait_for_task(b, tb)['status'], 'completed')
                self.assertIn('offline native runtime result', b.get(f'/api/harness/tasks/{tb}/events').text)
                self.assertEqual(len(controller.runtime.sessions), 2)
            finally:
                release.set()
                controller.close()

    def test_native_cancel_while_two_worker_calls_are_in_flight(self):
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def handle(self):
                try:
                    super().handle()
                except ConnectionError:
                    pass

            def do_POST(self):
                data = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                last = json.dumps(data['messages'][-1])
                self.send_response(200)
                self.send_header('Content-Type', 'text/event-stream')
                self.end_headers()
                if '"type": "tool_result"' in last:
                    emit(self, 'worker result verified')
                else:
                    marker = 'a' if 'WORKER_HOLD_A' in last else 'b'
                    emit(self, '', {'code': f'result = 1 # {marker}'})

        model = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=model.serve_forever, daemon=True).start()
        self.addCleanup(model.server_close)
        self.addCleanup(model.shutdown)
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            'DSH_PROVIDER':'deepseek-official', 'DSH_MODEL':'smoke-model',
            'DSH_REASONING_EFFORT':'default', 'DEEPSEEK_API_KEY':'local-fixture-key',
            'DEEPSEEK_BASE_URL':f'http://127.0.0.1:{model.server_port}', 'SATGPT_GEE_WORKERS':'2',
        }):
            root = Path(directory)
            worker = root/'app'/'gee_worker.py'
            worker.parent.mkdir()
            worker.write_text("""import json, os, sys, time
from pathlib import Path
root = Path(__file__).parent
for line in sys.stdin:
    request = json.loads(line)
    marker = request['payload']['code'][-1]
    (root / marker).write_text(str(os.getpid()))
    while not (root / 'release').exists():
        time.sleep(0.01)
    print(json.dumps({'id':request['id'],'ok':True,'data':{'valid':True,'errors':[],'warnings':[]}}), flush=True)
""")
            controller = TaskController(root, state=root/'state')
            try:
                a, b = (client_for(controller) for _ in range(2))
                ta = a.post('/api/harness/tasks', json=task_body(new_chat(a), 'WORKER_HOLD_A')).json()['id']
                tb = b.post('/api/harness/tasks', json=task_body(new_chat(b), 'WORKER_HOLD_B')).json()['id']
                limit = time.monotonic() + 8
                while time.monotonic() < limit and not all((worker.parent / marker).is_file() for marker in ('a','b')):
                    time.sleep(.02)
                self.assertNotEqual((worker.parent/'a').read_text(), (worker.parent/'b').read_text())
                a.post(f'/api/harness/tasks/{ta}/cancel').raise_for_status()
                self.assertEqual(wait_for_task(a, ta)['status'], 'cancelled')
                self.assertEqual(b.get(f'/api/harness/tasks/{tb}').json()['status'], 'running')
                (worker.parent/'release').touch()
                result = wait_for_task(b, tb)
                self.assertEqual(result['status'], 'completed')
                self.assertTrue(any(row.get('name') == 'gee_check' and row['status'] == 'done'
                                    for row in result['trace']))
                self.assertIn('worker result verified', b.get(f'/api/harness/tasks/{tb}/events').text)
            finally:
                (worker.parent/'release').touch()
                controller.close()
