import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { PersonalProvider, usePersonal } from './PersonalContext';
import { chatApi } from '../harness/chatApi';
import { visibleMapMessages } from './mapInputs';

vi.mock('../map/SharedMapContext', () => ({ useSharedMap: () => ({ ready: true, service: { getCurrentView: () => ({ bounds: [0,0,1,1] }) } }) }));
const data = owner => ({ enabled: true, login_available: true, user: { owner, email: owner + '@example.test' }, csrf: 'csrf-' + owner,
  connection: { id: 'conn-' + owner, revision: 1, active: true, readable: true, uploadable: false, project: 'test-project', bucket: '' } });
let root, node, status, calls, delayed, resolveData;
function Probe() {
  const value = usePersonal();
  React.useEffect(() => { value.setConversation('chat-' + value.user?.owner); }, [value.user?.owner]);
  return <><button onClick={value.open}>Open data</button><button onClick={value.refresh}>Refresh account</button>
    <output data-testid="selection">{JSON.stringify(value.selected)}</output></>;
}
const tick = async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); }); };
const click = async text => { await act(async () => [...document.querySelectorAll('button')].find(button => button.textContent === text).click()); await tick(); };
beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  status = data('first'); calls = []; delayed = false;
  vi.stubGlobal('fetch', vi.fn(async (url, options = {}) => {
    calls.push({ url, options });
    if (url.endsWith('/status')) return { ok: true, json: async () => status };
    if (url.endsWith('/datasets')) {
      if (delayed) return await new Promise(resolve => { resolveData = resolve; });
      return { ok: true, json: async () => ({ datasets: [{ id: 'input-first', name: 'Private image', asset_id: 'projects/test-project/assets/private', type: 'IMAGE' }] }) };
    }
    if (url.endsWith('/uploads')) return { ok: true, json: async () => ({ uploads: [] }) };
    return { ok: true, json: async () => ({}) };
  }));
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => { await act(async () => root.unmount()); node.remove(); window.history.replaceState(null, '', '/'); vi.unstubAllGlobals(); delete globalThis.IS_REACT_ACT_ENVIRONMENT; });

test('verified data selection is per conversation and switching identity clears private inputs', async () => {
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick();
  await click('Open data'); await tick();
  const checkbox = document.querySelector('input[type=checkbox]');
  await act(async () => checkbox.click());
  expect(node.querySelector('output').textContent).toContain('Private image');
  await chatApi.send({ prompt: 'test', data_refs: ['input-first'] });
  const request = calls.find(row => row.url === '/api/harness/tasks');
  expect(request.options.headers['X-SatGPT-CSRF']).toBe('csrf-first');
  expect(JSON.parse(request.options.body).data_refs).toEqual(['input-first']);
  status = data('second'); await click('Refresh account');
  expect(node.querySelector('output').textContent).toBe('[]');
  expect(document.querySelector('input[type=checkbox]')?.checked).not.toBe(true);
});

test('a delayed old-identity data response cannot populate the new workspace', async () => {
  delayed = true;
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick();
  await click('Open data');
  const finish = resolveData;
  status = data('second'); await click('Refresh account');
  await act(async () => finish({ ok: true, json: async () => ({ datasets: [{ id: 'stale', name: 'Old private data' }] }) }));
  await tick();
  expect(document.body.textContent).not.toContain('Old private data');
});

test('local setup shows the data boundary and sends model configuration with local CSRF', async () => {
  status = { enabled: true, login_available: false, user: null, connection: null, csrf: null,
    local: { mode: 'local', oauth_configured: false, model_configured: false,
      provider: 'deepseek-official', model: 'test-model', base_url: 'https://aihubmix.com/v1' } };
  fetch.mockImplementation(async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, headers: { get: name => name === 'X-SatGPT-Local-CSRF' ? 'local-test-csrf' : null }, json: async () => url.endsWith('/status') ? status : {} };
  });
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick(); await click('Open data');
  expect(document.body.textContent).toContain('this computer');
  expect(document.body.textContent).toContain('sent directly to your selected model service');
  expect(document.body.textContent).toContain('Desktop OAuth client');
  const password = document.querySelector('input[type=password]');
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(password, 'test-local-api-secret');
    password.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => password.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  await tick();
  const request = calls.find(item => item.url === '/api/local/model');
  expect(request.options.headers['X-SatGPT-Local-CSRF']).toBe('local-test-csrf');
  expect(JSON.parse(request.options.body).api_key).toBe('test-local-api-secret');
  expect(document.querySelector('input[type=password]').value).toBe('');
  expect(document.body.textContent).not.toContain('test-local-api-secret');
});

