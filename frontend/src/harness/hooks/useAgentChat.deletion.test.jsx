import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { useAgentChat } from './useAgentChat';
import { chatApi } from '../chatApi';

vi.mock('../chatApi', () => ({ chatApi: {
  current: vi.fn(), list: vi.fn(), remove: vi.fn(), activate: vi.fn(), subscribe: vi.fn(), send: vi.fn(),
} }));

let root, node, chat;
const current = { conversation_id: 'webgis-current', messages: [{ role: 'user', content: 'Keep this' }], active_task: null };
const rows = [{ id: 'webgis-current', title: 'Current' }, { id: 'webgis-old', title: 'Old' }];
function Probe() { chat = useAgentChat(); return null; }
beforeEach(async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks(); localStorage.clear();
  chatApi.current.mockResolvedValue(current);
  chatApi.list.mockResolvedValue({ conversations: rows });
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

test('deleting a background chat keeps current messages and SSE, removes its unread marker and rejects stale lists', async () => {
  localStorage.setItem('satgpt:harness:conversation-activity', JSON.stringify({
    'webgis-old': { taskId: 'old-job', status: 'completed', seen: false },
  }));
  chatApi.current.mockResolvedValue({ ...current, active_task: 'live' });
  const stream = { close: vi.fn() }; chatApi.subscribe.mockReturnValue(stream);
  await act(async () => root.render(<Probe />));
  let finishList;
  chatApi.list.mockImplementationOnce(() => new Promise(resolve => { finishList = resolve; }));
  // A terminal SSE event starts a list request before deletion completes.
  chatApi.get = vi.fn().mockResolvedValue(current);
  let event;
  await act(async () => {
    event = stream.onmessage({ data: JSON.stringify({ id: 1, type: 'snapshot', task_id: 'live',
      task: { id: 'live', status: 'completed' }, answer: null }) });
  });
  const closes = stream.close.mock.calls.length;
  chatApi.remove.mockResolvedValue({ deleted_id: 'webgis-old', conversation: current, conversations: [rows[0]] });
  await act(async () => expect(await chat.deleteConversation('webgis-old')).toBe(true));
  expect(chat.conversationId).toBe(current.conversation_id);
  expect(chat.messages).toEqual(current.messages);
  expect(stream.close).toHaveBeenCalledTimes(closes);
  await act(async () => { finishList({ conversations: rows }); await event; });
  expect(chat.conversations.map(row => row.id)).toEqual(['webgis-current']);
  expect(JSON.parse(localStorage.getItem('satgpt:harness:conversation-activity'))['webgis-old']).toBeUndefined();
});

test('background deletion leaves an actively streaming current chat connected', async () => {
  const stream = { close: vi.fn() };
  chatApi.current.mockResolvedValue({ ...current, active_task: 'live' });
  chatApi.subscribe.mockReturnValue(stream);
  await act(async () => root.render(<Probe />));
  chatApi.remove.mockResolvedValue({ conversation: current, conversations: [rows[0]] });
  await act(async () => chat.deleteConversation('webgis-old'));
  expect(stream.close).not.toHaveBeenCalled();
  expect(chat.busy).toBe(true);
  expect(chat.conversationId).toBe('webgis-current');
});

test('current deletion adopts fresh state, prevents duplicate requests, navigation and sending', async () => {
  await act(async () => root.render(<Probe />));
  let finish;
  chatApi.remove.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  let deletion;
  await act(async () => {
    deletion = chat.deleteConversation('webgis-current');
    expect(await chat.deleteConversation('webgis-current')).toBe(false);
    expect(await chat.changeConversation('webgis-old')).toBe(false);
    expect(await chat.send('Another prompt', [0, 0, 1, 1])).toBe(false);
  });
  expect(chat.deleting).toBe(true);
  expect(chatApi.remove).toHaveBeenCalledTimes(1);
  expect(chatApi.activate).not.toHaveBeenCalled();
  expect(chatApi.send).not.toHaveBeenCalled();
  const fresh = { conversation_id: 'webgis-fresh', messages: [], active_task: null };
  await act(async () => {
    finish({ conversation: fresh, conversations: [{ id: 'webgis-fresh', title: 'New chat' }, rows[1]] });
    expect(await deletion).toBe(true);
  });
  expect(chat.conversationId).toBe('webgis-fresh');
  expect(chat.messages).toEqual([]);
  expect(chat.deleting).toBe(false);
});

test('server rejection keeps current messages and list intact and allows retry', async () => {
  await act(async () => root.render(<Probe />));
  chatApi.remove.mockRejectedValueOnce(new Error('This conversation is busy.'));
  await act(async () => expect(await chat.deleteConversation('webgis-current')).toBe(false));
  expect(chat.error).toBe('This conversation is busy.');
  expect(chat.messages).toEqual(current.messages);
  expect(chat.conversations.map(row => row.id)).toEqual(rows.map(row => row.id));
  expect(chat.deleting).toBe(false);
  chatApi.remove.mockResolvedValue({ conversation: current, conversations: [rows[0]] });
  await act(async () => expect(await chat.deleteConversation('webgis-old')).toBe(true));
});
