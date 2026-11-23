"""Google web authorization. Only this trusted backend handles refresh tokens."""
import hashlib
import base64
import secrets
import threading
import time

import requests
from google.auth.transport.requests import Request as GoogleRequest
from google.oauth2 import id_token
from requests_oauthlib import OAuth2Session

from .settings import PersonalError

IDENTITY = ['openid', 'email', 'profile']
EE_READ = 'https://www.googleapis.com/auth/earthengine.readonly'
EE_WRITE = 'https://www.googleapis.com/auth/earthengine'
STORAGE = 'https://www.googleapis.com/auth/devstorage.read_write'


class GoogleOAuth:
    def __init__(self, settings, store):
        self.settings, self.store = settings, store
        self.lock = threading.RLock()

    def start(self, browser, owner, purpose):
        if not self.settings.client_id:
            raise PersonalError(503, 'Configure the application Desktop OAuth client in Local application first.')
        if purpose not in {'login', 'gee', 'upload'} or (purpose != 'login' and not owner):
            raise PersonalError(400, 'Sign in before granting data access.')
        verifier, nonce = secrets.token_urlsafe(64), secrets.token_urlsafe(32)
        state = self.store.flow(browser, owner, purpose, verifier, nonce)
        # Desktop clients re-authorize the complete scope set; they do not support
        # web-style incremental authorization. Keep upload rights when reconnecting.
        scopes = IDENTITY + ([EE_READ, EE_WRITE, STORAGE] if purpose == 'upload' else [EE_READ])
        if self.settings.local and owner:
            connection = self.store.connection(owner, token=True)
            granted = (connection or {}).get('token', {}).get('scope', [])
            granted = granted.split() if isinstance(granted, str) else granted
            scopes = list(dict.fromkeys(scopes + [s for s in (EE_WRITE, STORAGE) if s in granted]))
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b'=').decode()
        client = OAuth2Session(self.settings.client_id, redirect_uri=self.settings.callback, scope=scopes, state=state)
        extra = {} if self.settings.local else {'include_granted_scopes': 'true'}
        url, _ = client.authorization_url('https://accounts.google.com/o/oauth2/v2/auth',
            access_type='offline', **extra, nonce=nonce,
            prompt='select_account consent', code_challenge=challenge, code_challenge_method='S256')
        return url

    def finish(self, state, browser, code, session_owner=None):
        flow = self.store.consume_flow(state, browser)
        if flow['owner'] and flow['owner'] != session_owner:
            raise PersonalError(400, 'The signed-in workspace changed. Start authorization again.')
        try:
            client = OAuth2Session(self.settings.client_id, redirect_uri=self.settings.callback)
            token = client.fetch_token('https://oauth2.googleapis.com/token', code=code,
                client_secret=self.settings.client_secret, code_verifier=flow['verifier'],
                include_client_id=True, timeout=30)
            claims = id_token.verify_oauth2_token(token.get('id_token', ''), GoogleRequest(), self.settings.client_id)
            if not claims.get('sub') or not secrets.compare_digest(claims.get('nonce', ''), flow['nonce']):
                raise ValueError('Invalid nonce')
        except Exception as exc:
            raise PersonalError(400, 'Google authorization could not be verified. Start again.') from exc
        owner = self.store.user(claims)
        if flow['owner'] and owner != flow['owner']:
            raise PersonalError(400, 'Use the same Google account as this workspace.')
        token.pop('id_token', None)
        if not token.get('scope'):
            # Never infer granted EE/upload permissions from requested permissions.
            token['scope'] = IDENTITY if flow['purpose'] == 'login' else []
        self.store.save_token(owner, token)
        return self.store.new_session(owner)

    def token(self, owner, scopes=()):
        with self.lock:
            conn = self.store.connection(owner, token=True)
            if not conn or not conn['active']:
                raise PersonalError(401, 'Reconnect your Earth Engine account.')
            token = conn['token']
            granted = token.get('scope') or []
            granted = set(granted.split() if isinstance(granted, str) else granted)
            for scope in scopes:
                if scope not in granted and not (scope == EE_READ and EE_WRITE in granted):
                    raise PersonalError(403, 'Additional Google authorization is required for this action.')
            if token.get('expires_at', 0) < time.time() + 180:
                if not token.get('refresh_token'):
                    raise PersonalError(401, 'Reconnect Google to renew access.')
                try:
                    response = requests.post('https://oauth2.googleapis.com/token', data={
                        'client_id': self.settings.client_id, 'client_secret': self.settings.client_secret,
                        'refresh_token': token['refresh_token'], 'grant_type': 'refresh_token'}, timeout=30)
                    if response.status_code != 200:
                        raise ValueError('Refresh refused')
                    fresh = response.json()
                    if not isinstance(fresh.get('access_token'), str) or not fresh['access_token']:
                        raise ValueError('Missing refreshed access token')
                    fresh['expires_at'] = time.time() + fresh.get('expires_in', 3600)
                    self.store.save_token(owner, fresh, expected_revision=conn['revision'])
                    token = {**token, **fresh}
                except Exception as exc:
                    raise PersonalError(401, 'Google access expired or was revoked. Reconnect your account.') from exc
            return token['access_token']

    def revoke(self, owner):
        conn = self.store.connection(owner, token=True)
        if conn and conn['token']:
            token = conn['token'].get('refresh_token') or conn['token'].get('access_token')
            try:
                response = requests.post('https://oauth2.googleapis.com/revoke', data={'token': token}, timeout=30)
                if response.status_code not in {200, 400}:
                    raise ValueError('Revocation unavailable')
            except Exception as exc:
                raise PersonalError(503, 'Google could not confirm revocation. Retry or revoke access in your Google account.') from exc
