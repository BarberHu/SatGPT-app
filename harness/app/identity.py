"""Issue and verify the browser identity used by the private HTTP routes."""

from __future__ import annotations

import hashlib
import hmac
import os
import re
import secrets
import time
from pathlib import Path

from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse

COOKIE = 'satgpt_browser'
MAX_AGE = 365 * 24 * 60 * 60


class BrowserIdentity:
    def __init__(self, state: Path):
        state.mkdir(parents=True, exist_ok=True)
        key = state / 'identity.key'
        if not key.exists():
            temp = state / f'.identity-{secrets.token_hex(8)}'
            try:
                with os.fdopen(os.open(temp, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), 'wb') as file:
                    file.write(secrets.token_bytes(32))
                    file.flush()
                    os.fsync(file.fileno())
                try:
                    os.link(temp, key)
                except FileExistsError:
                    pass
            finally:
                temp.unlink(missing_ok=True)
        self.key = key.read_bytes()
        if len(self.key) != 32:
            raise ValueError('Invalid browser identity signing key')

    def _sign(self, value):
        return hmac.new(self.key, value.encode('ascii'), hashlib.sha256).hexdigest()

    def issue(self):
        value = f'{secrets.token_hex(16)}.{int(time.time()) + MAX_AGE}'
        return f'{value}.{self._sign(value)}'

    def verify(self, token):
        if not token or not re.fullmatch(r'[0-9a-f]{32}\.[0-9]{1,12}\.[0-9a-f]{64}', token):
            return None
        value, signature = token.rsplit('.', 1)
        if not hmac.compare_digest(self._sign(value), signature):
            return None
        owner, expires = value.split('.')
        return owner if int(expires) > time.time() else None


def owner_for(request: Request):
    controller = getattr(request.app.state, 'controller', None)
    owner = controller.identity.verify(request.cookies.get(COOKIE)) if controller else None
    if owner is None:
        raise HTTPException(404, 'Resource not found')
    return owner


def session_response(request: Request):
    identity = request.app.state.controller.identity
    response = JSONResponse({'ready': True}, headers={'Cache-Control': 'private, no-store'})
    if not identity.verify(request.cookies.get(COOKIE)):
        # Uvicorn sets the scope scheme only for explicitly trusted proxy peers.
        secure = (request.url.scheme == 'https' or os.getenv('SATGPT_COOKIE_SECURE') == 'true'
                  or os.getenv('SATGPT_PUBLIC_ORIGIN', '').startswith('https://'))
        response.set_cookie(COOKIE, identity.issue(), max_age=MAX_AGE, httponly=True,
                            secure=secure, samesite='lax', path='/')
    return response


class PrivateRoutes:
    """Use the browser-visible Host and the server-validated ASGI scheme."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        path = scope.get('path', '')
        is_private = path.startswith(('/api/harness/', '/api/previews/', '/api/business-layers/'))
        if scope['type'] != 'http' or not is_private:
            return await self.app(scope, receive, send)
        request = Request(scope)
        method = request.method
        expected = os.getenv('SATGPT_PUBLIC_ORIGIN') or f'{request.url.scheme}://{request.headers.get("host", "")}'
        origin = request.headers.get('origin')
        cross_origin = request.headers.get('sec-fetch-site') in {'cross-site', 'same-site'}
        if cross_origin or (origin is not None and origin != expected) or (
            method not in {'GET', 'HEAD', 'OPTIONS'} and origin is None
        ):
            response = JSONResponse({'detail': 'Use the same-origin SatGPT gateway.'}, status_code=403)
            return await response(scope, receive, send)

        async def send_private(message):
            if message['type'] == 'http.response.start':
                message['headers'] = [(key, value) for key, value in message.get('headers', [])
                                      if key.lower() != b'cache-control']
                message['headers'].append((b'cache-control', b'private, no-store, no-transform'))
            await send(message)

        return await self.app(scope, receive, send_private)
