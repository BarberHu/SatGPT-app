import unittest
from harness.app.task_stream import TaskStream


def attempt(kind, sequence, revision, **extra):
    return dict(type=kind, run_id='run', attempt_id='a', sequence=sequence, revision=revision, **extra)


def session(kind, seq, **data):
    return dict(type='session', event=dict(type=kind, seq=seq, data=data))


class TimelineTests(unittest.TestCase):
    def feed(self, capacity=2048):
        return TaskStream(dict(id='job', conversation_id='session', status='running'), capacity)

    def settle(self, feed, sequence, revision, text='', reasoning='', attempt_id='a'):
        feed.frame(dict(type='end', run_id='run', attempt_id=attempt_id, sequence=sequence,
            revision=revision, index=100, outcome=dict(kind='committed', eventType='assistant/message', seq=8),
            settlement=dict(seq=8, event_type='assistant/message', text=text, reasoning=reasoning)))

    def test_interleaving_tool_result_updates_original_position_and_final_is_unique(self):
        feed = self.feed()
        feed.frame(attempt('start', 1, 1, turn=2, step=3))
        feed.frame(attempt('reasoning', 2, 2, index=0, text='first '))
        feed.frame(attempt('reasoning', 3, 3, index=1, text='thought'))
        feed.frame(attempt('delta', 4, 4, index=2, text='checking now'))
        self.settle(feed, 5, 5, text='Checking now.', reasoning='First thought.')
        feed.frame(session('tool/call', 9, turn=2, step=3, callId='one', name='gee_status', arguments='{}'))
        feed.frame(session('tool/call', 10, turn=2, step=3, callId='two', name='gee_eval', arguments='code'))
        feed.frame(session('tool/result', 11, message=dict(toolCallId='two', content=[dict(type='text', text='2')])) )
        feed.frame(session('tool/result', 12, message=dict(toolCallId='one', content=[dict(type='text', text='ok')])) )
        feed.frame(dict(type='start', run_id='run', attempt_id='b', sequence=1, revision=6, turn=2, step=4))
        feed.frame(dict(type='reasoning', run_id='run', attempt_id='b', sequence=2, revision=7, index=0, text='then thought'))
        feed.frame(dict(type='delta', run_id='run', attempt_id='b', sequence=3, revision=8, index=1, text='draft'))
        self.settle(feed, 4, 9, text='Final.', reasoning='Then thought.', attempt_id='b')
        rows = feed.read()[0]['task']['timeline']
        self.assertEqual([r['kind'] for r in rows], ['reasoning', 'text', 'tool', 'tool', 'reasoning', 'text'])
        self.assertEqual([r['result'] for r in rows if r['kind'] == 'tool'], ['ok', '2'])
        self.assertEqual(rows[0]['text'], 'First thought.')
        self.assertEqual(rows[-2]['step'], 4)
        self.assertEqual(rows[2]['session_seq'], 9)
        saved = feed.finish_timeline('Final.')
        self.assertEqual([r['text'] for r in saved if r['kind'] == 'text'], ['Checking now.'])
        self.assertTrue(all(r['committed'] for r in saved))
        self.assertEqual([r['seq'] for r in saved], sorted(set(r['seq'] for r in saved)))

    def test_tool_interrupts_reasoning_row_even_in_same_attempt(self):
        feed = self.feed()
        feed.frame(attempt('start', 1, 1, turn=1, step=1))
        feed.frame(attempt('reasoning', 2, 2, index=0, text='before'))
        feed.frame(session('tool/call', 1, callId='tool', name='gee_eval'))
        feed.frame(attempt('reasoning', 3, 3, index=1, text='after'))
        rows = feed.read()[0]['task']['timeline']
        self.assertEqual([r['kind'] for r in rows], ['reasoning', 'tool', 'reasoning'])
        feed.frame(attempt('end', 4, 4, index=2, outcome=dict(kind='abandoned')))
        self.assertEqual([r['kind'] for r in feed.read()[0]['task']['timeline']], ['tool'])

    def test_canonical_blocks_replace_each_streamed_block_in_place(self):
        feed = self.feed()
        feed.frame(attempt('start', 1, 1, turn=1, step=1))
        for index, kind in enumerate(['reasoning', 'delta', 'reasoning', 'delta']):
            feed.frame(attempt(kind, index + 2, index + 2, index=index,
                               block_index=index, text=f'draft {index}'))
        feed.frame(attempt('end', 6, 6, index=4,
            outcome=dict(kind='committed', eventType='assistant/message', seq=8),
            settlement=dict(event_type='assistant/message', seq=8, text='phase final', reasoning='a b', blocks=[
                dict(index=0, type='reasoning', text='a'), dict(index=1, type='text', text='phase'),
                dict(index=2, type='reasoning', text='b'), dict(index=3, type='text', text='final')])) )
        rows = feed.read()[0]['task']['timeline']
        self.assertEqual([r['text'] for r in rows], ['a', 'phase', 'b', 'final'])
        self.assertEqual([r['kind'] for r in rows], ['reasoning', 'text', 'reasoning', 'text'])
        saved = feed.finish_timeline('phasefinal')
        self.assertEqual([r['kind'] for r in saved], ['reasoning', 'reasoning'])

    def test_refresh_and_compacted_reconnect_keep_live_and_committed_order(self):
        feed = self.feed(2)
        feed.frame(attempt('start', 1, 1, turn=1, step=1))
        feed.frame(attempt('reasoning', 2, 2, index=0, text='thought'))
        self.settle(feed, 3, 3, reasoning='thought')
        feed.frame(session('tool/call', 9, callId='one', name='gee_status'))
        fresh = feed.read()[0]
        compacted = feed.read(0, 0)[0]
        self.assertEqual(fresh['task']['timeline'], compacted['task']['timeline'])
        self.assertEqual([r['kind'] for r in fresh['task']['timeline']], ['reasoning', 'tool'])
        feed.frame(session('tool/result', 10, message=dict(toolCallId='one', content=[])))
        event = feed.read(fresh['id'], 0)[0]
        self.assertNotIn('task', event)
        self.assertEqual(event['timeline_ops'][0]['row']['id'], fresh['task']['timeline'][1]['id'])

    def test_retry_failure_withdraws_only_uncommitted_and_transport_duplicates_are_ignored(self):
        feed = self.feed()
        feed.frame(dict(attempt('start', 1, 1), event_sequence=1))
        delta = dict(attempt('reasoning', 2, 2, index=0, text='discard'), event_sequence=2)
        feed.frame(delta)
        feed.frame(delta)
        self.assertEqual(len(feed.read()[0]['task']['timeline']), 1)
        feed.frame(dict(session('llm/retry', 3), event_sequence=3))
        self.assertEqual([r['kind'] for r in feed.read()[0]['task']['timeline']], ['status'])
        feed.update(status='failed')
        self.assertNotIn('discard', str(feed.read()[0]))


if __name__ == '__main__':
    unittest.main()
