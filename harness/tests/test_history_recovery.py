import contextlib
import copy
import io
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.app import history_admin, history_recovery
from harness.app.controller import TaskController
from harness.app.session_store import SessionStore
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, task_body, wait_for_task
from harness.tests.test_layer_reload import POLYGON, URL, run_layers


API = '/api/harness'
RECOVERY = API + '/history-recovery'


class HistoryRecoveryTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.controller = TaskController(self.root, state=self.root / 'data',
                                         runtime_factory=lambda *args: SimulatedRuntime(*args, run=run_layers))
        self.addCleanup(self.controller.close)
        self.old, self.new, self.outsider = [client_for(self.controller) for _ in range(3)]

    def open_request(self):
        response = self.new.post(RECOVERY + '/request')
        self.assertEqual(response.status_code, 201)
        return response.json()

    def issue_proof(self, cid):
        response = self.old.post(f'{API}/conversations/{cid}/recovery-proof')
        self.assertEqual(response.status_code, 201)
        return response.json()['code']

    def approve(self, request, credentials, **extra):
        with self.controller.store.connect(write=True) as db:
            return history_recovery.approve(db, request['code'], credentials, operator='test-operator', **extra)

    def claim(self, request, client=None):
        return (client or self.new).post(RECOVERY + '/claim', json={'request_id': request['request_id']})

    def submit(self, client, cid, **extra):
        response = client.post(API + '/tasks', json=task_body(cid, analysis_region=copy.deepcopy(POLYGON), **extra))
        self.assertEqual(response.status_code, 202)
        return response.json()['id']

    def history(self, client):
        return {row['id'] for row in client.get(API + '/conversations').json()['conversations']}

    def test_local_approval_moves_only_selected_conversation_and_reuses_its_native_session_and_files(self):
        cid, unrelated, existing = new_chat(self.old), new_chat(self.old), new_chat(self.new)
        job_id = self.submit(self.old, cid, prompt='测试：原浏览器地图和上下文')
        job = wait_for_task(self.old, job_id)
        self.assertEqual(job['status'], 'completed')
        preview = job['output']['layers'][0]['thumbnail']['url']
        conversation = f'{API}/conversations/{cid}'
        previous = self.old.get(conversation).json()
        self.assertEqual(self.new.get(preview).status_code, 404)
        self.assertEqual(self.new.post(conversation + '/recovery-proof').status_code, 404)
        self.assertEqual(self.old.post(conversation + '/recovery-proof', headers={'Origin': 'https://other.test'}).status_code, 403)
        proof = self.issue_proof(cid)
        request = self.open_request()
        private_status = self.new.get(RECOVERY + '/request')
        self.assertEqual(private_status.json()['status'], 'pending')
        self.assertNotIn(request['code'], private_status.text)
        self.assertIn('no-store', private_status.headers['Cache-Control'])
        self.assertEqual(self.claim(request, self.outsider).status_code, 404)

        output = io.StringIO()
        args = ['--state-dir', str(self.controller.state)]
        with patch.object(history_admin.getpass, 'getpass', side_effect=[request['code'], proof]), contextlib.redirect_stdout(output):
            self.assertEqual(history_admin.main([*args, 'approve', '--conversation', cid]), 0)
        self.assertEqual(json.loads(output.getvalue()), {'approved': 1})
        self.assertEqual(self.new.get(RECOVERY + '/request').json()['status'], 'approved')
        self.assertEqual(self.claim(request).json(), {'count': 1})
        self.assertEqual(self.claim(request).json(), {'count': 1})
        self.assertEqual(self.history(self.old), {unrelated})
        self.assertEqual(self.history(self.new), {cid, existing})
        self.assertEqual(self.new.get(conversation).json(), previous)
        self.assertEqual(self.new.get(preview).content, b'test-preview')
        for path in (conversation, preview, f'{API}/tasks/{job_id}', f'{API}/tasks/{job_id}/events'):
            for client in (self.old, self.outsider):
                self.assertEqual(client.get(path).status_code, 404)

        old_native = self.controller.runtime.opens[0][0]
        def reload_layer(payload):
            self.assertTrue((Path(payload['artifact_dir']) / ('a' * 32 + '.png')).is_file())
            return {'name': 'Reloaded', 'url': URL.format(name='fresh'), 'bounds': payload['bounds'],
                    'visualization': payload['visualization']}

        with patch.object(self.controller.runtime, 'reload', side_effect=reload_layer):
            self.assertEqual(self.new.post(f'{conversation}/layers/{job_id}-0/reload').status_code, 200)
        followup = self.submit(self.new, cid, prompt='测试：恢复后追问上一轮图层')
        self.assertEqual(wait_for_task(self.new, followup)['status'], 'completed')
        self.assertEqual(self.controller.runtime.opens[-1], (old_native, True))
        with self.controller.store.connect() as db:
            row = db.execute('SELECT owner,artifact_owner FROM conversations WHERE id=?', (cid,)).fetchone()
            self.assertNotEqual(row['owner'], row['artifact_owner'])
            directory = self.controller.state / 'artifacts' / row['artifact_owner'] / cid
            self.assertTrue((directory / followup / ('a' * 32 + '.png')).is_file())
            self.assertEqual([row['event'] for row in db.execute('SELECT event FROM history_audit ORDER BY id')],
                             ['approved_proof', 'transferred'])
            self.assertIsNone(db.execute('SELECT digest FROM history_proofs WHERE conversation_id=?', (cid,)).fetchone())
            self.assertNotEqual(db.execute('SELECT digest FROM history_requests').fetchone()[0], request['code'])

    def test_proofs_are_conversation_specific_and_pending_expired_and_cross_origin_claims_are_rejected(self):
        cid, other = new_chat(self.old), new_chat(self.old)
        proof = self.issue_proof(cid)
        request = self.open_request()
        self.assertEqual(self.new.post(RECOVERY + '/request').status_code, 429)
        self.assertEqual(self.claim(request).json()['detail']['code'], 'approval_pending')
        self.assertEqual(self.claim(request).status_code, 429)
        self.assertEqual(self.new.post(RECOVERY + '/claim', json={'request_id': request['request_id']},
                                       headers={'Origin': 'https://other.test'}).status_code, 403)
        with self.assertRaisesRegex(history_recovery.RecoveryError, 'does not verify'):
            self.approve(request, {cid: proof, other: proof})
        self.assertEqual(self.new.get(RECOVERY + '/request').json()['status'], 'pending')
        with self.controller.store.connect(write=True) as db:
            db.execute('UPDATE history_requests SET expires=0')
        self.assertEqual(self.new.get(RECOVERY + '/request').json()['status'], 'expired')
        self.assertEqual(self.claim(request).json()['detail']['code'], 'request_expired')
        with self.assertRaisesRegex(history_recovery.RecoveryError, 'expired'):
            self.approve(request, {cid: proof})

    def test_manual_verification_is_audited_and_busy_or_conflicting_batch_rolls_back(self):
        first, second = sorted((new_chat(self.old), new_chat(self.old)))
        target = new_chat(self.new)
        self.controller.execution_slots = 0
        shared_id = 'simulated-conflict-0001'
        idle = self.submit(self.old, first)
        busy = self.submit(self.old, second, request_id=shared_id)
        receive = self.submit(self.new, target, request_id=shared_id)
        with self.controller.store.connect() as db:
            args = ['--state-dir', str(self.controller.state), 'list', '--task-status', 'queued', '--limit', '1', '--offset', '1']
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(history_admin.main(args), 0)
            listing = json.loads(output.getvalue())
            self.assertEqual((listing['total'], len(listing['conversations'])), (3, 1))
            self.assertEqual(db.execute("SELECT COUNT(*) FROM tasks WHERE status='queued'").fetchone()[0], 3)
        self.assertEqual(self.old.post(f'{API}/tasks/{idle}/cancel').status_code, 200)

        request = self.open_request()
        self.approve(request, {first: None, second: None}, verified_case='CASE-001')
        self.assertEqual(self.claim(request).json()['detail']['code'], 'conversation_busy')
        self.assertEqual(self.history(self.old), {first, second})
        self.assertEqual(self.old.post(f'{API}/tasks/{busy}/cancel').status_code, 200)
        self.assertEqual(self.new.post(f'{API}/tasks/{receive}/cancel').status_code, 200)
        with patch.object(history_recovery, 'CLAIM_INTERVAL', 0):
            self.assertEqual(self.claim(request).json()['detail']['code'], 'request_conflict')
        self.assertEqual(self.history(self.old), {first, second})
        self.assertEqual(self.history(self.new), {target})
        with self.controller.store.connect() as db:
            case = db.execute('SELECT verified_case FROM history_audit WHERE event=?', ('approved_case',)).fetchone()
            self.assertEqual(case['verified_case'], 'CASE-001')
            self.assertIsNone(db.execute('SELECT consumed FROM history_requests').fetchone()[0])
            self.assertEqual(db.execute("SELECT COUNT(*) FROM history_audit WHERE event='transferred'").fetchone()[0], 0)

    def test_replacing_proof_invalidates_approval_and_deleted_histories_stay_unavailable(self):
        cid = new_chat(self.old)
        old_proof = self.issue_proof(cid)
        request = self.open_request()
        self.approve(request, {cid: old_proof})
        with patch.object(history_recovery, 'ISSUE_INTERVAL', 0):
            new_proof = self.issue_proof(cid)
        self.assertNotEqual(new_proof, old_proof)
        self.assertEqual(self.claim(request).json()['detail']['code'], 'stale_approval')
        self.assertEqual(self.old.delete(f'{API}/conversations/{cid}').status_code, 200)
        with patch.object(history_recovery, 'ISSUE_INTERVAL', 0):
            next_request = self.open_request()
        with self.assertRaisesRegex(history_recovery.RecoveryError, 'unavailable'):
            self.approve(next_request, {cid: new_proof})

    def test_existing_schema_migrates_without_rewriting_chat_data(self):
        path = self.root / 'old.sqlite3'
        with contextlib.closing(sqlite3.connect(path)) as db:
            db.executescript('''
                CREATE TABLE conversations (id TEXT PRIMARY KEY, owner TEXT NOT NULL, native_id TEXT NOT NULL UNIQUE,
                    native_state TEXT NOT NULL DEFAULT 'new', updated TEXT NOT NULL, messages TEXT NOT NULL,
                    deleted INTEGER NOT NULL DEFAULT 0);
                INSERT INTO conversations VALUES ('original', 'owner', 'native', 'open', 'old', '["legacy"]', 0);
            ''')
        store = SessionStore(path)
        with store.connect() as db:
            row = store.owned(db, 'owner', 'original')
            self.assertEqual((row['native_id'], row['messages'], row['artifact_owner']), ('native', '["legacy"]', None))
