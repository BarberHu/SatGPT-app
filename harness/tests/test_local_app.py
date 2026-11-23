import json
import os
from pathlib import Path
import sqlite3
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from fastapi.testclient import TestClient

from harness.app.local_runtime import LocalRuntime, WindowsCipher
from harness.app.local_migration import import_existing
from harness.app.local_app import create_app
from harness.app.personal.oauth import EE_READ, EE_WRITE, STORAGE
from harness.app.personal.settings import PersonalError
from harness.app.personal.routes import cookie_names
from harness.app import gee_worker


@unittest.skipUnless(os.name == 'nt', 'Windows DPAPI integration')
class LocalAppTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.path = Path(self.temp.name)
        self.env = patch.dict(os.environ, {'SATGPT_RUN_MODE': 'local',
            'GOOGLE_APPLICATION_CREDENTIALS': str(self.path / 'does-not-exist.json'),
            'GEE_PROJECT_ID': '', 'DEEPSEEK_API_KEY': '', 'AIHUBMIX_API_KEY': '',
            'GOOGLE_OAUTH_CLIENT_ID': '', 'GOOGLE_OAUTH_CLIENT_SECRET': ''})
        self.env.start(); self.addCleanup(self.env.stop)
        self.runtime = LocalRuntime(self.path / 'local', origin='http://127.0.0.1:3314')
        build = self.path / 'build'; build.mkdir(); (build / 'index.html').write_text('<h1>Local UI</h1>')
        self.app = create_app(self.runtime, build)
        self.client = self.enterContext(TestClient(self.app, base_url=self.runtime.origin))
        self.client.get('/api/personal/status')
        self.headers = {'Origin': self.runtime.origin,
            'X-SatGPT-Local-CSRF': self.client.get('/api/personal/status').headers['X-SatGPT-Local-CSRF']}

    def login(self):
        service = self.app.state.personal
        owner = service.store.user({'sub': 'local-test-owner'})
        service.store.save_token(owner, {'access_token': 'test-user-access', 'refresh_token': 'test-user-refresh',
            'scope': [EE_READ, EE_WRITE, STORAGE], 'expires_at': time.time() + 3600})
        service.store.configure(owner, 'test-project', '')
        raw = service.store.new_session(owner)
        self.client.cookies.set(cookie_names(service.settings)[0], raw, domain='127.0.0.1', path='/')
        self.headers['X-SatGPT-CSRF'] = service.store.session(raw)['csrf']
        return service, owner

    def test_no_admin_or_model_credentials_startup_and_local_ui(self):
        self.client.cookies.set('satgpt_session', 'legacy-session-untouched', domain='127.0.0.1', path='/')
        self.assertEqual(self.client.get('/readyz').status_code, 200)
        self.assertIn('Local UI', self.client.get('/').text)
        status = self.client.get('/api/personal/status').json()
        self.assertEqual(status['local']['mode'], 'local')
        self.assertFalse(status['login_available']); self.assertFalse(status['local']['model_configured'])
        self.assertEqual(self.client.get('/api/personal/oauth/start').status_code, 503)
        self.assertEqual(self.client.post('/api/harness/tasks', json={'prompt': 'Analyze', 'bounds': [0,0,1,1]}, headers=self.headers).status_code, 401)
        self.assertEqual(self.client.get('/api/layers').status_code, 503)
        self.assertTrue(self.app.state.controller.state_dir.is_relative_to(self.runtime.root))
        self.client.post('/api/personal/logout', headers=self.headers)
        self.assertEqual(self.client.cookies.get('satgpt_session'), 'legacy-session-untouched')

    def test_host_origin_cross_site_and_csrf_are_checked_before_configuration(self):
        for headers in ({'Host': 'evil.example'}, {'Origin': 'https://evil.example'}, {'Sec-Fetch-Site': 'cross-site'}):
            self.assertEqual(self.client.get('/api/local/config', headers=headers).status_code, 403)
        self.assertEqual(self.client.put('/api/local/model', json={}).status_code, 403)
        # Even the OAuth callback cannot bypass Host validation.
        self.assertEqual(self.client.get('/api/personal/oauth/callback', headers={'Host': 'evil.example'}).status_code, 403)

    def test_model_key_is_dpapi_protected_and_not_returned(self):
        secret = 'local-test-model-secret-12345'
        response = self.client.put('/api/local/model', headers=self.headers,
            json={'provider': 'deepseek-official', 'model': 'test-model', 'api_key': secret})
        self.assertEqual(response.status_code, 200); self.assertNotIn(secret, response.text)
        self.assertNotIn(secret.encode(), self.runtime.file.read_bytes())
        reopened = LocalRuntime(self.runtime.root, self.runtime.origin)
        self.assertEqual(reopened.model_environment()['DEEPSEEK_API_KEY'], secret)
        cipher = WindowsCipher(); protected = cipher.encrypt(secret.encode())
        with self.assertRaises(Exception): cipher.decrypt(protected[:-4] + b'AAAA')

    def test_second_instance_and_validation_echo_are_blocked(self):
        second = LocalRuntime(self.runtime.root, self.runtime.origin)
        with self.assertRaisesRegex(ValueError, 'already in use'): second.acquire()
        secret = 'private-model-key-' * 300
        response = self.client.put('/api/local/model', headers=self.headers,
            json={'provider':'deepseek-official','model':'test','api_key':secret})
        self.assertEqual(response.status_code, 422)
        self.assertNotIn('private-model-key', response.text)

    def test_desktop_oauth_pkce_reauthorization_and_callback(self):
        response = self.client.put('/api/local/oauth', headers=self.headers,
            json={'installed': {'client_id': 'local-test.apps.googleusercontent.com', 'client_secret': 'public-desktop-field'}})
        self.assertEqual(response.status_code, 200)
        response = self.client.get('/api/personal/oauth/start', follow_redirects=False)
        query = parse_qs(urlsplit(response.headers['location']).query)
        self.assertEqual(query['redirect_uri'], [self.runtime.origin + '/api/personal/oauth/callback'])
        self.assertEqual(query['code_challenge_method'], ['S256']); self.assertNotIn('include_granted_scopes', query)
        claims = {'sub': 'native-user', 'nonce': query['nonce'][0]}
        with patch('harness.app.personal.oauth.OAuth2Session.fetch_token', return_value={
            'access_token': 'native-access', 'refresh_token': 'native-refresh', 'scope': [EE_READ], 'id_token': 'test-id', 'expires_at': time.time()+3600}), \
             patch('harness.app.personal.oauth.id_token.verify_oauth2_token', return_value=claims):
            callback = self.client.get('/api/personal/oauth/callback', params={'state': query['state'][0], 'code': 'test-code'},
                headers={'Sec-Fetch-Site': 'cross-site'}, follow_redirects=False)
        self.assertEqual(callback.status_code, 303)
        self.assertEqual(callback.headers['location'], self.runtime.origin + '/?google=connected')
        status = self.client.get('/api/personal/status').json(); self.assertIsNotNone(status['user'])
        self.assertTrue(status['connection']['readable'])
        connection = self.app.state.personal.store.connection(status['user']['owner'], token=True)
        self.assertEqual(connection['token']['refresh_token'], 'native-refresh')
        with self.app.state.personal.store.lock:
            blob = self.app.state.personal.store.db.execute('SELECT token FROM connections').fetchone()[0]
        self.assertTrue(blob.startswith('dpapi:v1:')); self.assertNotIn('native-refresh', blob)
        denied = self.client.get('/api/personal/oauth/callback?state=used&error=access_denied', follow_redirects=False)
        self.assertIn('google=failed', denied.headers['location'])

    def test_no_system_fallback_and_legacy_replay(self):
        service, owner = self.login()
        service.store.disconnect(owner)
        response = self.client.post('/api/harness/tasks', headers=self.headers, json={'prompt': 'Analyze public data', 'bounds': [0,0,1,1]})
        self.assertEqual(response.status_code, 409)
        with patch('harness.app.gee_worker.personal_credentials', return_value=None), patch('google.auth.default') as adc:
            with self.assertRaisesRegex(ValueError, 'OAuth'): gee_worker.earth_engine('test-project')
            adc.assert_not_called()
        with self.assertRaisesRegex(ValueError, 'read-only'):
            service.controller(owner).prepare_payload({'analysis_context': {'execution': {'mode': 'system'}}}, replay=True)

    def test_task_api_captures_current_user_identity_and_model_snapshot(self):
        service, owner = self.login()
        self.runtime.configure_model('deepseek-official', 'test-model', 'test-model-key')
        with patch.object(service.cloud, 'verify'), patch.object(service.controller(owner), 'create', return_value={'id':'accepted'}) as create:
            response = self.client.post('/api/harness/tasks', headers=self.headers,
                json={'prompt':'Analyze public data', 'bounds':[0,0,1,1]})
        self.assertEqual(response.status_code, 202)
        execution = create.call_args.kwargs['execution']
        self.assertEqual(execution['mode'], 'personal'); self.assertEqual(execution['owner'], owner)
        self.assertEqual(execution['project'], 'test-project')

    def test_local_agent_execution_separates_model_key_and_redacts_failure(self):
        service, owner = self.login()
        secret = 'local-model-key-redaction-test'
        self.runtime.configure_model('deepseek-official', 'test-model', secret)
        captured = {}
        class Agent:
            runtime_environment = {}
            def __init__(self, *_args): pass
            def __enter__(self):
                captured['worker'] = dict(self.runtime_environment)
                captured['model'] = dict(self.model_environment)
                return self
            def __exit__(self, *_args): pass
            def run(self, *_args, **_kwargs): raise RuntimeError('Provider failure: ' + secret)
        controller = service.controller(owner); controller.agent_factory = Agent
        with patch.object(service.cloud, 'verify'):
            response = self.client.post('/api/harness/tasks', headers=self.headers,
                json={'prompt':'Analyze public data', 'bounds':[0,0,1,1]})
            self.assertEqual(response.status_code, 202)
            job = response.json()
            deadline = time.monotonic() + 5
            while job['status'] not in {'failed', 'completed'} and time.monotonic() < deadline:
                job = controller.wait_for_job(job['id'], job['revision'], 0.2)
        self.assertEqual(job['status'], 'failed')
        self.assertEqual(captured['model']['DEEPSEEK_API_KEY'], secret)
        self.assertTrue(captured['worker']['SATGPT_GEE_LEASE'])
        self.assertNotIn(secret, json.dumps(captured['worker']))
        self.assertNotIn(secret, json.dumps(job))
        history = json.dumps(controller.conversation())
        self.assertNotIn(secret, history)
        self.assertNotIn(captured['worker']['SATGPT_GEE_LEASE'], history)

    def test_source_import_keeps_original_and_requires_fresh_google_consent(self):
        project = self.path / 'old-project'; state = project / 'harness' / 'state'
        state.mkdir(parents=True); (state / 'chat-history.json').write_text(json.dumps({'conversation_id':'webgis-old','messages':[{'role':'user','content':'kept history'}]}))
        personal = state / 'personal'; personal.mkdir()
        db = sqlite3.connect(personal/'personal.sqlite3')
        db.executescript("CREATE TABLE connections(owner,id,revision,active,project,bucket,token); CREATE TABLE sessions(x); CREATE TABLE flows(x); CREATE TABLE uploads(id,data);")
        db.execute('INSERT INTO connections VALUES(?,?,?,?,?,?,?)', ('owner','connection',1,1,'project','','old-encrypted-token'))
        payload = {'content_path': str(personal/'uploads'/'original.geojson')}
        db.execute('INSERT INTO uploads VALUES(?,?)', ('upload',json.dumps(payload))); db.commit(); db.close()
        target = LocalRuntime(self.path/'import-target', self.runtime.origin)
        original = (personal/'personal.sqlite3').read_bytes()
        import_existing(project, target)
        self.assertEqual(original, (personal/'personal.sqlite3').read_bytes())
        self.assertIn('kept history',(target.state_root/'legacy-system'/'chat-history.json').read_text())
        copied = sqlite3.connect(target.state_root/'personal'/'personal.sqlite3')
        self.addCleanup(copied.close)
        self.assertEqual(copied.execute('SELECT active,token FROM connections').fetchone(),(0,''))
        path = json.loads(copied.execute('SELECT data FROM uploads').fetchone()[0])['content_path']
        self.assertTrue(Path(path).is_relative_to(target.state_root))
        with self.assertRaises(ValueError): import_existing(project, target)


if __name__ == '__main__': unittest.main()
