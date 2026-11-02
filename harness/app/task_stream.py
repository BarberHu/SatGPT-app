"""Bounded in-memory task events. Drafts never enter durable chat history."""

from __future__ import annotations

import copy
import threading
from collections import deque
from .timeline import Timeline
from .trace import clean_text


class TaskStream:
    def __init__(self, task: dict, capacity=2048, secrets=()):
        self.condition = threading.Condition()
        self.events = deque(maxlen=capacity)
        self.sequence = 0
        self.task = copy.deepcopy(task)
        self.answer = None
        self.attempt = None
        self.last_revision = -1
        self.timeline = Timeline(secrets)
        self.last_transport_sequence = 0
        self.secrets = secrets

    def _emit(self, kind, **payload):
        self.sequence += 1
        event = {'id': self.sequence, 'type': kind, 'task_id': self.task['id'],
                 'conversation_id': self.task['conversation_id'], **payload}
        operations = self.timeline.drain()
        if operations:
            event['timeline_ops'] = operations
        self.events.append(event)
        self.condition.notify_all()

    def update(self, **patch):
        with self.condition:
            self.task.update(copy.deepcopy(patch))
            if patch.get('status') in {'completed', 'failed'}:
                self.timeline.finish((patch.get('output') or {}).get('message', ''))
                self.task['timeline'] = self.timeline.committed()
                patch['timeline'] = self.task['timeline']
                self.answer = self.attempt = None
            self._emit('task', patch=patch)

    def frame(self, frame):
        with self.condition:
            if self.task['status'] != 'running':
                return
            kind = frame.get('type')
            order = frame.get('event_sequence')
            if isinstance(order, int):
                if order <= self.last_transport_sequence:
                    return
                if self.last_transport_sequence and order != self.last_transport_sequence + 1:
                    self.timeline.retract()
                    self.answer = self.attempt = None
                    self._emit('answer.reset', attempt_id=None)
                self.last_transport_sequence = order
            if kind == 'session':
                attempt_id = f"{frame.get('run_id')}:{frame['attempt_id']}" if frame.get('attempt_id') else None
                self.timeline.session(frame.get('event') or {}, attempt_id)
                if self.timeline.operations:
                    self._emit('timeline')
                return
            key = f"{frame.get('run_id')}:{frame.get('attempt_id')}"
            sequence, revision = frame.get('sequence'), frame.get('revision')
            if not isinstance(sequence, int) or not isinstance(revision, int):
                return
            if kind == 'start':
                if revision <= self.last_revision:
                    return
                if self.attempt and self.attempt['id'] == key:
                    return
                self.timeline.retract()
                self.attempt = {'id': key, 'sequence': sequence, 'revision': revision, 'index': -1}
                self.answer = {'attempt_id': key, 'text': '', 'reasoning': '', 'status': 'streaming',
                               'turn': frame.get('turn'), 'step': frame.get('step')}
                self._emit('answer.start', answer=copy.deepcopy(self.answer))
                self.last_revision = revision
                return
            current = self.attempt
            if not current or current['id'] != key or sequence <= current['sequence'] or revision <= current['revision']:
                return
            if sequence != current['sequence'] + 1:
                # Missing transport frames cannot be reconstructed as valid live text.
                self.answer = None
                self.attempt = None
                self.timeline.retract(key)
                self._emit('answer.reset', attempt_id=key)
                return
            current.update(sequence=sequence, revision=revision)
            self.last_revision = revision
            index = frame.get('index')
            if not isinstance(index, int) or index <= current['index']:
                return
            current['index'] = index
            if kind == 'delta' and isinstance(frame.get('text'), str):
                text = clean_text(frame['text'], self.secrets, 1000000)
                self.answer['text'] += text
                self.timeline.delta('text', text, self.answer, frame.get('block_index'))
                self._emit('answer.delta', attempt_id=key, text=text, index=index)
            elif kind == 'reasoning' and isinstance(frame.get('text'), str):
                text = clean_text(frame['text'], self.secrets, 1000000)
                self.answer['reasoning'] += text
                self.timeline.delta('reasoning', text, self.answer, frame.get('block_index'))
                self._emit('reasoning.delta', attempt_id=key, text=text, index=index)
            elif kind == 'end':
                outcome = frame.get('outcome') or {}
                settlement = frame.get('settlement') or {}
                committed = (outcome.get('kind') == 'committed'
                             and outcome.get('eventType') == 'assistant/message'
                             and settlement.get('event_type') == 'assistant/message'
                             and outcome.get('seq') == settlement.get('seq')
                             and not settlement.get('interrupted'))
                if committed:
                    self.answer.update(text=clean_text(settlement.get('text', ''), self.secrets, 1000000),
                                       reasoning=clean_text(settlement.get('reasoning', ''), self.secrets, 1000000), status='committed')
                    self.timeline.settle(self.answer, settlement)
                    self._emit('answer.settle', answer=copy.deepcopy(self.answer))
                else:
                    self.answer = None
                    self.timeline.retract(key)
                    self._emit('answer.reset', attempt_id=key)
                self.attempt = None

    def read(self, after=None, timeout=15):
        """Replay retained events, otherwise return an atomic current snapshot."""
        with self.condition:
            if after is not None and after == self.sequence and self.task['status'] not in {'completed', 'failed'}:
                self.condition.wait_for(lambda: self.sequence > after, timeout)
            if after is None or after < 0 or after > self.sequence or (self.events and after < self.events[0]['id'] - 1):
                return [{'id': self.sequence, 'type': 'snapshot', 'task_id': self.task['id'],
                         'conversation_id': self.task['conversation_id'],
                         'task': {**copy.deepcopy(self.task), 'timeline': copy.deepcopy(self.timeline.rows)},
                         'answer': copy.deepcopy(self.answer)}]
            return copy.deepcopy([event for event in self.events if event['id'] > after])

    @property
    def terminal(self):
        with self.condition:
            return self.task['status'] in {'completed', 'failed'}

    def finish_timeline(self, final=''):
        with self.condition:
            self.timeline.finish(final)
            self._emit('timeline')
            return self.timeline.committed()
