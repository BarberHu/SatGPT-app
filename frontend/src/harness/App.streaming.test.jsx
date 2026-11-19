vi.mock('./browserSession.js', () => ({ ensureBrowserSession: async () => {} }));
beforeEach(() => sessionStorage.clear());
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import HarnessApp from './App';
import { SharedMapProvider, SharedMapSurface } from '../map/SharedMapContext';
import { AoiLibraryProvider } from '../aoi/AoiLibraryContext';
import { selectionKey } from './map/regionSelection';
function AgentWorkspace(props) { return <SharedMapProvider mode="agent"><div><SharedMapSurface /><HarnessApp {...props} /></div></SharedMapProvider>; }
const { mapSetView, mapRemoveLayer, mapVisibility } = vi.hoisted(() => ({ mapSetView: vi.fn(), mapRemoveLayer: vi.fn(), mapVisibility: vi.fn() }));
vi.mock('../map/config', () => ({ mapOptions: { token: 'test-token', style: 'mapbox://styles/test' } }));
vi.mock('@mapbox/mapbox-gl-draw', () => ({ default: class {
  static modes = {};
  changeMode() {}
  deleteAll() {}
  add() {}
} }));

vi.mock('../map/mapboxAdapter', () => ({
  MapboxAdapter: class {
    onStyleReady(callback) { let disposed = false; queueMicrotask(() => { if (!disposed) callback(); }); return () => { disposed = true; }; }
    getBasicPort() { return null; }
    getAgentDrawPort() { return this.drawPort ??= { addControl() {}, removeControl() {}, on() {}, off() {} }; }
    setBasicActive() {}
    onViewChange() { return () => {}; }
    getView() { return { center: [100, 10], zoom: 5, bounds: [99, 9, 101, 11] }; }
    setView(view) { mapSetView(view); }
    addLayer(layer) { mapVisibility(layer.id, layer.visible); }
    removeLayer(id) { mapRemoveLayer(id); }
    setVisibility(id, visible) { mapVisibility(id, visible); }
    dispose() {}
  },
}));

