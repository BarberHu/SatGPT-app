import json
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from harness.app.controller import AdmissionError, TaskController
from harness.app.identity import COOKIE
from harness.tests.runtime_fixture import SimulatedRuntime, client_for, new_chat, result, task_body, wait_for_task

API = '/api/harness'


class ConversationTests(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.root = Path(folder.name)
        self.release = threading.Event()
        self.admitted = threading.Event()
        self.controller = self.make_controller()
        self.a, self.b = (client_for(self.controller) for _ in range(2))

    def make_controller(self):
        controller = TaskController(self.root, runtime_factory=lambda *args: SimulatedRuntime(*args, run=self.run_task))
        self.addCleanup(controller.close)
        return controller

    def run_task(self, prompt, ctx, stop, **_):
        if 'HOLD' in prompt:
            self.admitted.set()
            assert self.release.wait(5)
        return result('Offline answer', ctx=ctx, reason='aborted' if stop.is_set() else 'completed')

    def test_draft_reads_and_rejected_first_messages_do_not_write(self):
        empty = {'conversation_id': None, 'messages': [], 'active_task': None}
        for _ in range(3):
            self.assertEqual(self.a.get(API+'/conversation').json(), empty)
        for body in (task_body(None, '   '), task_body(None, bounds=[1, 0, 0, 1]),
                     task_body(None, analysis_region={'type': 'Point', 'coordinates': [1, 1]})):
            self.assertEqual(self.a.post(API+'/tasks', json=body).status_code, 422)
        with patch.object(self.controller, '_require_available', side_effect=AdmissionError('runtime_unavailable', 'Offline', 503)):
            self.assertEqual(self.a.post(API+'/tasks', json=task_body(None)).status_code, 503)
        with patch.object(self.controller.store, 'save_messages', side_effect=ValueError('Simulated write failure')):
            self.assertEqual(self.a.post(API+'/tasks', json=task_body(None)).status_code, 422)
        self.assertEqual(self.a.get(API+'/conversations').json(), {'conversations': []})
        self.assertEqual(self.controller.runtime.opens, [])
        with self.controller.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM conversations').fetchone()[0], 0)
            self.assertEqual(db.execute('SELECT count(*) FROM tasks').fetchone()[0], 0)

    def test_first_message_retry_reuses_conversation_and_deleting_it_leaves_no_draft_record(self):
        self.controller.execution_slots = 0
        body = task_body(None, 'First question')
        del body['conversation_id']
        response = self.a.post(API+'/tasks', json=body)
        self.assertEqual(response.status_code, 202)
        first = response.json()
        cid = first['conversation_id']
        path = f'{API}/conversations/{cid}'
        self.assertEqual(self.a.post(API+'/tasks', json={**body, 'conversation_id': None}).json(), first)
        conflict = self.a.post(API+'/tasks', json={**body, 'prompt': 'Different input'})
        self.assertEqual((conflict.status_code, conflict.json()['detail']['code']), (409, 'request_conflict'))
        self.assertEqual(self.b.get(path).status_code, 404)
        self.assertEqual(self.a.get(API+'/conversation').json()['conversation_id'], cid)
        self.assertEqual(self.a.get(API+'/conversations').json()['conversations'][0]['title'], 'First question')
        with self.controller.store.connect() as db:
            self.assertEqual(db.execute('SELECT count(*) FROM conversations').fetchone()[0], 1)
            self.assertEqual(db.execute('SELECT count(*) FROM tasks').fetchone()[0], 1)
        self.assertEqual([m['content'] for m in self.a.get(path).json()['messages']], ['First question'])
        self.assertEqual(self.controller.runtime.opens, [])

        self.a.post(f'{API}/tasks/{first["id"]}/cancel').raise_for_status()
        followup = self.a.post(API+'/tasks', json=task_body(cid, 'Follow-up question'))
        self.assertEqual(followup.status_code, 202)
        self.assertEqual(followup.json()['conversation_id'], cid)
        self.a.post(f'{API}/tasks/{followup.json()["id"]}/cancel').raise_for_status()
        removed = self.a.delete(path)
        removed.raise_for_status()
        self.assertIsNone(removed.json()['conversation']['conversation_id'])
        self.assertEqual(removed.json()['conversations'], [])
        self.assertEqual(self.a.post(API+'/tasks', json=body).status_code, 404)
        with self.controller.store.connect() as db:
            self.assertEqual([row['deleted'] for row in db.execute('SELECT deleted FROM conversations')], [1])

    def test_reasoning_options_validate_and_snapshot_each_submission(self):
        self.controller.execution_slots = 0
        options = self.a.get(API+'/reasoning').json()
        self.assertEqual([item['id'] for item in options['levels']], ['off', 'low', 'high', 'max'])
        self.assertEqual(options['default_effort'], 'high')
        invalid = self.a.post(API+'/tasks', json=task_body(None, reasoning_effort='medium'))
        self.assertEqual((invalid.status_code, invalid.json()['detail']['code']), (422, 'unsupported_reasoning_effort'))
        self.assertEqual(self.a.get(API+'/conversations').json(), {'conversations': []})
        body = task_body(None, reasoning_effort='low')
        first = self.a.post(API+'/tasks', json=body)
        self.assertEqual(first.status_code, 202)
        self.assertEqual(first.json()['reasoning_effort'], 'low')
        self.assertEqual(self.a.post(API+'/tasks', json=body).json(), first.json())
        conflict = self.a.post(API+'/tasks', json={**body, 'reasoning_effort': 'max'})
        self.assertEqual((conflict.status_code, conflict.json()['detail']['code']), (409, 'request_conflict'))
        with patch.object(self.controller.runtime, 'reasoning', None):
            self.assertEqual(self.a.get(API+'/reasoning').status_code, 503)
            default = self.a.post(API+'/tasks', json=task_body(None))
            self.assertEqual(default.status_code, 202)
            self.assertNotIn('reasoning_effort', default.json())
        with self.controller.store.connect() as db:
            receipt = json.loads(self.controller.store.next_queued(db)['receipt'])
        self.assertEqual(receipt['reasoning_effort'], 'low')

    def test_cookie_owner_is_persistent_and_cannot_be_chosen_by_the_client(self):
        cid = new_chat(self.a)
        self.assertEqual(self.b.get(f'{API}/conversations/{cid}').status_code, 404)
        self.assertEqual(self.b.post(f'{API}/conversations/{cid}/activate').status_code, 404)
        self.assertEqual(self.b.delete(f'{API}/conversations/{cid}').status_code, 404)
        self.assertEqual(self.b.post(f'{API}/tasks', json=task_body(cid)).status_code, 404)
        self.assertEqual(self.a.post(f'{API}/tasks', json=task_body(cid, owner_id='spoofed')).status_code, 422)
        token = self.a.cookies.get(COOKIE)
        self.a.cookies.set(COOKIE, token[:-1] + ('0' if token[-1] != '0' else '1'), domain='testserver.local', path='/')
        self.assertEqual(self.a.get(f'{API}/conversations/{cid}').status_code, 404)
        self.a.cookies.set(COOKIE, token, domain='testserver.local', path='/')
        self.assertEqual(self.a.get(f'{API}/conversations/{cid}').status_code, 200)

    def test_overflow_queues_in_order_and_running_cancel_holds_slot_until_cleanup(self):
        self.addCleanup(self.release.set)
        self.controller.execution_slots = 1
        first_chat, second_chat, last_chat = [new_chat(self.a) for _ in range(3)]
        other_chat = new_chat(self.b)
        body = task_body(first_chat, 'HOLD first')
        first = self.a.post(API+'/tasks', json=body)
        self.assertEqual(first.status_code, 202)
        task_id = first.json()['id']
        self.assertTrue(self.admitted.wait(2))
        self.assertEqual(self.a.post(API+'/tasks', json=body).json()['id'], task_id)
        self.assertEqual(self.a.post(API+'/tasks', json={**body, 'prompt': 'Different'}).json()['detail']['code'],
                         'request_conflict')
        self.assertEqual(self.a.post(API+'/tasks', json=task_body(first_chat)).status_code, 409)
        waiting_body = task_body(second_chat, 'Second task')
        second = self.a.post(API+'/tasks', json=waiting_body)
        last = self.a.post(API+'/tasks', json=task_body(last_chat, 'Last task'))
        other = self.b.post(API+'/tasks', json=task_body(other_chat, 'Other browser'))
        self.assertEqual([r.status_code for r in (second, last, other)], [202, 202, 202])
        sid, lid, oid = [r.json()['id'] for r in (second, last, other)]
        self.assertEqual(self.a.post(API+'/tasks', json=waiting_body).json()['id'], sid)
        self.assertEqual(self.a.post(API+'/tasks', json=task_body(second_chat)).status_code, 409)
        second_feed = self.controller.stream(self.controller.identity.verify(self.a.cookies.get(COOKIE)), sid)
        self.assertEqual(second_feed.read()[0]['task']['status'], 'queued')
        self.assertEqual(self.a.get(f'{API}/conversations/{second_chat}').json()['active_task'], sid)
        with self.controller.store.connect() as db:
            self.assertEqual(json.loads(self.controller.store.next_queued(db)['receipt'])['id'], sid)
        self.assertEqual(self.b.get(f'{API}/tasks/{sid}').status_code, 404)
        self.assertEqual(self.b.get(f'{API}/tasks/{sid}/events').status_code, 404)
        self.assertEqual(self.b.post(f'{API}/tasks/{sid}/cancel').status_code, 404)
        self.assertEqual(self.a.delete(f'{API}/conversations/{second_chat}').status_code, 409)
        self.assertEqual(self.a.post(f'{API}/tasks/{task_id}/cancel').json()['status'], 'cancelling')
        deadline = time.monotonic() + 2
        while self.a.get(f'{API}/tasks/{task_id}').json()['cancellation'] != 'accepted' and time.monotonic() < deadline:
            time.sleep(.01)
        for job_id in (sid, lid):
            self.assertEqual(self.a.get(f'{API}/tasks/{job_id}').json()['status'], 'queued')
        self.assertEqual(len(self.controller.runtime.opens), 1)
        self.release.set()
        settled = wait_for_task(self.a, task_id)
        self.assertEqual(settled['status'], 'cancelled')
        self.assertEqual(self.a.post(f'{API}/tasks/{task_id}/cancel').json(), settled)
        finished = [wait_for_task(self.a, sid), wait_for_task(self.a, lid), wait_for_task(self.b, oid)]
        self.assertTrue(all(job['status'] == 'completed' and job['queue_wait_ms'] > 0 for job in finished))
        self.assertEqual([job['dispatched_at'] for job in finished], sorted(job['dispatched_at'] for job in finished))
        self.assertIn('starting', [event.get('patch', {}).get('status') for event in second_feed.read(after=0)])
        self.assertIn('"status": "cancelled"', self.a.get(f'{API}/tasks/{task_id}/events?after=1').text)
        self.assertEqual(self.a.delete(f'{API}/conversations/{first_chat}').status_code, 200)
        self.assertEqual(self.a.get(f'{API}/tasks/{task_id}').status_code, 404)

    def test_cancel_queued_job_without_opening_native_session(self):
        self.addCleanup(self.release.set)
        self.controller.execution_slots = 1
        first = self.a.post(API+'/tasks', json=task_body(new_chat(self.a), 'HOLD first')).json()
        self.assertTrue(self.admitted.wait(2))
        cid = new_chat(self.a)
        body = task_body(cid, 'Cancel this before it starts')
        queued = self.a.post(API+'/tasks', json=body).json()
        job_id = queued['id']
        feed = self.controller.stream(self.controller.identity.verify(self.a.cookies.get(COOKIE)), job_id)
        self.assertEqual(feed.read()[0]['task']['status'], 'queued')
        cancelled = self.a.post(f'{API}/tasks/{job_id}/cancel').json()
        self.assertEqual(cancelled['status'], 'cancelled')
        self.assertNotIn('dispatched_at', cancelled)
        self.assertTrue(feed.terminal)
        self.assertEqual(self.a.post(API+'/tasks', json=body).json(), cancelled)
        self.assertEqual(self.a.get(f'{API}/conversations/{cid}').json()['active_task'], None)
        replacement = self.a.post(API+'/tasks', json=task_body(cid, 'Replacement task')).json()
        self.release.set()
        self.assertEqual(wait_for_task(self.a, first['id'])['status'], 'completed')
        self.assertEqual(wait_for_task(self.a, replacement['id'])['status'], 'completed')
        self.assertEqual(len(self.controller.runtime.opens), 2)

    def test_restart_keeps_only_owned_history_and_marks_live_receipts_interrupted(self):
        cid = new_chat(self.a)
        receipt = self.a.post(API+'/tasks', json=task_body(cid)).json()
        settled = wait_for_task(self.a, receipt['id'])
        token = self.a.cookies.get(COOKIE)
        # Simulate a restart with a task durable in the queue and a separate in-flight receipt.
        self.controller.execution_slots = 0
        pending = self.a.post(API+'/tasks', json=task_body(new_chat(self.a), 'Queued before restart')).json()
        self.controller.close()
        with self.controller.store.connect(write=True) as db:
            self.controller.store.save_task(db, {**settled, 'status': 'starting'})
        (self.root/'state'/'chat-history.json').write_text(json.dumps({'messages': [{'content': 'legacy'}]}))
        restarted = self.make_controller()
        after = client_for(restarted)
        after.cookies.set(COOKIE, token, domain='testserver.local', path='/')
        self.assertEqual(after.get(f'{API}/tasks/{receipt["id"]}').json()['status'], 'interrupted')
        self.assertEqual(after.get(f'{API}/conversations/{cid}').json()['active_task'], None)
        self.assertNotIn('legacy', after.get(API+'/conversations').text)
        self.assertEqual(after.get(f'{API}/tasks/{pending["id"]}').json()['status'], 'interrupted')
        self.assertEqual(restarted.runtime.opens, [])
        followup = after.post(API+'/tasks', json=task_body(cid, 'Resume previous session')).json()
        self.assertEqual(wait_for_task(after, followup['id'])['status'], 'completed')
        self.assertTrue(restarted.runtime.opens[0][1])

    def test_rejects_cross_origin_mutation_and_ignores_spoofed_proxy_scheme(self):
        forbidden = self.a.post(API+'/tasks', json=task_body(None), headers={'Origin':'http://untrusted.test'})
        self.assertEqual(forbidden.status_code, 403)
        self.b.cookies.clear()
        response = self.b.get(API+'/session', headers={'X-Forwarded-Proto':'https'})
        cookie = response.headers['set-cookie'].lower()
        self.assertIn('httponly', cookie)
        self.assertIn('samesite=lax', cookie)
        self.assertNotIn('; secure', cookie)

    def test_resident_limit_rotates_after_active_tasks_finish(self):
        self.addCleanup(self.release.set)
        self.controller.runtime.resident_limit = 1
        a1, a2 = [new_chat(self.a) for _ in range(2)]
        first = self.a.post(API+'/tasks', json=task_body(a1, 'HOLD until rotation')).json()
        self.assertTrue(self.admitted.wait(2))
        second = self.a.post(API+'/tasks', json=task_body(a2))
        self.assertEqual(second.status_code, 202)
        self.assertEqual(self.a.get(f'{API}/tasks/{second.json()["id"]}').json()['status'], 'queued')
        self.assertEqual(self.controller.runtime.starts, 1)
        self.release.set()
        self.assertEqual(wait_for_task(self.a, first['id'])['status'], 'completed')
        self.assertEqual(wait_for_task(self.a, second.json()['id'])['status'], 'completed')
        self.assertEqual(self.controller.runtime.starts, 2)

    def test_stop_during_native_open_prevents_prompt_admission(self):
        opening, continue_open = threading.Event(), threading.Event()
        native_open = self.controller.runtime.open
        launched = []

        def open_session(native_id, **kwargs):
            opening.set()
            assert continue_open.wait(3)
            return native_open(native_id, **kwargs)

        self.controller.runtime.open = open_session
        self.controller.runtime.run = lambda **_: launched.append(True) or result()
        try:
            cid = new_chat(self.a)
            task = self.a.post(API+'/tasks', json=task_body(cid)).json()
            self.assertTrue(opening.wait(2))
            response = self.a.post(f'{API}/tasks/{task["id"]}/cancel')
            self.assertEqual(response.json()['status'], 'cancelling')
            self.assertEqual(self.a.post(API+'/tasks', json=task_body(cid)).status_code, 409)
            continue_open.set()
            self.assertEqual(wait_for_task(self.a, task['id'])['status'], 'cancelled')
            self.assertEqual(launched, [])
        finally:
            continue_open.set()

    def test_application_deadline_cancels_through_the_same_native_bridge(self):
        self.controller.timeout = 1
        self.controller.runtime.run = lambda stop, **_: result(reason='aborted') if stop.wait(3) else result()
        cid = new_chat(self.a)
        job = self.a.post(API+'/tasks', json=task_body(cid)).json()
        finished = wait_for_task(self.a, job['id'])
        self.assertEqual(finished['status'], 'cancelled')
        self.assertEqual(finished['stop_reason'], 'deadline')
        self.assertEqual(finished['cancellation'], 'settled')
