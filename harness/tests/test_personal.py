import copy
from dataclasses import replace
import json
from pathlib import Path
import tempfile
import time
import unittest
from urllib.parse import parse_qs, urlsplit
from unittest.mock import patch

from cryptography.fernet import Fernet
from fastapi import FastAPI
from fastapi.testclient import TestClient

from harness.app.controller import TaskController
from harness.app.server import router
from harness.app.personal.settings import Settings, PersonalError
from harness.app.personal.service import PersonalService
from harness.app.personal.routes import install
from harness.app.personal.oauth import IDENTITY, EE_READ, EE_WRITE, STORAGE
from harness.app.layer_generation import generation_recipe, replay_payload


class FakeCloud:
    def __init__(self):
        self.records = {'projects/test-project/assets/private': {'name': 'projects/test-project/assets/private', 'type': 'IMAGE', 'updateTime': '2026-01-01T00:00:00Z'}}
        self.operations, self.import_calls, self.cleaned = {}, [], []
        self.stage_hook = None

    def verify(self, owner, project):
        return True

    def asset(self, owner, name):
        if name not in self.records:
            raise PersonalError(404, 'Not found')
        return copy.deepcopy(self.records[name])

    def assets(self, owner, parent, page_token=''):
        return {'assets': list(self.records.values()), 'nextPageToken': ''}

    def stage(self, owner, upload, path):
        assert path.is_file()
        if self.stage_hook:
            self.stage_hook()

    def import_asset(self, owner, upload):
        self.import_calls.append(copy.deepcopy(upload))
        name = 'projects/test-project/operations/' + upload['id']
        self.operations.setdefault(name, {'name': name, 'done': False})
        return {'name': name}

    def find_import(self, owner, upload):
        return self.operations.get('projects/test-project/operations/' + upload['id'])

    def operation(self, owner, name, cancel=False):
        if cancel:
            self.operations[name] = {'name': name, 'done': True, 'error': {'code': 1}}
        return self.operations[name]

    def cleanup(self, owner, upload):
        self.cleaned.append(upload['object'])


