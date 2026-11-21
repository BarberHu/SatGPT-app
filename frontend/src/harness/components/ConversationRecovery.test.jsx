import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { chatApi } from '../chatApi';
import ConversationRecovery from './ConversationRecovery';

vi.mock('../chatApi', () => ({ chatApi: {
  recoveryStatus: vi.fn(), createRecoveryRequest: vi.fn(), claimRecovery: vi.fn(), issueRecoveryProof: vi.fn(),
} }));

let node, root;
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  vi.resetAllMocks();
  node = document.createElement('div');
  document.body.appendChild(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

async function click(label) {
  const button = [...document.querySelectorAll('button')].find(item => item.textContent.trim() === label);
  expect(button).toBeDefined();
  await act(async () => button.click());
}

test('a new browser checks approval and refreshes history after claiming the bound request', async () => {
  const onRecovered = vi.fn().mockResolvedValue(undefined);
  chatApi.recoveryStatus.mockResolvedValueOnce({ status: 'none' })
    .mockResolvedValueOnce({ status: 'approved', request_id: 'test-request', count: 2 });
  chatApi.createRecoveryRequest.mockResolvedValue({ status: 'pending', request_id: 'test-request', code: 'test-request-code' });
  chatApi.claimRecovery.mockResolvedValue({ count: 2 });
  await act(async () => root.render(<ConversationRecovery onRecovered={onRecovered} />));
  await click('Conversation recovery');
  await click('Create request code');
  expect(document.querySelector('input').value).toBe('test-request-code');
  expect(chatApi.claimRecovery).not.toHaveBeenCalled();
  await click('Check approval');
  await click('Recover approved conversations');
  expect(chatApi.claimRecovery).toHaveBeenCalledWith('test-request');
  expect(onRecovered).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="status"]').textContent).toContain('2 conversation(s) restored');
  expect(document.querySelector('input')).toBeNull();
});

test('the credential is scoped to the conversation open in the original browser', async () => {
  chatApi.recoveryStatus.mockResolvedValue({ status: 'none' });
  chatApi.issueRecoveryProof.mockResolvedValue({ code: 'test-existing-conversation-proof' });
  await act(async () => root.render(<ConversationRecovery currentId="webgis-example" />));
  await click('Conversation recovery');
  await click('Generate recovery credential');
  expect(chatApi.issueRecoveryProof).toHaveBeenCalledWith('webgis-example');
  expect([...document.querySelectorAll('input')].map(input => input.value))
    .toEqual(['webgis-example', 'test-existing-conversation-proof']);
});
