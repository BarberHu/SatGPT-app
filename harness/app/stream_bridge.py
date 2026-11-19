"""Per-run binding and authenticated loopback delivery of transient SDK frames."""

from __future__ import annotations

import hmac
import json
import secrets
import tempfile
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable


@dataclass
class StreamBinding:
    run_id: str
    callback: Callable[[dict], None]
    drained: threading.Event = field(default_factory=threading.Event)


class StreamBridge:
    def __init__(self, home: Path):
        self.token = secrets.token_urlsafe(32)
        self.directory = Path(tempfile.mkdtemp(prefix='runs-', dir=home))
        self.lock = threading.Lock()
        self.bindings: dict[str, StreamBinding] = {}
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(3)

            def log_message(self, *_):
                pass

            def do_POST(self):
                if (self.path != '/frames' or self.client_address[0] != '127.0.0.1'
                        or not hmac.compare_digest(self.headers.get('Authorization', ''), f'Bearer {owner.token}')):
                    self.send_error(403)
                    return
                try:
                    length = int(self.headers.get('Content-Length', '0'))
                    if not 0 < length <= 1_000_000:
                        raise ValueError('invalid body size')
                    batch = json.loads(self.rfile.read(length))
                    if not isinstance(batch, list) or len(batch) > 64 or not all(isinstance(item, dict) for item in batch):
                        raise ValueError('invalid batch')
                    owner.receive(batch)
                except (ValueError, TypeError, KeyError, OSError):
                    self.send_error(400)
                    return
                self.send_response(204)
                self.end_headers()

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def environment(self):
        return {'SATGPT_STREAM_ENDPOINT': f'http://127.0.0.1:{self.server.server_port}/frames',
                'SATGPT_STREAM_TOKEN': self.token, 'SATGPT_RUN_BINDINGS': str(self.directory)}

    def bind(self, context, callback):
        session_id = context['session_id']
        binding = StreamBinding(context['run_id'], callback)
        with self.lock:
            if session_id in self.bindings:
                raise RuntimeError('Native session already has an active binding')
            target = self.directory / f'{session_id}.json'
            temporary = target.with_suffix('.tmp')
            temporary.write_text(json.dumps(context, allow_nan=False), encoding='utf-8')
            temporary.replace(target)
            self.bindings[session_id] = binding
        return binding

    def receive(self, batch):
        for frame in batch:
            session_id = frame.get('session_id')
            if not isinstance(session_id, str):
                continue
            with self.lock:
                binding = self.bindings.get(session_id)
            if binding is None or binding.run_id != frame.get('run_id'):
                continue
            if frame.get('type') == 'drained':
                binding.drained.set()
            else:
                binding.callback(frame)

    def unbind(self, session_id, run_id):
        with self.lock:
            binding = self.bindings.get(session_id)
            if binding is not None and binding.run_id == run_id:
                (self.directory / f'{session_id}.json').unlink(missing_ok=True)
                del self.bindings[session_id]

    def close(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
        with self.lock:
            self.bindings.clear()
        for target in self.directory.iterdir():
            target.unlink()
        self.directory.rmdir()