class PersonalFixture(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.settings = Settings(True, 'test-client', 'test-client-secret', 'http://testserver',
                                 Fernet.generate_key().decode(), self.root / 'personal')
        self.guest = TaskController(self.root / 'harness')
        self.addCleanup(self.guest.close)
        self.cloud = FakeCloud()
        self.service = PersonalService(self.settings, self.root / 'harness', cloud=self.cloud,
                                       pool=self.guest.pool, start_uploads=False)
        self.addCleanup(self.service.close)
        self.first = self.make_user('first')
        self.second = self.make_user('second')
        app = FastAPI(); app.state.controller = self.guest; app.state.personal = self.service
        app.include_router(router); install(app)
        self.client = TestClient(app)

    def make_user(self, subject):
        owner = self.service.store.user({'sub': subject, 'email': subject + '@example.test', 'name': subject})
        self.service.store.save_token(owner, {'access_token': 'test-access-' + subject,
            'refresh_token': 'test-refresh-' + subject, 'scope': [EE_READ, EE_WRITE, STORAGE], 'expires_at': time.time() + 3600})
        self.service.configure(owner, 'test-project', 'existing-test-bucket')
        return owner

    def login(self, owner):
        raw = self.service.store.new_session(owner)
        self.client.cookies.clear(); self.client.cookies.set('satgpt_session', raw, domain='testserver.local', path='/')
        self.csrf = self.service.store.session(raw)['csrf']
        return {'X-SatGPT-CSRF': self.csrf, 'Origin': 'http://testserver'}


class PersonalTests(PersonalFixture):
    def test_normal_signin_requests_gee_read_access_and_defers_upload_scopes(self):
        response = self.client.get('/api/personal/oauth/start', follow_redirects=False)
        self.assertEqual(response.status_code, 303)
        query = parse_qs(urlsplit(response.headers['location']).query)
        scopes = set(query['scope'][0].split())
        self.assertTrue(set(IDENTITY + [EE_READ]) <= scopes)
        self.assertNotIn(EE_WRITE, scopes); self.assertNotIn(STORAGE, scopes)
        self.assertEqual(query['code_challenge_method'], ['S256'])
        self.assertTrue(query['nonce'][0])
        self.assertNotIn('client_secret', query)
        self.assertIn('HttpOnly', response.headers['set-cookie'])

    def test_partial_grant_creates_google_session_without_claiming_gee_connection(self):
        url = self.service.oauth.start('partial-browser', None, 'login')
        query = parse_qs(urlsplit(url).query)
        self.client.cookies.set('satgpt_oauth_browser', 'partial-browser', domain='testserver.local', path='/api/personal/oauth')
        token = {'access_token': 'partial-access', 'id_token': 'verified-test-id-token',
                 'scope': ['openid', 'email', 'profile'], 'expires_at': time.time() + 3600}
        with patch('harness.app.personal.oauth.OAuth2Session.fetch_token', return_value=token), \
             patch('harness.app.personal.oauth.id_token.verify_oauth2_token', return_value={'sub': 'partial-user', 'nonce': query['nonce'][0]}):
            result = self.client.get('/api/personal/oauth/callback', params={'state': query['state'][0], 'code': 'test-code'}, follow_redirects=False)
        self.assertEqual(result.status_code, 303)
        self.assertEqual(result.headers['location'], 'http://testserver/?google=connected')
        status = self.client.get('/api/personal/status').json()
        self.assertTrue(status['login_available']); self.assertIsNotNone(status['user'])
        self.assertFalse(status['connection']['readable']); self.assertFalse(status['connection']['uploadable'])
        self.assertEqual(status['connection']['project'], '')
        upload = self.client.get('/api/personal/oauth/start?purpose=upload', follow_redirects=False)
        upload_scopes = set(parse_qs(urlsplit(upload.headers['location']).query)['scope'][0].split())
        self.assertTrue({EE_WRITE, STORAGE} <= upload_scopes)

    def test_cancelled_and_invalid_callbacks_return_to_safe_retry_without_a_session(self):
        query = parse_qs(urlsplit(self.service.oauth.start('cancel-browser', None, 'login')).query)
        self.client.cookies.set('satgpt_oauth_browser', 'cancel-browser', domain='testserver.local', path='/api/personal/oauth')
        denied = self.client.get('/api/personal/oauth/callback', params={'state': query['state'][0], 'error': 'access_denied'}, follow_redirects=False)
        self.assertEqual(denied.headers['location'], 'http://testserver/?google=denied')
        self.assertNotIn('satgpt_session=', denied.headers.get('set-cookie', ''))
        invalid = self.client.get('/api/personal/oauth/callback', params={'state': query['state'][0], 'code': 'reused-code'}, follow_redirects=False)
        self.assertEqual(invalid.headers['location'], 'http://testserver/?google=failed')
        self.assertNotIn('satgpt_session=', invalid.headers.get('set-cookie', ''))
        self.assertIsNone(self.client.get('/api/personal/status').json()['user'])

    def test_unavailable_login_exposes_no_operator_configuration_and_rejects_start(self):
        self.client.app.state.personal = None
        status = self.client.get('/api/personal/status')
        self.assertFalse(status.json()['login_available'])
        response = self.client.get('/api/personal/oauth/start', follow_redirects=False)
        self.assertEqual(response.status_code, 503)
        self.assertIn('temporarily unavailable', response.json()['detail'])
        for value in ['CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY', '.env', 'test-client-secret']:
            self.assertNotIn(value, status.text + response.text)

    def test_refresh_finishing_after_disconnect_cannot_reactivate_the_connection(self):
        self.service.store.save_token(self.first, {'expires_at': 0})
        response = type('Response', (), {'status_code': 200, 'json': lambda self: {'access_token': 'late-refresh', 'expires_in': 3600}})()
        def refreshing(*_args, **_kwargs):
            self.service.disconnect(self.first)
            return response
        with patch('harness.app.personal.oauth.requests.post', side_effect=refreshing):
            with self.assertRaises(PersonalError): self.service.oauth.token(self.first, (EE_READ,))
        conn = self.service.store.connection(self.first, token=True)
        self.assertFalse(conn['active']); self.assertEqual(conn['token'], {})

    def test_queued_analysis_freezes_inputs_and_project_before_another_project_is_selected(self):
        import threading
        snapshots = []
        class Agent:
            runtime_environment = {}
            def __init__(self, *_): pass
            def __enter__(self): return self
            def __exit__(self, *_): pass
            def set_analysis_context(self, job): snapshots.append(copy.deepcopy(job))
            def run(self, *_args, **_kwargs): return 'Verified mock analysis'
        row = self.service.register_asset(self.first, 'projects/test-project/assets/private')
        execution = self.service.execution(self.first, [row['id']])
        controller = self.service.controller(self.first); controller.agent_factory = Agent
        release = threading.Event()
        self.service.pool.submit(lambda: release.wait(5))
        with patch('harness.app.controller.model_key_configured', return_value=True):
            job = controller.create('Use this data', [0,0,1,1], execution=execution)
            execution['data_refs'].clear()
            self.service.configure(self.first, 'another-project', '')
            release.set()
            for _ in range(10):
                job = controller.get(job['id'])
                if job['status'] in {'completed', 'failed'}: break
                job = controller.wait_for_job(job['id'], job['revision'], 1)
        self.assertEqual(job['status'], 'completed')
        self.assertEqual(snapshots[0]['execution']['project'], 'test-project')
        self.assertEqual(snapshots[0]['execution']['data_refs'][0]['id'], row['id'])
        self.assertEqual(controller.conversation()['messages'][0]['execution']['data_refs'][0]['id'], row['id'])

    def test_identity_namespaces_cover_history_previews_and_writes(self):
        headers = self.login(self.first)
        first = self.client.get('/api/harness/conversation').json()
        controller = self.service.controller(self.first)
        controller.messages = [{'role': 'user', 'content': 'private-first'}]; controller._save_messages()
        previews = controller.state_dir / 'previews'; previews.mkdir(parents=True)
        name = 'a' * 32 + '.png'; (previews / name).write_bytes(b'private preview')
        self.assertEqual(self.client.get('/api/previews/' + name).status_code, 200)
        self.assertEqual(self.client.post('/api/harness/conversation/new').status_code, 403)
        self.assertEqual(self.client.post('/api/harness/conversation/new', headers={**headers, 'Origin': 'https://other.test'}).status_code, 403)
        self.login(self.second)
        other = self.client.get('/api/harness/conversation').json()
        self.assertNotEqual(other['conversation_id'], first['conversation_id'])
        self.assertNotIn('private-first', json.dumps(other))
        self.assertEqual(self.client.get('/api/harness/conversations/' + first['conversation_id']).status_code, 404)
        self.assertEqual(self.client.get('/api/previews/' + name).status_code, 404)
        self.assertEqual(self.client.get('/api/harness/tasks/unknown/events').status_code, 404)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/api/harness/conversation').json()['conversation_id'], 'webgis-main')
        self.assertEqual(self.client.get('/api/previews/' + name).status_code, 404)

    def test_invalid_session_never_falls_back_to_guest_and_logout_clears_it(self):
        self.client.cookies.set('satgpt_session', 'invalid', domain='testserver.local', path='/')
        self.assertEqual(self.client.get('/api/harness/conversation').status_code, 401)
        self.assertEqual(self.client.post('/api/personal/logout').status_code, 200)
        self.assertEqual(self.client.get('/api/harness/conversation').status_code, 200)

    def test_pkce_state_browser_binding_expiration_and_nonce(self):
        url = self.service.oauth.start('browser-one', self.first, 'upload')
        params = parse_qs(urlsplit(url).query)
        self.assertEqual(params['code_challenge_method'], ['S256'])
        self.assertIn(STORAGE, params['scope'][0])
        state = params['state'][0]
        with self.assertRaises(PersonalError):
            self.service.store.consume_flow(state, 'browser-two')
        with self.assertRaises(PersonalError):
            self.service.store.consume_flow(state, 'browser-one')
        url = self.service.oauth.start('browser-one', self.first, 'gee')
        params = parse_qs(urlsplit(url).query)
        token = {'access_token': 'new-access', 'refresh_token': 'new-refresh', 'id_token': 'signed-google-token',
                 'scope': [EE_READ], 'expires_at': time.time() + 3600}
        with patch('harness.app.personal.oauth.OAuth2Session.fetch_token', return_value=token) as exchange, \
             patch('harness.app.personal.oauth.id_token.verify_oauth2_token', return_value={'sub': 'first', 'nonce': params['nonce'][0]}):
            session = self.service.oauth.finish(params['state'][0], 'browser-one', 'authorization-code', self.first)
        self.assertEqual(self.service.store.session(session)['owner'], self.first)
        self.assertTrue(exchange.call_args.kwargs['code_verifier'])
        self.assertNotIn('id_token', self.service.store.connection(self.first, token=True)['token'])

    def test_wrong_google_account_and_missing_nonce_cannot_link_credentials(self):
        for claims in ({'sub': 'second'}, {'sub': 'first'}):
            url = self.service.oauth.start('browser', self.first, 'gee'); params = parse_qs(urlsplit(url).query)
            claim = {**claims, 'nonce': params['nonce'][0] if claims['sub'] == 'second' else 'wrong'}
            with patch('harness.app.personal.oauth.OAuth2Session.fetch_token', return_value={'id_token': 'fake'}), \
                 patch('harness.app.personal.oauth.id_token.verify_oauth2_token', return_value=claim):
                with self.assertRaises(PersonalError):
                    self.service.oauth.finish(params['state'][0], 'browser', 'code', self.first)
        self.assertEqual(self.service.store.connection(self.first, token=True)['token']['access_token'], 'test-access-first')

    def test_refresh_keeps_refresh_token_and_partial_grants_are_enforced(self):
        self.service.store.save_token(self.first, {'expires_at': 0})
        response = type('Response', (), {'status_code': 200, 'json': lambda self: {'access_token': 'renewed', 'expires_in': 3600}})()
        with patch('harness.app.personal.oauth.requests.post', return_value=response):
            self.assertEqual(self.service.oauth.token(self.first, (EE_READ,)), 'renewed')
        self.assertEqual(self.service.store.connection(self.first, token=True)['token']['refresh_token'], 'test-refresh-first')
        self.service.store.save_token(self.first, {'scope': [EE_READ]})
        with self.assertRaises(PersonalError): self.service.oauth.token(self.first, (STORAGE,))
        status = self.service.status(self.service.store.session(self.service.store.new_session(self.first)))
        self.assertTrue(status['connection']['readable']); self.assertFalse(status['connection']['uploadable'])
        self.assertNotIn('test-refresh-first', json.dumps(status))
        self.assertNotIn(b'test-refresh-first', (self.settings.state_dir / 'personal.sqlite3').read_bytes())

    def test_selected_inputs_are_validated_frozen_and_replay_uses_original_project(self):
        row = self.service.register_asset(self.first, 'projects/test-project/assets/private')
        execution = self.service.execution(self.first, [row['id']])
        with self.assertRaises(PersonalError): self.service.execution(self.second, [row['id']])
        self.service.configure(self.first, 'another-project', '')
        self.service.validate_execution(execution, check_assets=True)
        self.assertEqual(execution['project'], 'test-project')
        recipe = generation_recipe('result = analysis_inputs[' + repr(row['id']) + ']', {'name': 'private'}, {'bounds': [0,0,1,1], 'execution': execution})
        payload = replay_payload(recipe)
        self.assertEqual(recipe['version'], 2)
        runtime = self.service.controller(self.first).prepare_payload(payload, replay=True)
        lease = runtime['SATGPT_GEE_LEASE']
        self.assertEqual(self.service.broker.resolve(lease)['project'], 'test-project')
        self.assertNotIn('test-access-first', json.dumps(recipe))
        self.cloud.records[row['asset_id']]['updateTime'] = 'changed'
        with self.assertRaises(PersonalError): self.service.validate_execution(execution, check_assets=True)

    def test_disconnect_invalidates_leases_and_queued_snapshots_without_deleting_history(self):
        execution = self.service.execution(self.first, [])
        controller = self.service.controller(self.first)
        controller.messages = [{'role': 'user', 'content': 'keep history'}]; controller._save_messages()
        runtime = controller.prepare_payload({'analysis_context': {'execution': execution}})
        self.service.disconnect(self.first)
        with self.assertRaises(PersonalError): self.service.broker.resolve(runtime['SATGPT_GEE_LEASE'])
        self.assertEqual(self.service.controller(self.first).conversation()['messages'][0]['content'], 'keep history')
        self.service.store.save_token(self.first, {'access_token': 'reconnected', 'expires_at': time.time() + 3600, 'scope': [EE_READ]})
        with self.assertRaises(PersonalError): self.service.validate_execution(execution)
        self.service.validate_execution(copy.deepcopy(execution), replay=True, check_assets=True)

    def test_no_personal_context_can_fall_back_to_service_account_worker(self):
        from harness.app.gee_worker import execute, checked_code
        with patch.dict('os.environ', {'SATGPT_GEE_BROKER': '', 'SATGPT_GEE_LEASE': ''}):
            with self.assertRaisesRegex(ValueError, 'original authenticated'):
                execute({'operation': 'eval', 'code': 'result = 1', 'analysis_context': {'execution': self.service.execution(self.first, [])}})
        for code in ['result = ee.Initialize()', 'result = ee.data.getAsset("x")', 'result = ee.batch.Task.list()']:
            with self.assertRaises(ValueError): checked_code(code)


if __name__ == '__main__':
    unittest.main()
