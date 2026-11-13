import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import ModeRoot from '../ModeRoot';
import { FakeMap } from '../map/tests/fakeMap';

vi.mock('mapbox-gl', async () => {
  const { FakeMap } = await import('../map/tests/fakeMap');
  return { default: { Map: FakeMap, NavigationControl: class { onAdd() { return document.createElement('div'); } onRemove() {} } } };
});
vi.mock('../map/config', () => ({ mapOptions: { token: 'pk.test', style: 'mapbox://styles/test' } }));
vi.mock('../App', async () => {
  const { SharedMapViewport } = await import('../map/SharedMapContext');
  return { default: ({ active }) => <SharedMapViewport active={active} /> };
});
vi.mock('../repositories/businessLayerRepository', async original => ({
  ...await original(), default: { load: async () => [], save: async () => {} },
}));

let node, root, media, listeners, sources, messages, activeTask, fetcher, rect;
const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 30)));
const button = label => node.querySelector(`button[aria-label="${label}"]`);
const click = async element => act(async () => element.click());
const changeNarrow = async narrow => act(async () => {
  media.matches = narrow;
  for (const listener of listeners) listener(media);
});
const setDraft = async text => act(async () => {
  const input = node.querySelector('textarea');
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
async function mount() {
  await act(async () => root.render(<ModeRoot />));
  for (let i = 0; i < 50 && !button('Collapse conversation panel'); i++) await flush();
  expect(button('Collapse conversation panel')).not.toBeNull();
}

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  sessionStorage.clear(); localStorage.clear(); sessionStorage.setItem('satgpt:mode', 'agent');
  FakeMap.instances = []; sources = []; listeners = new Set(); activeTask = null;
  messages = [{ id: 'question', role: 'user', content: 'Existing question', job_id: 'job' }];
  media = { matches: false, addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  vi.stubGlobal('matchMedia', () => media);
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('EventSource', class { constructor() { this.close = vi.fn(); sources.push(this); } });
  fetcher = vi.fn(async url => ({ ok: true, json: async () => url.endsWith('/conversations')
    ? { conversations: [{ id: 'webgis-fold', title: 'Existing question', task_status: activeTask ? 'running' : null }] }
    : { conversation_id: 'webgis-fold', messages, active_task: activeTask } }));
  vi.stubGlobal('fetch', fetcher);
  rect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0, top: 58, width: 1200, height: 742, right: 1200, bottom: 800,
  });
  node = document.createElement('div'); document.body.appendChild(node); root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount()); node.remove(); rect.mockRestore();
  vi.unstubAllGlobals(); sessionStorage.clear(); localStorage.clear();
  delete globalThis.IS_REACT_ACT_ENVIRONMENT;
});

test('panel title control hides the whole conversation and restores the same split, draft, history and map', async () => {
  await mount();
  const panel = node.querySelector('.agent-chat-panel'), handle = node.querySelector('.agent-resize-handle');
  const input = node.querySelector('textarea'), canvas = node.querySelector('canvas'), raw = FakeMap.instances[0];
  await setDraft('Retained draft');
  const split = panel.style.flexGrow;
  expect(Number(split)).toBe(38);
  expect(node.querySelector('.satgpt-topbar [aria-label="Collapse conversation panel"]')).toBeNull();
  expect(node.querySelector('.agent-conversation-header h2').textContent).toBe('Existing question');
  await click(button('Collapse conversation panel'));
  expect(panel.hidden).toBe(true); expect(handle.hidden).toBe(true);
  expect(node.querySelector('.agent-history')).toBeNull();
  expect(node.querySelector('.harness-shell').dataset.chatCollapsed).toBe('true');
  const reopen = button('Open conversation panel');
  expect(reopen.getAttribute('aria-expanded')).toBe('false');
  expect(document.activeElement).toBe(reopen);
  await click(reopen);
  expect(panel.hidden).toBe(false); expect(handle.hidden).toBe(false);
  expect(panel.style.flexGrow).toBe(split);
  expect(node.querySelector('textarea')).toBe(input); expect(input.value).toBe('Retained draft');
  expect(node.querySelector('.agent-history')).not.toBeNull();
  expect(button('Collapse conversation panel').getAttribute('aria-expanded')).toBe('true');
  expect(node.querySelector('canvas')).toBe(canvas); expect(FakeMap.instances).toHaveLength(1);
  expect(raw.remove).not.toHaveBeenCalled(); expect(raw.fitBounds).not.toHaveBeenCalled();
  expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'POST')).toHaveLength(0);
});

