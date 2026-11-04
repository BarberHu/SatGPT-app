import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { apply } from '../integrations/assistant-stream/index.js';

test('live plugin forwards ordered reasoning and text deltas before settlement and preserves attempts', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'satgpt-stream-'));
  const batches = [];
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer test-token');
    let body = '';
    for await (const chunk of req) body += chunk;
    batches.push(...JSON.parse(body));
    res.writeHead(204).end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const oldEnv = { ...process.env };
  const listeners = new Map();
  const session = { id: 'root' };
  const agent = { session };
  const binding = path.join(folder, 'binding.json');
  await fs.writeFile(binding, JSON.stringify({ session_id: 'root', run_id: 'run-1' }));
  Object.assign(process.env, { SATGPT_STREAM_ENDPOINT: `http://127.0.0.1:${server.address().port}/frames`,
    SATGPT_STREAM_TOKEN: 'test-token', SATGPT_STREAM_BINDING: binding });
  const emit = frame => listeners.get('agent/assistant-stream')({ agent, frame });
  try {
    apply({ on: (name, callback) => listeners.set(name, callback) });
    emit({ type: 'start', attemptId: 'root:1', revision: 1, turn: 1, step: 1 });
    emit({ type: 'chunk', attemptId: 'root:1', revision: 2, index: 0, chunk: { type: 'reasoning-delta', text: 'MODEL_THOUGHT' } });
    emit({ type: 'chunk', attemptId: 'root:1', revision: 3, index: 1, chunk: { type: 'tool-call-delta', arguments: 'ARGS' } });
    emit({ type: 'chunk', attemptId: 'root:1', revision: 4, index: 2, chunk: { type: 'text-delta', text: 'Hello ' } });
    for (let n = 0; n < 100 && !batches.some(x => x.type === 'delta'); n++) await new Promise(r => setTimeout(r, 10));
    assert.equal(batches.at(-1).text, 'Hello '); // observed while no committed message exists
    listeners.get('session/event')(session, { type: 'assistant/attempt', seq: 8, data: { turn: 1, step: 1 } });
    emit({ type: 'end', attemptId: 'root:1', revision: 5, index: 3,
      outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 8 } });
    emit({ type: 'start', attemptId: 'root:2', revision: 6, turn: 1, step: 1 });
    emit({ type: 'chunk', attemptId: 'root:2', revision: 7, index: 0, chunk: { type: 'text-delta', text: 'World' } });
    listeners.get('session/event')(session, { type: 'assistant/message', seq: 9,
      data: { turn: 1, step: 1, message: { content: [{ type: 'reasoning', text: 'MODEL_THOUGHT' }, { type: 'text', text: 'World!' }] } } });
    emit({ type: 'end', attemptId: 'root:2', revision: 8, index: 1,
      outcome: { kind: 'committed', eventType: 'assistant/message', seq: 9 } });
    listeners.get('session/event')(session, { type: 'tool/call', seq: 10,
      data: { turn: 1, step: 1, callId: 'call-1', name: 'gee_status', arguments: '{}' } });
    listeners.get('session/event')(session, { type: 'tool/result', seq: 11,
      data: { turn: 1, step: 1, message: { toolCallId: 'call-1', content: [{ type: 'text', text: 'ok' }] } } });
    listeners.get('session/event')(session, { type: 'turn/end' });
    for (let n = 0; n < 100 && !batches.some(x => x.type === 'drained'); n++) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(batches.map(x => x.type), ['start', 'reasoning', 'delta', 'end', 'start', 'delta', 'end', 'session', 'session', 'drained']);
    assert.equal(batches[6].settlement.text, 'World!');
    assert.equal(batches[1].text, 'MODEL_THOUGHT');
    assert.equal(batches[7].event.data.callId, batches[8].event.data.message.toolCallId);
    assert.equal(batches[7].attempt_id, 'root:2');
    assert.deepEqual(batches.map(x => x.event_sequence), batches.map((_, i) => i + 1));
    assert.equal(batches[3].outcome.eventType, 'assistant/attempt');
    assert.ok(batches.every(x => x.session_id === 'root' && x.run_id === 'run-1'));
    assert.doesNotMatch(JSON.stringify(batches), /ARGS/);
    listeners.get('agent/assistant-stream')({ agent: { session: { id: 'other' } },
      frame: { type: 'start', attemptId: 'other:1', revision: 1 } });
  } finally {
    listeners.get('dispose')?.();
    for (const key of ['SATGPT_STREAM_ENDPOINT', 'SATGPT_STREAM_TOKEN', 'SATGPT_STREAM_BINDING']) {
      if (oldEnv[key] === undefined) delete process.env[key]; else process.env[key] = oldEnv[key];
    }
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await fs.unlink(binding);
    await fs.rmdir(folder);
  }
});
