import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { emptyStream, receiveStream } from './streamState';
import ChatMessage from './components/ChatMessage';
import { chatViewModel } from './chatViewModel';

const event = (id, type, data = {}) => ({ id, type, task_id: 'job', conversation_id: 'chat', ...data });
const snapshot = () => event(0, 'snapshot', { task: { id: 'job', status: 'running', timeline: [] }, answer: null });
const put = row => ({ op: 'put', row });

test('incremental body is visible before completion and canonical content replaces it once', async () => {
  let state = receiveStream(emptyStream('job'), snapshot());
  state = receiveStream(state, event(1, 'answer.start', { answer: { attempt_id: 'a', text: '', status: 'streaming' } }));
  state = receiveStream(state, event(2, 'answer.delta', { attempt_id: 'a', text: 'First ', timeline_ops: [put({
    id: 'text-a', seq: 1, kind: 'text', text: 'First ', attempt_id: 'a', committed: false,
  })] }));
  state = receiveStream(state, event(3, 'answer.delta', { attempt_id: 'a', text: 'words',
    timeline_ops: [{ op: 'append', id: 'text-a', text: 'words' }] }));
  expect(state.answer.text).toBe('First words');
  expect(state.task.status).toBe('running');
  expect(receiveStream(state, event(3, 'answer.delta', { attempt_id: 'a', text: 'words' }))).toBe(state);
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const node = document.createElement('div');
  const root = createRoot(node);
  const render = async (messages = []) => act(async () => root.render(<>{chatViewModel(messages, state.task, state.answer).items.map(message =>
    <ChatMessage key={message.id} message={message} onFocusLayer={() => {}} />)}</>));
  try {
    await render();
    expect(node.textContent).toContain('First words');
    state = receiveStream(state, event(4, 'answer.settle', { answer: { attempt_id: 'a', text: 'Canonical answer', status: 'committed' },
      timeline_ops: [put({ id: 'text-a', seq: 1, kind: 'text', text: 'Canonical answer', attempt_id: 'a', committed: true })] }));
    await render();
    expect(node.textContent).toContain('Canonical answer');
    expect(node.textContent).not.toContain('First words');
    state = receiveStream(state, event(5, 'timeline', { timeline_ops: [{ op: 'remove', ids: ['text-a'] }] }));
    await render();
    expect(node.textContent.match(/Canonical answer/g)).toHaveLength(1);
    state = receiveStream(state, event(6, 'task', { patch: { status: 'completed', timeline: [], output: { message: 'Canonical answer' } } }));
    await render();
    expect(node.textContent.match(/Canonical answer/g)).toHaveLength(1);
    await render([{ id: 'final', role: 'assistant', job_id: 'job', content: 'Canonical answer' }]);
    expect(node.textContent.match(/Canonical answer/g)).toHaveLength(1);
  } finally {
    await act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('an earlier confirmed reply remains when it happens to match the final answer', () => {
  const [message] = chatViewModel([{ id: 'final', role: 'assistant', job_id: 'job', status: 'completed',
    content: 'Result available.', timeline: [{ id: 'earlier', kind: 'text', text: 'Result available.',
      attempt_id: 'earlier-attempt', committed: true }] }], null, null).items;
  expect(message.replyParts.map(part => [part.id, part.text])).toEqual([['earlier', 'Result available.']]);
  expect(message.text).toBe('Result available.');
});

test('retry, interruption and task isolation retract temporary answers', () => {
  let state = receiveStream(emptyStream('job'), snapshot());
  state = receiveStream(state, event(1, 'answer.start', { answer: { attempt_id: 'a', text: 'discard' } }));
  state = receiveStream(state, event(2, 'answer.reset', { attempt_id: 'a' }));
  expect(state.answer).toBeNull();
  state = receiveStream(state, event(3, 'answer.start', { answer: { attempt_id: 'b', text: '' } }));
  state = receiveStream(state, event(4, 'answer.delta', { attempt_id: 'a', text: 'late' }));
  expect(state.answer.text).toBe('');
  expect(receiveStream(state, { ...event(5, 'answer.delta', { attempt_id: 'b', text: 'foreign' }), task_id: 'other' })).toBe(state);
  expect(receiveStream(state, event(6, 'answer.delta', { attempt_id: 'b', text: 'out of order' }))).toBe(state);
  state = receiveStream(state, event(5, 'task', { patch: { status: 'failed' } }));
  expect(state.answer).toBeNull();
});

test('refresh and compacted replay restore one snapshot, replayed IDs never duplicate text', () => {
  const geometry = { type: 'Polygon', coordinates: [[[113.6, 34.7], [113.64, 34.7], [113.62, 34.74], [113.6, 34.7]]] };
  const restored = event(40, 'snapshot', { task: { id: 'job', status: 'running', timeline: [], analysis_region: geometry },
    answer: { attempt_id: 'a', text: 'restored ', status: 'streaming' } });
  let state = receiveStream(emptyStream('job'), restored);
  state = receiveStream(state, event(41, 'answer.delta', { attempt_id: 'a', text: 'tail' }));
  state = receiveStream(state, event(41, 'answer.delta', { attempt_id: 'a', text: 'tail' }));
  expect(state.answer.text).toBe('restored tail');
  state = receiveStream(state, event(80, 'snapshot', { task: state.task,
    answer: { attempt_id: 'b', text: 'recovered', status: 'committed' } }));
  expect(state.answer.text).toBe('recovered');
  state = receiveStream(state, event(81, 'task', { patch: { status: 'completed', output: { message: 'Scoped answer' } } }));
  expect(state.answer).toBeNull();
  expect(state.task.analysis_region).toEqual(geometry);
  expect(state.task.output.message).toBe('Scoped answer');
});

test('reasoning deltas stream separately, reconnect once, and disappear on retry', () => {
  let state = receiveStream(emptyStream('job'), snapshot());
  state = receiveStream(state, event(1, 'answer.start', { answer: {
    attempt_id: 'a', text: '', reasoning: '', turn: 1, step: 1, status: 'streaming',
  } }));
  state = receiveStream(state, event(2, 'reasoning.delta', { attempt_id: 'a', text: 'think ', timeline_ops: [put({
    id: 'reason-a', seq: 1, kind: 'reasoning', text: 'think ', attempt_id: 'a', committed: false,
  })] }));
  state = receiveStream(state, event(3, 'reasoning.delta', { attempt_id: 'a', text: 'again',
    timeline_ops: [{ op: 'append', id: 'reason-a', text: 'again' }] }));
  state = receiveStream(state, event(3, 'reasoning.delta', { attempt_id: 'a', text: 'again' }));
  expect(state.answer.reasoning).toBe('think again');
  expect(state.answer.text).toBe('');
  expect(chatViewModel([], state.task, state.answer).items[0].timeline[0].text).toBe('think again');
  state = receiveStream(state, event(4, 'answer.reset', { attempt_id: 'a',
    timeline_ops: [{ op: 'remove', ids: ['reason-a'] }] }));
  expect(chatViewModel([], state.task, state.answer).items[0].timeline).toEqual([]);
  state = receiveStream(state, event(5, 'answer.start', { answer: {
    attempt_id: 'b', text: '', reasoning: 'new', turn: 1, step: 1, status: 'streaming',
  } }));
  state = receiveStream(state, event(6, 'reasoning.delta', { attempt_id: 'a', text: 'stale' }));
  expect(state.answer.reasoning).toBe('new');
});
