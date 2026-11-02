"""Authenticated, per-runtime loopback channel for transient DSH frames."""

from __future__ import annotations

import hmac
import json
import secrets
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


class StreamBridge:
    def __init__(self, home: Path):
        self.token = secrets.token_urlsafe(32)
        self.binding_file = home / f"stream-binding-{uuid.uuid4().hex}.json"
        self.lock = threading.Lock()
        self.binding = None
        self.callback = None
        self.drained = threading.Event()
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def setup(self):
                super().setup()
                self.connection.settimeout(5)

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
                    if not isinstance(batch, list) or len(batch) > 64:
                        raise ValueError('invalid batch')
                    owner.receive(batch)
                except (ValueError, TypeError, KeyError):
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
                'SATGPT_STREAM_TOKEN': self.token, 'SATGPT_STREAM_BINDING': str(self.binding_file)}

    def bind(self, session_id, callback):
        with self.lock:
            self.binding = {'session_id': session_id, 'run_id': uuid.uuid4().hex}
            self.callback = callback
            self.drained.clear()
            temporary = self.binding_file.with_suffix('.tmp')
            temporary.write_text(json.dumps(self.binding), encoding='utf-8')
            temporary.replace(self.binding_file)

    def receive(self, batch):
        with self.lock:
            for frame in batch:
                if not isinstance(frame, dict):
                    raise ValueError('invalid frame')
                if not self.binding or any(frame.get(k) != v for k, v in self.binding.items()):
                    continue
                if frame.get('type') == 'start':
                    self.drained.clear()
                if self.callback:
                    self.callback(frame)
                if frame.get('type') == 'drained':
                    self.drained.set()

    def unbind(self):
        with self.lock:
            self.binding = self.callback = None
            self.binding_file.unlink(missing_ok=True)

    def close(self):
        self.unbind()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)