test('new chats stay local until a retry succeeds and carry their selected area into the conversation', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
  mapVisibility.mockClear();
  const oldId = 'webgis-old', newId = 'webgis-created';
  const oldHistory = [{ id: 'old', role: 'assistant', job_id: 'old-job', content: 'Old reply',
    layers: [{ name: 'Old layer', url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}' }] }];
  const geometry = { type: 'Polygon', coordinates: [[[100, 10], [101, 10], [100, 11], [100, 10]]] };
  const area = { id: 'saved-area', revision: 1, label: 'Saved triangle', source: 'draw',
    geojson: { type: 'Feature', properties: {}, geometry } };
  const repository = { list: async () => [area], migrate: async () => ({ invalid: 0 }) };
  const sources = [], sent = [];
  let reasoningAttempts = 0;
  let messages = [], active = null;
  class Source {
    constructor(url) { this.url = url; sources.push(this); }
    close() {}
  }
  const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
  const fetcher = vi.fn(async (url, options) => {
    const path = url.slice('/api/harness'.length);
    if (path === '/reasoning') {
      reasoningAttempts += 1;
      if (reasoningAttempts === 1) return response({ detail: 'Not Found' }, 404);
      if (reasoningAttempts === 2) return response({ detail: 'Unavailable' }, 503);
      return response({ levels: [
        { id: 'off', name: 'Off' }, { id: 'low', name: 'Low' },
        { id: 'high', name: 'High' }, { id: 'max', name: 'Max' },
      ], model: 'DeepSeek Flash', default_effort: 'high' });
    }
    if (path === '/conversation' || path === `/conversations/${oldId}/activate`) {
      return response({ conversation_id: oldId, messages: oldHistory, active_task: null });
    }
    if (path === '/conversations') return response({ conversations: [
      ...(messages.length ? [{ id: newId, title: messages[0].content, active_task: active }] : []), { id: oldId, title: 'Old chat' },
    ] });
    if (path === `/conversations/${newId}`) return response({ conversation_id: newId, messages, active_task: active });
    if (path === '/tasks') {
      const body = JSON.parse(options.body); sent.push(body);
      if (sent.length === 1) return response({ detail: { message: 'Please retry' } }, 503);
      active = `job-${sent.length}`;
      messages = [...messages, { id: `user-${active}`, role: 'user', job_id: active, content: body.prompt }];
      return response({ id: active, conversation_id: newId, prompt: body.prompt, status: 'queued' }, 202);
    }
    throw new Error(`Unexpected request ${path}`);
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Source);
  const node = document.body.appendChild(document.createElement('div'));
  const root = createRoot(node);
  const render = () => act(async () => root.render(<AoiLibraryProvider repository={repository}><AgentWorkspace /></AoiLibraryProvider>));
  const click = (selector, container = node) => act(async () => container.querySelector(selector).click());
  const button = label => [...node.querySelectorAll('button')].find(item => item.textContent === label);
  const enterPrompt = value => act(async () => {
    const input = node.querySelector('textarea');
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const effort = () => node.querySelector('.agent-reasoning-trigger');
  const options = () => [...node.querySelectorAll('[role="menuitemradio"]')];
  const retry = () => click('.agent-reasoning-panel button');
  const status = () => node.querySelector('.agent-reasoning-panel [role="status"]')?.textContent;
  const key = (item, key) => act(async () => item.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  const chooseEffort = label => act(async () => options().find(item => item.firstElementChild.textContent === label).click());
  try {
    await render();
    await vi.waitFor(() => expect(node.querySelector('.agent-map-layer')?.textContent).toContain('Old layer'));
    await act(async () => effort().click());
    expect(status()).toBe('The connected server does not provide reasoning levels.');
    expect(node.querySelector('.agent-reasoning-panel button').textContent).toBe('Retry');
    await retry();
    expect(status()).toBe('Unable to load reasoning levels. Try again.');
    await retry();
    expect(effort().textContent).toContain('DeepSeek Flash');
    expect(effort().getAttribute('aria-label')).toBe('Reasoning effort · DeepSeek Flash · Server default');
    expect(options().map(item => item.firstElementChild.textContent)).toEqual(['Server default', 'Off', 'Low', 'High', 'Max']);
    expect(options()[0].getAttribute('aria-checked')).toBe('true');
    expect(document.activeElement).toBe(options()[0]);
    await key(document.activeElement, 'ArrowDown');
    expect(document.activeElement).toBe(options()[1]);
    await key(document.activeElement, 'Escape');
    expect(options()).toHaveLength(0);
    expect(document.activeElement).toBe(effort());
    await key(effort(), 'ArrowDown');
    await act(async () => node.dispatchEvent(new Event('pointerdown', { bubbles: true })));
    expect(options()).toHaveLength(0);
    await act(async () => effort().click());
    await key(document.activeElement, 'ArrowDown');
    await key(document.activeElement, 'ArrowDown');
    await key(document.activeElement, 'Enter');
    expect(document.activeElement).toBe(effort());
    fetcher.mockClear();
    await click('[aria-label="New chat"]');
    await click('[aria-label="New chat"]');
    expect(fetcher).not.toHaveBeenCalled();
    expect(node.querySelector('.agent-conversations').textContent).toBe('Old chat');
    expect(node.textContent).not.toContain('Old layer');
    expect(mapVisibility).toHaveBeenCalledWith(expect.stringContaining('old-job'), false);

    await act(async () => root.render(null));
    await render();
    expect(fetcher.mock.calls.map(([url]) => url).sort()).toEqual(['/api/harness/conversations', '/api/harness/reasoning']);
    expect(effort().querySelector('.agent-reasoning-current').textContent).toBe('Low');
    const draw = node.querySelector('[aria-label="Draw analysis area"]');
    expect(draw.disabled).toBe(false);
    await act(async () => button('Saved areas').click());
    await click('[aria-label="Saved area Saved triangle"] button', document);
    await act(async () => button('Hide boundary').click());
    await enterPrompt('First scoped prompt');
    await click('[aria-label="Send"]');
    expect(node.textContent).toContain('Please retry');
    expect(node.querySelector('textarea').value).toBe('First scoped prompt');
    expect(button('Show boundary')).toBeDefined();
    expect(node.querySelector('.agent-conversations').textContent).toBe('Old chat');

    await click('[aria-label="Send"]');
    expect(sent[0]).toEqual(sent[1]);
    expect(sent[1]).toMatchObject({ conversation_id: null, analysis_region: geometry, reasoning_effort: 'low',
      analysis_aoi: { id: area.id, revision: 1, label: area.label }, bounds: [100, 10, 101, 11] });
    expect(node.querySelector('[aria-current="page"]').title).toBe('First scoped prompt');
    expect(node.querySelector('textarea').value).toBe('');
    expect(button('Show boundary')).toBeDefined();
    expect(JSON.parse(localStorage.getItem(selectionKey(newId)))).toMatchObject({ outline_visible: false,
      aoi: { label: area.label, aoi_ref: { id: area.id, revision: 1 } } });
    expect(sources[0].url).toBe('/api/harness/tasks/job-2/events');
    active = null;
    messages = [...messages, { id: 'reply', role: 'assistant', job_id: 'job-2', content: 'First reply' }];
    await act(async () => sources[0].onmessage({ data: JSON.stringify({ id: 1, task_id: 'job-2', type: 'snapshot',
      task: { id: 'job-2', status: 'completed' }, answer: null }) }));
    expect(node.textContent).toContain('First reply');
    await act(async () => effort().click());
    await chooseEffort('Max');
    await enterPrompt('Continue here');
    await click('[aria-label="Send"]');
    expect(sent[2]).toMatchObject({ conversation_id: newId, reasoning_effort: 'max' });
    await click('button[title="Old chat"]');
    expect(node.querySelector('.agent-map-layer')?.textContent).toContain('Old layer');
    expect(mapVisibility).toHaveBeenLastCalledWith(expect.stringContaining('old-job'), true);
  } finally {
    await act(async () => root.unmount());
    node.remove();
    vi.unstubAllGlobals();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('real Agent surface streams, reconnects, settles once and restores after remount', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();

  let history = [{ id: 'user', role: 'user', content: 'question', job_id: 'job' }];
  let active = 'job';
  const sources = [];
  class Source {
    constructor(url) { this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
  }
  const fetcher = vi.fn(async url => url === '/api/harness/reasoning'
    ? { ok: false, status: 503, json: async () => ({ detail: 'Unavailable' }) }
    : { ok: true, json: async () => ({ conversation_id: 'webgis-test', messages: history, active_task: active }) });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('EventSource', Source);
  const node = document.createElement('div');
  document.body.appendChild(node);
  const root = createRoot(node);
  const flush = async () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
  const emit = async (source, id, type, data) => act(async () => source.onmessage({ data: JSON.stringify({
    id, type, task_id: 'job', conversation_id: 'webgis-test', ...data,
  }) }));
  try {
    await act(async () => root.render(<AgentWorkspace />));
    for (let i = 0; i < 100 && !sources.length; i++) await flush();
    expect(sources).toHaveLength(1);
    const source = sources[0];
    const runningTool = { id: 'tool-1', seq: 1, kind: 'tool', call_id: 'call-1', name: 'gee_status',
      status: 'running', committed: true, turn: 1, step: 1 };
    await emit(source, 0, 'snapshot', { task: { id: 'job', status: 'running', timeline: [runningTool] }, answer: null });
    expect(node.querySelector('[aria-label="Run timeline"]')).not.toBeNull();
    expect(node.querySelector('[aria-label="Run timeline"]').textContent).toContain('gee_status');
    expect(node.querySelector('[aria-label="Run timeline"]').open).toBe(true);
    const doneTool = { ...runningTool, status: 'done', result: 'GEE 已连接' };
    await emit(source, 1, 'task', { patch: {}, timeline_ops: [{ op: 'put', row: doneTool }] });
    expect(node.querySelector('.agent-run-timeline code').textContent).toBe('GEE 已连接');
    await emit(source, 2, 'answer.start', { answer: { attempt_id: 'a', text: '', status: 'streaming' } });
    await emit(source, 3, 'answer.delta', { attempt_id: 'a', text: 'doomed draft', timeline_ops: [{ op: 'put', row: {
      id: 'text-a', seq: 2, kind: 'text', text: 'doomed draft', attempt_id: 'a', committed: false, turn: 1, step: 1,
    } }] });
    await emit(source, 4, 'reasoning.delta', { attempt_id: 'a', text: 'first thought', timeline_ops: [{ op: 'put', row: {
      id: 'reason-a', seq: 3, kind: 'reasoning', text: 'first thought', attempt_id: 'a', committed: false, turn: 1, step: 1,
    } }] });
    expect(node.querySelector('[aria-label="Assistant response"]').textContent).toContain('doomed draft');
    expect(node.querySelector('[aria-label="Run timeline"]').open).toBe(true);
    expect(node.querySelector('[data-kind="reasoning"]').textContent).toContain('first thought');
    expect(node.querySelector('.agent-markdown').textContent).not.toContain('first thought');
    await act(async () => source.onerror());
    expect(source.closed).toBe(false);
    expect(node.textContent).toContain('Reconnecting');
    await act(async () => source.onopen());
    await emit(source, 3, 'answer.delta', { attempt_id: 'a', text: 'doomed draft' });
    await emit(source, 4, 'reasoning.delta', { attempt_id: 'a', text: 'first thought' });
    expect(node.textContent.match(/doomed draft/g)).toHaveLength(1);
    expect(node.querySelectorAll('[data-kind="reasoning"]')).toHaveLength(1);
    await emit(source, 5, 'answer.reset', { attempt_id: 'a', timeline_ops: [{ op: 'remove', ids: ['text-a', 'reason-a'] }] });
    expect(node.textContent).not.toContain('doomed draft');
    expect(node.textContent).not.toContain('first thought');
    await emit(source, 6, 'answer.start', { answer: { attempt_id: 'b', text: '', reasoning: '', status: 'streaming' } });
    await emit(source, 7, 'answer.delta', { attempt_id: 'b', text: 'new draft', timeline_ops: [{ op: 'put', row: {
      id: 'text-b', seq: 4, kind: 'text', text: 'new draft', attempt_id: 'b', committed: false, turn: 2, step: 1,
    } }] });
    await act(async () => root.render(null));
    expect(source.closed).toBe(true);
    expect(node.textContent).not.toContain('new draft');
    await emit(source, 8, 'answer.delta', { attempt_id: 'b', text: 'stale callback' });
    expect(node.textContent).not.toContain('stale callback');
    await act(async () => root.render(<AgentWorkspace />));
    for (let i = 0; i < 100 && sources.length < 2; i++) await flush();
    const restored = sources[1];
    expect(restored).toBeDefined();
    await emit(restored, 8, 'snapshot', { task: { id: 'job', status: 'running', timeline: [doneTool,
      { id: 'text-b', seq: 4, kind: 'text', text: 'new draft restored', attempt_id: 'b', committed: false, turn: 2, step: 1 },
      { id: 'reason-b', seq: 5, kind: 'reasoning', text: 'restored thought', attempt_id: 'b', committed: false, turn: 2, step: 1 },
    ] },
      answer: { attempt_id: 'b', text: 'new draft restored', reasoning: 'restored thought', status: 'streaming' } });
    expect(node.textContent).toContain('new draft restored');
    expect(node.querySelector('[data-kind="reasoning"]').textContent).toContain('restored thought');
    expect(node.querySelector('.agent-run-timeline code').textContent).toBe('GEE 已连接');
    await emit(restored, 9, 'answer.settle', { answer: { attempt_id: 'b', text: 'canonical',
      reasoning: 'canonical thought', status: 'committed' }, timeline_ops: [
      { op: 'put', row: { id: 'text-b', seq: 4, kind: 'text', text: 'canonical', attempt_id: 'b', committed: true, turn: 2, step: 1 } },
      { op: 'put', row: { id: 'reason-b', seq: 5, kind: 'reasoning', text: 'canonical thought', attempt_id: 'b', committed: true, turn: 2, step: 1 } },
    ] });
    expect(node.textContent).toContain('canonical');
    expect(node.textContent).not.toContain('new draft');
    history = [...history, { id: 'reply', role: 'assistant', job_id: 'job', content: 'final answer',
      timeline: [doneTool, { id: 'reason-b', seq: 5, kind: 'reasoning', text: 'canonical thought', committed: true, turn: 2, step: 1 }],
      previews: [{ url: '/api/previews/test.png' }],
      layers: [{ name: 'result layer', bounds: [100, 10, 101, 11], url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}' }] }];
    active = null;
    await emit(restored, 10, 'task', { patch: { status: 'completed', output: { message: 'final answer' } } });
    await flush();
    expect(node.textContent.match(/final answer/g)).toHaveLength(1);
    expect([...node.querySelectorAll('.agent-run-timeline code')].filter(n => n.textContent === 'GEE 已连接')).toHaveLength(1);
    expect(node.querySelectorAll('[data-kind="reasoning"]')).toHaveLength(1);
    expect(node.querySelector('.agent-markdown').textContent).not.toContain('canonical');
    expect(node.querySelector('.harness-preview')).not.toBeNull();
    expect(node.textContent).toContain('result layer');
    expect(restored.closed).toBe(true);
    expect(fetcher.mock.calls.every(([url]) => ['/api/harness/conversation', '/api/harness/conversations', '/api/harness/conversations/webgis-test', '/api/harness/reasoning'].includes(url))).toBe(true);
    await act(async () => node.querySelector('.agent-reasoning-trigger').click());
    expect(node.querySelector('.agent-reasoning-panel [role="status"]').textContent).toBe('Unable to load reasoning levels. Try again.');
  } finally {
    await act(async () => root.unmount());
    node.remove();
    window.localStorage.clear();
    vi.unstubAllGlobals();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}, 15000);

test('Agent process explains a turn without tool calls without exposing reasoning', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const { default: RunTimeline } = await import('./components/RunTimeline');
  const node = document.createElement('div');
  const root = createRoot(node);
  try {
    await act(async () => root.render(<RunTimeline rows={[]} pending />));
    expect(node.textContent).toContain('Running');
    await act(async () => root.render(<RunTimeline rows={[]} />));
    expect(node.textContent).toBe('');
  } finally {
    await act(async () => root.unmount());
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test('history switching restores independent layers and persists visibility and removal', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  window.localStorage.clear();

  const histories = Object.fromEntries(['one', 'two'].map(id => [`webgis-${id}`, [
    { id: `u-${id}`, role: 'user', content: `${id} history`, job_id: id },
    { id: `a-${id}`, role: 'assistant', content: `${id} answer`, job_id: id,
      layers: [{ name: `${id} layer`, bounds: [100, 10, 101, 11], url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}' }] },
  ]]));
  let current = 'webgis-one';
  const fetcher = vi.fn(async (url, options) => {
    const match = url.match(/\/conversations\/(webgis-\w+)\/activate$/);
    if (match) current = match[1];
    return { ok: true, json: async () => url.endsWith('/conversations') ? {
      conversations: Object.keys(histories).map(id => ({ id, title: `${id.slice(7)} history` })),
    } : { conversation_id: current, messages: histories[current], active_task: null } };
  });
  vi.stubGlobal('fetch', fetcher);
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  const flush = () => act(async () => new Promise(resolve => setTimeout(resolve, 10)));
  const switchTo = async title => {
    await act(async () => [...node.querySelectorAll('.agent-conversation')].find(b => b.textContent.includes(title)).click());
    await flush();
  };
  try {
    await act(async () => root.render(<AgentWorkspace />));
    for (let i = 0; i < 100 && !node.querySelector('.agent-map-layer input'); i++) await flush();
    expect(node.querySelector('.agent-chat-header, .agent-brand, .agent-history-footer')).toBeNull();
    expect(node.querySelectorAll('.agent-new')).toHaveLength(1);
    expect(node.textContent).not.toContain('地理空间助手');
    await act(async () => node.querySelector('[aria-label="Collapse conversation history"]').click());
    expect(node.querySelector('.agent-history')).toBeNull();
    expect(node.querySelector('.agent-map-layer').textContent).toContain('one layer');
    await act(async () => node.querySelector('.agent-conversation-header [aria-label="Open conversation history"]').click());
    expect(node.querySelector('.agent-history')).not.toBeNull();
    const checkbox = node.querySelector('.agent-map-layer input');
    expect(checkbox.checked).toBe(true);
    await act(async () => checkbox.click());
    expect(JSON.parse(localStorage.getItem('satgpt:harness:layers:webgis-one')).visibility['one-0']).toBe(false);
    await switchTo('two history');
    expect(node.querySelector('.agent-map-layer').textContent).toContain('two layer');
    expect(node.querySelector('.agent-map-layer').textContent).not.toContain('one layer');
    await switchTo('one history');
    expect(node.querySelector('.agent-map-layer input').checked).toBe(false);
    await act(async () => node.querySelector('[aria-label="Layer details one layer"]').click());
    await act(async () => node.querySelector('[aria-label="Remove one layer"]').click());
    await switchTo('two history'); await switchTo('one history');
    expect(node.querySelector('.agent-map-layer')).toBeNull();
    expect(node.querySelector('.agent-result-card').textContent).toContain('one layer');
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/activate'))).toHaveLength(4);
  } finally {
    await act(async () => root.unmount()); node.remove(); window.localStorage.clear();
    vi.unstubAllGlobals(); delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
}, 10000);

test('narrow layout uses a working history dialog and result location opens the map', async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  mapSetView.mockClear();

  vi.stubGlobal('matchMedia', () => ({ matches: true, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('requestAnimationFrame', callback => { callback(); return 1; });
  vi.stubGlobal('fetch', vi.fn(async url => ({ ok: true, json: async () => url.endsWith('/conversations')
    ? { conversations: [{ id: 'webgis-mobile', title: 'mobile history' }] }
    : { conversation_id: 'webgis-mobile', active_task: null, messages: [{ id: 'a', role: 'assistant', content: 'mobile answer', job_id: 'mobile',
      layers: [{ name: 'mobile result', bounds: [113.45, 34.3, 114.2, 35], url: 'https://earthengine.googleapis.com/v1/projects/p/maps/m/tiles/{z}/{x}/{y}' }] }] } })));
  const node = document.createElement('div'); document.body.appendChild(node);
  const root = createRoot(node);
  try {
    await act(async () => root.render(<AgentWorkspace />));
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    expect(node.querySelector('.agent-history')).toBeNull();
    await act(async () => node.querySelector('.agent-mobile-tabs [aria-label="Open conversation history"]').click());
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]').textContent).toContain('mobile history');
    await act(async () => document.querySelector('[role="dialog"] [aria-label="Collapse conversation history"]').click());
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () => node.querySelector('.agent-result-card [aria-label="Zoom to mobile result"]').click());
    expect(node.querySelector('.harness-shell').dataset.mobileView).toBe('map');
    expect(mapSetView).toHaveBeenLastCalledWith({ bounds: [113.45, 34.3, 114.2, 35] });
  } finally {
    await act(async () => root.unmount()); node.remove(); vi.unstubAllGlobals();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});

test.each([false, true])('deleting current history clears results and scoped storage in narrow=%s layout', async narrow => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear(); mapRemoveLayer.mockClear();
  vi.stubGlobal('matchMedia', () => ({ matches: narrow, addEventListener() {}, removeEventListener() {} }));
  let deleted = false;
  const old = { conversation_id: 'webgis-delete', active_task: null, messages: [{ id: 'a', role: 'assistant',
    content: 'Delete this answer', job_id: 'old', layers: [{ name: 'Old layer',
      url: 'https://earthengine.googleapis.com/v1/projects/test/maps/example/tiles/{z}/{x}/{y}' }] }] };
  const fresh = { conversation_id: 'webgis-fresh', active_task: null, messages: [] };
  const list = () => [{ id: deleted ? 'webgis-fresh' : 'webgis-delete', title: deleted ? 'New chat' : 'Delete this history' }];
  const fetcher = vi.fn(async (url, options) => {
    if (options?.method === 'DELETE') {
      deleted = true;
      return { ok: true, json: async () => ({ deleted_id: 'webgis-delete', conversation: fresh, conversations: list() }) };
    }
    return { ok: true, json: async () => url.endsWith('/conversations') ? { conversations: list() } : deleted ? fresh : old };
  });
  vi.stubGlobal('fetch', fetcher);
  localStorage.setItem('satgpt:harness:layers:webgis-delete', JSON.stringify({ visibility: {} }));
  localStorage.setItem('satgpt:agent:analysis-region:v1:webgis-delete', 'null');
  localStorage.setItem('satgpt:agent:analysis-region:v2:webgis-delete', JSON.stringify({ schema_version: 2, aoi: null }));
  localStorage.setItem('unrelated-saved-area', 'keep');
  const node = document.createElement('div'); document.body.appendChild(node); const root = createRoot(node);
  try {
    await act(async () => root.render(<AgentWorkspace />));
    await act(async () => new Promise(resolve => setTimeout(resolve, 50)));
    expect(node.textContent).toContain('Delete this answer');
    if (narrow) await act(async () => node.querySelector('[aria-label="Open conversation history"]').click());
    await act(async () => document.querySelector('[aria-label="Conversation options: Delete this history"]').click());
    if (narrow) {
      await act(async () => document.querySelector('[role="menuitem"]').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })));
      expect(document.querySelector('[role="menu"]')).toBeNull();
      expect(document.querySelector('.agent-history-dialog')).not.toBeNull();
      await act(async () => document.querySelector('[aria-label="Conversation options: Delete this history"]').click());
    }
    await act(async () => document.querySelector('[role="menuitem"]').click());
    await act(async () => [...document.querySelectorAll('.agent-delete-dialog button')].find(button => button.textContent === 'Delete').click());
    expect(document.querySelector('.agent-delete-dialog')).toBeNull();
    expect(document.body.textContent).not.toContain('Delete this history');
    expect(node.textContent).not.toContain('Delete this answer');
    expect(node.querySelector('.agent-result-card')).toBeNull();
    expect(mapRemoveLayer).toHaveBeenCalledWith('scope--agent%3Awebgis-delete--old-0');
    for (const key of ['satgpt:harness:layers:webgis-delete', 'satgpt:agent:analysis-region:v1:webgis-delete', 'satgpt:agent:analysis-region:v2:webgis-delete']) {
      expect(localStorage.getItem(key)).toBeNull();
    }
    expect(localStorage.getItem('unrelated-saved-area')).toBe('keep');
    expect(fetcher.mock.calls.filter(([, options]) => options?.method === 'DELETE')).toHaveLength(1);
  } finally {
    await act(async () => root.unmount()); node.remove(); localStorage.clear(); vi.unstubAllGlobals();
    delete globalThis.IS_REACT_ACT_ENVIRONMENT;
  }
});
