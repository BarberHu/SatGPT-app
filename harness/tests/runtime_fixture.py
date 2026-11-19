"""Deterministic application tests with a substitute for the native process."""

import copy
import threading
import time
import uuid
from types import SimpleNamespace

from fastapi import FastAPI
from fastapi.testclient import TestClient

from harness.app.identity import COOKIE, PrivateRoutes
from harness.app.server import router
from harness.app.session_store import TERMINAL
from harness.app.shared_runtime import RuntimeUnavailable


class SimulatedRuntime:
    provider = 'deepseek-official'
    default_reasoning_effort = 'high'
    reasoning = {'model': 'Test model',
                 'levels': [{'id': effort, 'name': effort.title()} for effort in ('off', 'low', 'high', 'max')],
                 'default_effort': 'high'}

    def __init__(self, root, home, workers, resident_limit, *, run=None, reload=None):
        self.available = threading.Event()
        self.bindings = {}
        self.sessions = {}
        self.callbacks = {}
        self.resident_limit = resident_limit
        self.run = run or (lambda **_: result())
        self.reload = reload
        self.bridge = self
        self.starts = 0
        self.opens = []

    def start(self):
        self.starts += 1
        self.available.set()

    def reasoning_options(self):
        if self.reasoning is None:
            raise RuntimeUnavailable('Reasoning capabilities are unavailable')
        return self.reasoning

    def close(self):
        self.available.clear()
        for signal in self.sessions.values():
            signal.set()
        self.sessions.clear()

    def full_for(self, native_id):
        return native_id not in self.sessions and len(self.sessions) >= self.resident_limit

    def reserve(self, native_id):
        self.sessions.setdefault(native_id, threading.Event())

    def open(self, native_id, *, resume):
        self.opens.append((native_id, resume))
        stop = self.sessions[native_id]
        stop.clear()

        def run(prompt, on_notification):
            on_notification(SimpleNamespace(method='session.event', payload={'sessionId': native_id, 'event': {}}))
            return self.run(prompt=prompt, ctx=self.bindings[native_id], frame=self.callbacks[native_id], stop=stop)

        return SimpleNamespace(run=run)

    def bind(self, ctx, callback):
        cid = ctx['session_id']
        self.bindings[cid] = copy.deepcopy(ctx)
        self.callbacks[cid] = callback
        drained = threading.Event()
        drained.set()
        return SimpleNamespace(drained=drained)

    def unbind(self, native_id, run_id):
        assert self.bindings[native_id]['run_id'] == run_id
        del self.bindings[native_id]
        del self.callbacks[native_id]

    def control(self, path, body, **_):
        if path == '/cancel':
            self.sessions[body['session_id']].set()
            return {'accepted': True}
        if path == '/reload':
            return {'layer': self.reload(body['payload'])}
        raise AssertionError(path)


def result(text='Offline result', *, ctx=None, artifacts=(), reason='completed'):
    events = []
    for seq, value in enumerate(artifacts, 1):
        events.append({'type': 'tool/result', 'seq': seq, 'data': {
            'message': {'toolCallId': 'call-' + str(seq)},
            'meta': {**value, 'task_id': ctx['task_id'], 'run_id': ctx['run_id']}}})
    return SimpleNamespace(final_response=text, finish_reason=reason, events=events)


def client_for(controller, *, app=None):
    if app is None:
        app = FastAPI()
        app.add_middleware(PrivateRoutes)
        app.include_router(router)
        app.state.controller = controller
    client = TestClient(app, headers={'Origin': 'http://testserver'})
    assert client.get('/api/harness/session').status_code == 200
    return client


def new_chat(client):
    """Seed a legacy conversation for tests of requests with an existing ID."""
    controller = client.app.state.controller
    owner = controller.identity.verify(client.cookies.get(COOKIE))
    assert owner
    with controller.store.connect(write=True) as db:
        return controller.store.new(db, owner)


def task_body(cid, prompt='Analyze the area', **extra):
    return {'prompt': prompt, 'bounds': [100, 10, 101, 11], 'conversation_id': cid,
            'request_id': uuid.uuid4().hex, **extra}


def wait_for_task(client, task_id, timeout=5):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        receipt = client.get(f'/api/harness/tasks/{task_id}').json()
        if receipt['status'] in TERMINAL:
            return receipt
        time.sleep(.01)
    raise AssertionError('Task did not settle: ' + receipt['status'])