test('local read-only history uses original conversation ids without activation or replay', async () => {
  status = { enabled: true, login_available: false, user: null, connection: null, csrf: null,
    local: { oauth_configured: false, model_configured: false, provider: 'deepseek-official', model: 'test', base_url: 'https://aihubmix.com/v1' } };
  fetch.mockImplementation(async (url, options = {}) => {
    calls.push({ url, options });
    return { ok: true, json: async () => url.endsWith('/status') ? status : url === '/api/local/history' ?
      { conversations: [{ id: 'webgis-original', title: 'Original analysis' }] } : { messages: [{ role: 'assistant', content: 'Preserved original answer' }] } };
  });
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick(); await click('Open data');
  await click('Browse previous history'); await click('Original analysis');
  expect(document.body.textContent).toContain('Preserved original answer');
  expect(calls.some(item => item.url === '/api/local/history/webgis-original')).toBe(true);
  expect(calls.some(item => /activate|reload/.test(item.url))).toBe(false);
});

test('unavailable login keeps a disabled sign-in and retry without exposing operator setup', async () => {
  status = { enabled: false, login_available: false, user: null, connection: null, csrf: null };
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick();
  await click('Open data');
  expect(document.body.textContent).toContain('Google sign-in is temporarily unavailable');
  const login = () => [...document.querySelectorAll('button')].find(button => button.textContent === 'Sign in with Google and connect GEE');
  expect(login().disabled).toBe(true);
  for (const text of ['.env', 'client secret', 'client ID', 'encryption key']) expect(document.body.textContent.toLowerCase()).not.toContain(text.toLowerCase());
  status = { enabled: true, login_available: true, user: null, connection: null, csrf: null };
  await click('Retry');
  expect(login().disabled).toBe(false);
  expect(document.querySelector('input[type=password]')).toBeNull();
});

test('cancelled Google authorization reopens sign-in with retry and preserves other URL parameters', async () => {
  window.history.replaceState(null, '', '/?google=denied&review=echarts#details');
  status = { enabled: true, login_available: true, user: null, connection: null, csrf: null };
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick();
  expect(document.body.textContent).toContain('cancelled or denied');
  expect(document.querySelector('[role=dialog]')).not.toBeNull();
  expect([...document.querySelectorAll('button')].find(button => button.textContent === 'Sign in with Google and connect GEE').disabled).toBe(false);
  expect(window.location.search).toBe('?review=echarts'); expect(window.location.hash).toBe('#details');
});

test('partial authorization reports Google sign-in separately and keeps project verification disabled', async () => {
  window.history.replaceState(null, '', '/?google=connected');
  status = { ...data('partial'), connection: { active: true, revision: 1, readable: false, uploadable: false, project: '', bucket: '' } };
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick();
  expect(document.body.textContent).toContain('You are signed in to Google. Earth Engine read access has not been granted');
  expect(document.body.textContent).not.toContain('Google sign-in and Earth Engine authorization are complete');
  const button = text => [...document.querySelectorAll('button')].find(button => button.textContent === text);
  expect(button('Connect Earth Engine').disabled).toBe(false);
  expect(button('Verify and save').disabled).toBe(true);
});

test('a response from a different cookie workspace cannot enter the current chat state', async () => {
  await act(async () => root.render(<PersonalProvider><Probe /></PersonalProvider>)); await tick();
  fetch.mockImplementationOnce(async () => ({ ok: true, status: 200,
    headers: { get: () => 'second' }, json: async () => ({ messages: ['other account'] }) }));
  await act(async () => { await expect(chatApi.current()).rejects.toThrow('workspace changed'); });
  await tick();
  expect(document.body.textContent).not.toContain('other account');
});

test('disconnect or a different owner hides private historical map layers while preserving system layers', () => {
  const personal = { id: 'private', generation: { analysis_context: { execution: { mode: 'personal', owner: 'first' } } } };
  const system = { id: 'system' }, messages = [{ content: 'History retained', layers: [personal, system] }];
  expect(visibleMapMessages(messages, { active: false, readable: false }, 'first')[0].layers).toEqual([system]);
  expect(visibleMapMessages(messages, { active: true, readable: true }, 'second')[0].layers).toEqual([system]);
  expect(visibleMapMessages(messages, { active: true, readable: true }, 'first')[0].layers).toHaveLength(2);
  expect(messages[0].layers).toHaveLength(2);
});