test('independent history preference survives full folding and mode switches', async () => {
  await mount();
  const history = button('Collapse conversation history');
  await click(history);
  expect(node.querySelector('.agent-history')).toBeNull();
  expect(document.activeElement).toBe(node.querySelector('.agent-conversation-header [aria-label="Open conversation history"]'));
  expect(node.querySelector('.agent-chat-panel').hidden).toBe(false);
  await click(button('Collapse conversation panel'));
  await click(node.querySelector('[data-mode="basic"][role="tab"]'));
  expect(button('Open conversation panel').closest('[hidden]')).not.toBeNull();
  await click(node.querySelector('[data-mode="agent"][role="tab"]'));
  expect(node.querySelector('.agent-chat-panel').hidden).toBe(true);
  await click(button('Open conversation panel'));
  expect(node.querySelector('.agent-history')).toBeNull();
  expect(node.querySelector('.agent-conversation-header [aria-label="Open conversation history"]').getAttribute('aria-expanded')).toBe('false');
  await click(node.querySelector('.agent-conversation-header [aria-label="Open conversation history"]'));
  expect(node.querySelector('.agent-history')).not.toBeNull();
  expect(document.activeElement).toBe(button('Collapse conversation history'));
});

test('folded conversations keep SSE and layers, and mark completion read only after reopening', async () => {
  activeTask = 'job'; await mount();
  expect(sources).toHaveLength(1);
  const emit = (id, status) => act(async () => sources[0].onmessage({ data: JSON.stringify({
    id, type: 'snapshot', task_id: 'job', task: { id: 'job', conversation_id: 'webgis-fold', status }, answer: null,
  }) }));
  await emit(1, 'running');
  await click(button('Collapse conversation panel'));
  expect(sources[0].close).not.toHaveBeenCalled();
  messages = [...messages, { id: 'answer', role: 'assistant', job_id: 'job', content: 'Completed while folded',
    layers: [{ name: 'Retained result', url: 'https://earthengine.googleapis.com/v1/projects/test/maps/result/tiles/{z}/{x}/{y}' }] }];
  activeTask = null;
  await emit(2, 'completed');
  const activity = () => JSON.parse(localStorage.getItem('satgpt:harness:conversation-activity'))['webgis-fold'];
  expect(activity().seen).toBe(false);
  expect(node.querySelector('.agent-map-layer').textContent).toContain('Retained result');
  expect(sources[0].close).toHaveBeenCalledTimes(1);
  await click(button('Open conversation panel'));
  expect(node.querySelector('.agent-markdown').textContent).toContain('Completed while folded');
  expect(activity().seen).toBe(true); expect(sources).toHaveLength(1);
  expect(FakeMap.instances).toHaveLength(1);
});

test('narrow Chat, Map and history stay reachable and returning to desktop restores folded state', async () => {
  await mount(); await setDraft('Draft across breakpoints');
  await click(button('Collapse conversation panel'));
  await changeNarrow(true);
  expect(button('Open conversation panel')).toBeNull();
  expect(node.querySelector('.agent-chat-panel').hidden).toBe(false);
  await click(node.querySelector('.agent-mobile-tabs button[aria-pressed="false"]'));
  expect(node.querySelector('.harness-shell').dataset.mobileView).toBe('map');
  await click(node.querySelector('.agent-mobile-tabs button[aria-pressed="false"]'));
  await click(node.querySelector('.agent-mobile-tabs [aria-label="Open conversation history"]'));
  expect(document.querySelector('.agent-history-dialog .agent-conversation').textContent).toBe('Existing question');
  await changeNarrow(false);
  expect(document.querySelector('.agent-history-dialog')).toBeNull();
  expect(node.querySelector('.agent-chat-panel').hidden).toBe(true);
  await click(button('Open conversation panel'));
  expect(node.querySelector('textarea').value).toBe('Draft across breakpoints');
  expect(node.querySelector('.agent-history')).not.toBeNull();
  expect(FakeMap.instances).toHaveLength(1);
});
