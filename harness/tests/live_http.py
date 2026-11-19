"""Anonymous same-origin HTTP helpers for explicitly run live probes."""

import http.client
import json
import uuid
from http.cookies import SimpleCookie


class BrowserHttp:
    def __init__(self, port):
        self.port = port
        self.origin = f'http://127.0.0.1:{port}'
        self.cookie = None
        with self._connection() as connection:
            connection.request('GET', '/api/harness/session')
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError(f'Browser initialization returned HTTP {response.status}')
            cookie = SimpleCookie(response.headers['Set-Cookie'])
            self.cookie = 'satgpt_browser=' + cookie['satgpt_browser'].value
            response.read()

    def _connection(self):
        return ManagedConnection('127.0.0.1', self.port, timeout=180)

    def request(self, method, path, body=None, expected=None):
        if method == 'POST' and path == '/api/harness/tasks':
            body = {'request_id': uuid.uuid4().hex, **(body or {})}
        with self._connection() as connection:
            connection.request(method, path, json.dumps(body) if body is not None else None,
                               {'Origin': self.origin, 'Content-Type': 'application/json', 'Cookie': self.cookie})
            response = connection.getresponse()
            if (expected is not None and response.status != expected) or (
                expected is None and not 200 <= response.status < 300
            ):
                raise RuntimeError(f'Unexpected HTTP {response.status} from the test service')
            return json.loads(response.read())

    def stream(self, job_id, cursor=None):
        connection = self._connection()
        headers = {'Cookie': self.cookie, 'Origin': self.origin}
        if cursor is not None:
            headers['Last-Event-ID'] = str(cursor)
        try:
            connection.request('GET', f'/api/harness/tasks/{job_id}/events', headers=headers)
            response = connection.getresponse()
            if response.status != 200:
                raise RuntimeError(f'Task stream returned HTTP {response.status}')
            return connection, response
        except Exception:
            connection.close()
            raise


class ManagedConnection(http.client.HTTPConnection):
    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
