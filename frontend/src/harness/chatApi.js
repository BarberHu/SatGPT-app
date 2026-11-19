import { ensureBrowserSession } from './browserSession.js';

const SELECTION = 'satgpt:harness:current-tab';
const pending = new Map();

function tabSelection(id) {
  try {
    if (id) sessionStorage.setItem(SELECTION, id);
    return sessionStorage.getItem(SELECTION);
  } catch {
    return null;
  }
}

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function request(path, { signal, ...options } = {}) {
  await ensureBrowserSession();
  const response = await fetch('/api/harness' + path, { signal, credentials: 'same-origin', ...options });
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.detail?.message || (typeof data.detail === 'string' ? data.detail : null)
      || data.error || 'HTTP ' + response.status);
    error.status = response.status;
    error.code = data.detail?.code;
    throw error;
  }
  return data;
}

const conversationPath = id => '/conversations/' + encodeURIComponent(id);
const taskPath = id => '/tasks/' + encodeURIComponent(id);
const selected = value => { tabSelection(value.conversation_id); return value; };

export const chatApi = {
  async current(signal) {
    const id = tabSelection();
    if (id) {
      try { return await this.get(id, signal); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    return selected(await request('/conversation', { signal }));
  },
  get: (id, signal) => request(conversationPath(id), { signal }),
  list: signal => request('/conversations', { signal }),
  async remove(id, signal) {
    const result = await request(conversationPath(id), { method: 'DELETE', signal });
    if (tabSelection() === id) selected(result.conversation);
    return result;
  },
  async create(signal) {
    return selected(await request('/conversation/new', { method: 'POST', signal }));
  },
  async activate(id, signal) {
    return selected(await request(conversationPath(id) + '/activate', { method: 'POST', signal }));
  },
  async send(body, signal) {
    const cid = body.conversation_id;
    const fingerprint = JSON.stringify(body);
    const previous = pending.get(cid);
    const id = previous?.fingerprint === fingerprint ? previous.id : requestId();
    pending.set(cid, { fingerprint, id });
    if (pending.size > 16) pending.delete(pending.keys().next().value);
    const task = await request('/tasks', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, request_id: id }) });
    if (pending.get(cid)?.id === id) pending.delete(cid);
    return task;
  },
  cancel: (id, signal) => request(taskPath(id) + '/cancel', { method: 'POST', signal }),
  reloadLayer: (cid, layerId) => request(conversationPath(cid) + '/layers/' + encodeURIComponent(layerId) + '/reload', { method: 'POST' }),
  subscribe: id => new EventSource('/api/harness' + taskPath(id) + '/events'),
};
