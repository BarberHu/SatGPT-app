"""Loopback-only credential handoff. Capabilities never enter model tool arguments."""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import secrets
import threading
import time
from .settings import PersonalError


class CredentialBroker:
    def __init__(self, service):
        self.service, self.leases, self.lock = service, {}, threading.RLock()
        broker = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                if self.path != '/credentials' or self.client_address[0] != '127.0.0.1':
                    self.send_error(404); return
                raw = self.headers.get('Authorization', '')
                capability = raw[7:] if raw.startswith('Bearer ') else ''
                try:
                    data = broker.resolve(capability)
                except PersonalError:
                    self.send_error(401, 'Reconnect the original account.'); return
                body = json.dumps(data).encode()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Cache-Control', 'no-store')
                self.send_header('Content-Length', str(len(body)))
                self.end_headers(); self.wfile.write(body)

        self.server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        self.server.daemon_threads = True
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def lease(self, execution, preview_dir):
        raw = secrets.token_urlsafe(32)
        with self.lock:
            now = time.time()
            self.leases = {k: v for k, v in self.leases.items() if v['expires'] > now}
            for existing, value in self.leases.items():
                if all(value['execution'].get(k) == execution.get(k) for k in ('owner', 'connection_id', 'revision', 'project')) and value['preview_dir'] == str(preview_dir):
                    return {'SATGPT_GEE_BROKER': f'http://127.0.0.1:{self.server.server_port}/credentials', 'SATGPT_GEE_LEASE': existing}
            if len(self.leases) >= 128:
                raise PersonalError(429, 'Too many active personal executions. Retry later.')
            self.leases[raw] = {'execution': execution, 'preview_dir': str(preview_dir), 'expires': now + 86400}
        return {'SATGPT_GEE_BROKER': f'http://127.0.0.1:{self.server.server_port}/credentials', 'SATGPT_GEE_LEASE': raw}

    def resolve(self, raw):
        with self.lock:
            lease = self.leases.get(raw)
        if not lease or lease['expires'] < time.time():
            raise PersonalError(401, 'Execution authorization expired.')
        execution = lease['execution']
        self.service.validate_execution(execution)
        return {'access_token': self.service.oauth.token(execution['owner'],
                ('https://www.googleapis.com/auth/earthengine.readonly',)),
                'project': execution['project'], 'connection': execution['connection_id'],
                'revision': execution['revision'], 'preview_dir': lease['preview_dir']}

    def invalidate(self, owner):
        with self.lock:
            self.leases = {k: v for k, v in self.leases.items() if v['execution']['owner'] != owner}

    def close(self):
        self.server.shutdown(); self.server.server_close(); self.thread.join(timeout=2)
