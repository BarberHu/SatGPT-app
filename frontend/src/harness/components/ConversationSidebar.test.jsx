import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ConversationSidebar from './ConversationSidebar';
import { useAgentChat } from '../hooks/useAgentChat';
import { chatApi } from '../chatApi';

vi.mock('../chatApi', () => ({ chatApi: {
  current: vi.fn(), get: vi.fn(), list: vi.fn(), subscribe: vi.fn(),
} }));

let root, node;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  vi.resetAllMocks();
  localStorage.clear();
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); vi.useRealTimers();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

function Probe({ visible = true }) {
  const chat = useAgentChat({ visible });
  return <ConversationSidebar conversations={chat.conversations} currentId={chat.conversationId} onSelect={() => {}} />;
}
const row = id => node.querySelector(`[title="${id}"]`);

test('history is text-only; work uses spinners and only unread non-current chats have dots', async () => {
  const onSelect = vi.fn();
  await act(async () => root.render(<ConversationSidebar currentId="old" onSelect={onSelect}
    conversations={[{ id: 'old', title: 'History', unread: true }, { id: 'live', title: 'Running chat', task_status: 'running' },
      { id: 'waiting', title: 'Waiting chat', task_status: 'queued' }, { id: 'unread', title: 'New answer', unread: true }]} />));
  expect(row('History').querySelector('svg, i, [role=status]')).toBeNull();
  expect(row('History').getAttribute('aria-current')).toBe('page');
  expect(row('Running chat').querySelector('.agent-spin')).not.toBeNull();
  expect(row('Waiting chat').querySelector('.agent-spin')).not.toBeNull();
  expect(row('Running chat').querySelector('[role=status]').textContent).toBe('');
  expect(row('Waiting chat').querySelector('[role=status]').textContent).toBe('');
  expect(row('New answer').querySelector('[aria-label="Unread response"]')).not.toBeNull();
  await act(async () => row('Running chat').click());
  expect(onSelect).toHaveBeenCalledWith('live');
});

test('background completion refreshes the badge without switching chats and stops polling when idle', async () => {
  let status = 'running';
  chatApi.current.mockResolvedValue({ conversation_id: 'webgis-two', messages: [], active_task: null });
  chatApi.list.mockImplementation(async () => ({ conversations: [
    { id: 'webgis-one', title: 'Background', task_status: status === 'running' ? status : null,
      latest_task: { id: 'background-job', status } }, { id: 'webgis-two', title: 'Current' },
  ] }));
  await act(async () => root.render(<Probe />));
  expect(row('Background').querySelector('.agent-spin')).not.toBeNull();
  expect(row('Current').getAttribute('aria-current')).toBe('page');
  status = 'completed';
  await act(async () => vi.advanceTimersByTimeAsync(3000));
  expect(row('Background').querySelector('.agent-spin')).toBeNull();
  expect(row('Background').querySelector('[aria-label="Unread response"]')).not.toBeNull();
  expect(row('Current').getAttribute('aria-current')).toBe('page');
  expect(chatApi.list).toHaveBeenCalledTimes(2);
  await act(async () => root.render(null));
  await act(async () => root.render(<Probe />));
  expect(row('Background').querySelector('[aria-label="Unread response"]')).not.toBeNull();
  chatApi.current.mockResolvedValue({ conversation_id: 'webgis-one', messages: [
    { id: 'reply', role: 'assistant', job_id: 'background-job', content: 'Done' },
  ], active_task: null });
  await act(async () => root.render(null));
  await act(async () => root.render(<Probe />));
  expect(row('Background').querySelector('[role=status]')).toBeNull();
  expect(JSON.parse(localStorage.getItem('satgpt:harness:conversation-activity'))['webgis-one'].seen).toBe(true);
  await act(async () => vi.advanceTimersByTimeAsync(9000));
  expect(chatApi.list).toHaveBeenCalledTimes(4);
});

test('a hidden Agent panel does not mark its completed response as viewed', async () => {
  localStorage.setItem('satgpt:harness:conversation-activity', JSON.stringify({
    'webgis-one': { taskId: 'job', status: 'running', seen: false },
  }));
  chatApi.current.mockResolvedValue({ conversation_id: 'webgis-one', active_task: null,
    messages: [{ role: 'assistant', job_id: 'job', content: 'Done' }] });
  chatApi.list.mockResolvedValue({ conversations: [{ id: 'webgis-one', title: 'Current',
    latest_task: { id: 'job', status: 'completed' } }] });
  await act(async () => root.render(<Probe visible={false} />));
  expect(row('Current').querySelector('[role=status]')).toBeNull();
  expect(JSON.parse(localStorage.getItem('satgpt:harness:conversation-activity'))['webgis-one'].seen).toBe(false);
  await act(async () => root.render(<Probe visible />));
  expect(JSON.parse(localStorage.getItem('satgpt:harness:conversation-activity'))['webgis-one'].seen).toBe(true);
});

test.each(['completed', 'failed', 'cancelled'])('current task %s clears the badge immediately despite a stale list', async status => {
  const conversation = { conversation_id: 'webgis-one', messages: [], active_task: 'job' };
  const listed = { conversations: [{ id: 'webgis-one', title: 'Current', task_status: 'running' }] };
  const source = { close: vi.fn() };
  chatApi.current.mockResolvedValue(conversation);
  chatApi.get.mockResolvedValue(conversation);
  chatApi.list.mockResolvedValue(listed);
  chatApi.subscribe.mockReturnValue(source);
  await act(async () => root.render(<Probe />));
  expect(row('Current').querySelector('[role=status]').getAttribute('aria-label')).toBe('Queued');
  const emit = (id, taskStatus) => source.onmessage({ data: JSON.stringify({ id, type: 'snapshot', task_id: 'job',
    task: { id: 'job', conversation_id: 'webgis-one', status: taskStatus }, answer: null }) });
  await act(async () => emit(1, 'running'));
  expect(row('Current').querySelector('[role=status]').getAttribute('aria-label')).toBe('Running');
  await act(async () => source.onerror());
  expect(row('Current').querySelector('[role=status]').getAttribute('aria-label')).toBe('Running');
  let resolve;
  chatApi.list.mockImplementationOnce(() => new Promise(done => { resolve = done; }));
  let settlement;
  await act(async () => { settlement = emit(2, status); });
  expect(row('Current').querySelector('[role=status]')).toBeNull();
  await act(async () => { resolve(listed); await settlement; });
  expect(row('Current').querySelector('[role=status]')).toBeNull();
  expect(source.close).toHaveBeenCalled();
});
