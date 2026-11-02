import { readFileSync } from 'node:fs';
import http from 'node:http';

export const name = 'satgpt-assistant-stream';

/** Presentation only: never write to the SDK's JSON-RPC stdout. */
export function apply(ctx) {
  const endpoint = process.env.SATGPT_STREAM_ENDPOINT;
  const token = process.env.SATGPT_STREAM_TOKEN;
  const bindingFile = process.env.SATGPT_STREAM_BINDING;
  if (!endpoint || !token || !bindingFile) return;
  const target = new URL(endpoint);
  if (target.protocol !== 'http:' || target.hostname !== '127.0.0.1') throw new Error('Stream bridge must use loopback');
  const transport = new http.Agent({ keepAlive: true, maxSockets: 1 });
  const active = new Map();
  const runs = new Map();
  let queue = Promise.resolve();
  let pending = [];
  let timer;
  let disposed = false;
  const getRun = sessionId => {
    let binding;
    try { binding = JSON.parse(readFileSync(bindingFile, 'utf8')); } catch { return null; }
    if (binding.session_id !== sessionId) return null;
    let run = runs.get(sessionId);
    if (run?.binding.run_id !== binding.run_id) {
      run = { binding, order: 0, sequence: 0 };
      runs.set(sessionId, run);
    }
    return run;
  };
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!pending.length) return;
    const batch = pending;
    pending = [];
    queue = queue.then(() => new Promise(resolve => {
      if (disposed) return resolve();
      const body = JSON.stringify(batch);
      const request = http.request(target, {
        method: 'POST', agent: transport, timeout: 2000,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body) },
      }, response => { response.resume(); response.on('end', resolve); });
      request.on('error', resolve);
      request.on('timeout', () => request.destroy());
      request.end(body);
    })).catch(() => {});
  };
  const send = (attempt, event) => {
    const run = attempt.run || attempt;
    pending.push({ ...run.binding, event_sequence: ++run.order,
      ...(event.type !== 'session' ? { sequence: ++attempt.sequence } : {}), ...event });
    if (pending.length >= 32 || event.type === 'end') flush();
    else if (!timer) timer = setTimeout(flush, 20);
  };
  ctx.on('agent/assistant-stream', ({ agent, frame }) => {
    const sessionId = String(agent.session.id);
    if (frame.type === 'start') {
      const run = getRun(sessionId);
      if (!run) return;
      const attempt = { run, sequence: 0, attemptId: frame.attemptId,
        turn: frame.turn, step: frame.step, settlement: null };
      run.lastAttemptId = frame.attemptId;
      active.set(sessionId, attempt);
      send(attempt, { type: 'start', attempt_id: frame.attemptId, revision: frame.revision,
        turn: frame.turn, step: frame.step });
      return;
    }
    const attempt = active.get(sessionId);
    if (!attempt || attempt.attemptId !== frame.attemptId) return;
    if (frame.type === 'chunk') {
      // Reasoning has its own presentation channel; tool arguments stay private.
      if (['text-delta', 'reasoning-delta'].includes(frame.chunk.type) && frame.chunk.text) {
        send(attempt, { type: frame.chunk.type === 'text-delta' ? 'delta' : 'reasoning', attempt_id: frame.attemptId,
          revision: frame.revision, index: frame.index, block_index: frame.chunk.index,
          turn: frame.turn, step: frame.step, text: frame.chunk.text });
      }
    } else if (frame.type === 'end') {
      send(attempt, { type: 'end', attempt_id: frame.attemptId, revision: frame.revision,
        index: frame.index, outcome: frame.outcome, settlement: attempt.settlement });
      active.delete(sessionId);
    }
  });
  ctx.on('session/event', (session, event) => {
    const sessionId = String(session.id);
    const run = getRun(sessionId);
    if (!run) return;
    if (['turn/start', 'step/start', 'tool/call', 'tool/result', 'llm/retry', 'step/end'].includes(event.type)) {
      send(run, { type: 'session', event, attempt_id: run.lastAttemptId });
    }
    if (event.type === 'turn/end') {
      send(run, { type: 'drained' }); flush(); runs.delete(sessionId);
      return;
    }
    const attempt = active.get(String(session.id));
    if (!attempt || !['assistant/message', 'assistant/attempt'].includes(event.type)) return;
    if (event.data.turn !== attempt.turn || event.data.step !== attempt.step) return;
    attempt.settlement = { seq: event.seq, event_type: event.type,
      blocks: (event.data.message?.content || []).map((block, index) => ({ ...block, index }))
        .filter(block => ['text', 'reasoning'].includes(block.type)),
      interrupted: Boolean(event.data.interrupted),
      text: event.type === 'assistant/message'
        ? (event.data.message?.content || []).filter(block => block.type === 'text').map(block => block.text).join('') : '',
      reasoning: event.type === 'assistant/message'
        ? (event.data.message?.content || []).filter(block => block.type === 'reasoning').map(block => block.text).join('') : '' };
  });
  ctx.on('dispose', () => {
    disposed = true;
    clearTimeout(timer);
    transport.destroy();
    active.clear();
    runs.clear();
    pending = [];
  });
}
