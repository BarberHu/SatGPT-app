import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { emptyStream, receiveStream } from './streamState';
import { chatViewModel } from './chatViewModel';
import ChatMessage from './components/ChatMessage';
import { timelinePhases } from './components/RunTimeline';

const event = (id, type, data = {}) => ({ id, type, task_id: 'job', ...data });
const put = row => ({ op: 'put', row });
const row = (id, kind, text, extra = {}) => ({ id, seq: Number(id), kind, text, turn: 1, step: 1, committed: true, ...extra });

test('ordered SSE operations preserve interleaving, results update in place, retry retracts and snapshot restores', () => {
  let state = receiveStream(emptyStream('job'), event(0, 'snapshot', { task: { id: 'job', status: 'running', timeline: [] } }));
  const reason = row('1', 'reasoning', 'first', { committed: false, attempt_id: 'a' });
  state = receiveStream(state, event(1, 'timeline', { timeline_ops: [put(reason)] }));
  state = receiveStream(state, event(2, 'timeline', { timeline_ops: [{ op: 'append', id: '1', text: ' thought' }] }));
  state = receiveStream(state, event(3, 'timeline', { timeline_ops: [put(row('1', 'reasoning', 'First thought.')), put(row('2', 'text', 'Checking.'))] }));
  state = receiveStream(state, event(4, 'timeline', { timeline_ops: [put(row('3', 'tool', '', { call_id: 'tool', name: 'gee_status', status: 'running' }))] }));
  const result = event(5, 'timeline', { timeline_ops: [put(row('3', 'tool', '', { call_id: 'tool', name: 'gee_status', status: 'done', result: 'ok' })), put(row('4', 'reasoning', 'after tool', { step: 2, committed: false }))] });
  state = receiveStream(state, result);
  expect(receiveStream(state, result)).toBe(state);
  expect(state.task.timeline.map(r => r.kind)).toEqual(['reasoning', 'text', 'tool', 'reasoning']);
  expect(state.task.timeline[2].result).toBe('ok');
  expect(timelinePhases(state.task.timeline).map(p => p.rows.map(r => r.kind))).toEqual([['reasoning', 'text', 'tool'], ['reasoning']]);
  const refreshed = receiveStream(emptyStream('job'), event(5, 'snapshot', { task: state.task }));
  expect(refreshed.task.timeline).toEqual(state.task.timeline);
  state = receiveStream(refreshed, event(6, 'answer.reset', { timeline_ops: [{ op: 'remove', ids: ['4'] }] }));
  expect(state.task.timeline.map(r => r.id)).toEqual(['1', '2', '3']);
  state = receiveStream(state, event(7, 'task', { patch: { status: 'completed', output: { message: 'Final.' } } }));
  const message = chatViewModel([], state.task, null).items[0];
  expect(message.text).toBe('Final.');
  expect(message.timeline.find(r => r.kind === 'text').text).toBe('Checking.');
});

test('one run renders phase text between compact thinking/tool rows with a separate final body and working folds', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  const timeline = [row('1', 'reasoning', 'first thought'), row('2', 'text', 'Checking now.'),
    row('3', 'tool', '', { name: 'gee_status', arguments: '{}', result: 'ok', status: 'done' }),
    row('4', 'reasoning', 'second thought', { step: 2 })];
  const message = { role: 'assistant', layers: [], attachments: [], timeline, text: 'Final answer.', pending: true, streaming: true,
    run: { startedAt: new Date(Date.now() - 5000).toISOString(), status: 'running' } };
  try {
    await act(async () => root.render(<ChatMessage message={message} />));
    const runTimeline = node.querySelector('[aria-label="Run timeline"]');
    const summary = runTimeline.querySelector(':scope > summary');
    expect(runTimeline.open).toBe(true);
    expect(summary.querySelector('.agent-assistant-avatar')).not.toBeNull();
    expect(summary.querySelector('.agent-assistant-label').textContent).toBe('SatGPT');
    expect(summary.querySelector('.agent-run-status').textContent).toMatch(/^Running · \d+s$/);
    expect(summary.querySelector(':scope > .agent-chevron')).not.toBeNull();
    expect(summary.querySelector('[data-event-id]')).toBeNull();
    expect(summary.nextElementSibling.classList.contains('agent-run-phases')).toBe(true);
    expect([...node.querySelectorAll('[data-event-id]')].map(n => n.dataset.eventId)).toEqual(['1', '2', '3', '4']);
    expect(node.querySelectorAll('.agent-markdown')).toHaveLength(2);
    expect(node.querySelectorAll('.agent-markdown')[1].textContent).toBe('Final answer.');
    expect(node.textContent.match(/Final answer\./g)).toHaveLength(1);
    expect(node.textContent).toContain('5s');
    const thinking = node.querySelector('[data-kind="reasoning"]');
    expect(thinking.open).toBe(false);
    await act(async () => thinking.querySelector('summary').click());
    expect(thinking.open).toBe(true);
    expect(thinking.querySelector('.agent-thought-text').textContent).toBe('first thought');
    await act(async () => root.render(<ChatMessage message={message} reconnecting />));
    expect(summary.querySelector('.agent-run-status').textContent).toContain('Reconnecting…');
    await act(async () => root.render(<ChatMessage message={{ ...message, pending: false, streaming: false,
      run: { ...message.run, status: 'completed', finishedAt: new Date().toISOString() } }} />));
    expect(runTimeline.open).toBe(false);
    expect(summary.querySelector('.agent-run-status').textContent).toContain('Completed');
    expect(summary.querySelector('.agent-assistant-label').textContent).toBe('SatGPT');

    await act(async () => root.render(<ChatMessage message={{ ...message, pending: false, streaming: false,
      timeline: [], run: {} }} />));
    expect(node.querySelector('[aria-label="Run timeline"]')).toBeNull();
    expect(node.querySelector('.agent-assistant-label').textContent).toBe('SatGPT');
  } finally {
    await act(async () => root.unmount()); node.remove(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('failed replies use Interrupted in the timeline and Incomplete only when the timeline is missing', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  const failure = { id: 'job', status: 'failed', error: 'Unable to finish.' };
  const renderFailure = task => act(async () => {
    const [message] = chatViewModel([], task, null).items;
    root.render(<ChatMessage message={message} reconnecting />);
  });
  try {
    await renderFailure({ ...failure, started_at: '2026-11-20T00:00:00Z', finished_at: '2026-11-20T00:00:03Z',
      timeline: [row('1', 'reasoning', 'Checking data.')] });
    const summary = node.querySelector('.agent-run-timeline > summary');
    expect(summary.querySelector('.agent-assistant-label').textContent).toBe('SatGPT');
    expect(summary.querySelector('.agent-run-status').textContent).toBe('Interrupted · 3s');
    expect(node.querySelector('.agent-failure')).toBeNull();
    expect(node.querySelector('.agent-markdown').textContent).toBe(failure.error);

    await renderFailure(failure);
    expect(node.querySelector('.agent-run-timeline')).toBeNull();
    expect(node.querySelector('.agent-assistant-label .agent-failure').textContent).toBe('Incomplete');
    expect(node.querySelector('.agent-markdown').textContent).toBe(failure.error);
  } finally {
    await act(async () => root.unmount()); node.remove(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
