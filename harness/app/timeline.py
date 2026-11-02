"""Ordered presentation projection. Only settled rows may enter chat history."""

from __future__ import annotations

import copy
from .trace import clean_text


class Timeline:
    def __init__(self, secrets=()):
        self.rows = []
        self.counter = 0
        self.operations = []
        self.turn = self.step = None
        self.secrets = secrets

    def put(self, row):
        self.operations.append({'op': 'put', 'row': copy.deepcopy(row)})

    def add(self, kind, **data):
        self.counter += 1
        row = dict(id=f'event-{self.counter}', seq=self.counter, kind=kind,
                   turn=self.turn, step=self.step, committed=True)
        row.update(data)
        self.rows.append(row)
        self.put(row)
        return row

    def remove(self, rows):
        ids = {row['id'] for row in rows}
        self.rows = [row for row in self.rows if row['id'] not in ids]
        if ids:
            self.operations.append({'op': 'remove', 'ids': sorted(ids)})

    def retract(self, attempt_id=None):
        self.remove([row for row in self.rows if not row['committed']
                     and (attempt_id is None or row.get('attempt_id') == attempt_id)])

    def delta(self, kind, text, answer, block_index=None):
        self.turn, self.step = answer.get('turn'), answer.get('step')
        last = self.rows[-1] if self.rows else None
        if (last and last['kind'] == kind and not last['committed']
                and last.get('attempt_id') == answer['attempt_id']
                and last.get('block_index') == block_index):
            last['text'] += text
            self.operations.append({'op': 'append', 'id': last['id'], 'text': text})
        else:
            self.add(kind, text=text, attempt_id=answer['attempt_id'],
                     block_index=block_index, committed=False)

    def settle(self, answer, settlement):
        rows = [row for row in self.rows if row.get('attempt_id') == answer['attempt_id']]
        # Canonical content replaces provisional content in place. A block index
        # belongs to the model content stream, not to the transport frame index.
        for kind, field in [('reasoning', 'reasoning'), ('text', 'text')]:
            matching = [row for row in rows if row['kind'] == kind]
            canonical = answer.get(field, '')
            if len(matching) == 1:
                matching[0]['text'] = canonical
            elif not matching and canonical:
                rows.append(self.add(kind, text=canonical, attempt_id=answer['attempt_id']))
        for row in rows:
            block = next((block for block in settlement.get('blocks', [])
                          if block.get('index') == row.get('block_index')
                          and block.get('type') == row['kind']), None)
            peers = [other for other in rows if other['kind'] == row['kind']
                     and other.get('block_index') == row.get('block_index')]
            if block and len(peers) == 1:
                row['text'] = clean_text(block.get('text', ''), self.secrets, 1000000)
            row.update(committed=True, session_seq=settlement.get('seq'))
            self.put(row)

    def session(self, event, attempt_id=None):
        kind, data = event.get('type'), event.get('data') or {}
        self.turn = data.get('turn', self.turn)
        self.step = data.get('step', self.step)
        metadata = {'session_seq': event.get('seq'), 'attempt_id': attempt_id}
        if kind == 'tool/call':
            call_id = str(data.get('callId') or '')
            if any(row.get('call_id') == call_id for row in self.rows if row['kind'] == 'tool'):
                return
            self.add('tool', call_id=call_id,
                     name=clean_text(data.get('name') or '工具', self.secrets, 120),
                     arguments=clean_text(data.get('arguments') or '', self.secrets),
                     result='', status='running', **metadata)
        elif kind == 'tool/result':
            message = data.get('message') or {}
            call_id = str(message.get('toolCallId') or (message.get('source') or {}).get('callId') or '')
            row = next((row for row in self.rows if row.get('call_id') == call_id and row['kind'] == 'tool'), None)
            if row is None:
                row = self.add('tool', call_id=call_id, name='工具', arguments='', **metadata)
            text = '\n'.join(block.get('text', '') for block in message.get('content', []) if block.get('type') == 'text')
            row.update(result=clean_text(text, self.secrets), status='error' if message.get('isError') else 'done',
                       result_session_seq=event.get('seq'))
            self.put(row)
        elif kind == 'llm/retry':
            self.retract()
            self.add('status', text='正在重试', **metadata)

    def finish(self, final=''):
        self.retract()
        # Only the last user-visible text is the final response; identical earlier
        # phase messages are retained in their original positions.
        last = self.rows[-1] if self.rows else None
        if last and last['kind'] in {'text', 'reasoning'} and last.get('attempt_id'):
            final_rows = [row for row in self.rows if row['kind'] == 'text'
                          and row.get('attempt_id') == last['attempt_id']]
            if ''.join(row.get('text', '') for row in final_rows).strip() == final.strip():
                self.remove(final_rows)
        for row in self.rows:
            if row.get('status') == 'running':
                row['status'] = 'unknown'
                self.put(row)

    def drain(self):
        operations, self.operations = self.operations, []
        return operations

    def committed(self):
        return copy.deepcopy([row for row in self.rows if row['committed']])
