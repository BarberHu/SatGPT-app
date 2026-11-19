import { ensureBrowserSession } from './browserSession.js';

const SELECTION = 'satgpt:harness:current-tab';
const DRAFT = 'draft';
const pending = new Map();
export const emptyConversation = { conversation_id: null, messages: [], active_task: null };

function tabSelection() {
  try {
    return sessionStorage.getItem(SELECTION);
  } catch {
    return null;
  }
}

export function rememberConversation(id) {
  try { sessionStorage.setItem(SELECTION, id ?? DRAFT); }
  catch { /* The current selection still works in memory. */ }
}

function requestId() {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function request(path, { signal, ...options } = {}) {
  await ensureBrowserSession();
  const response = await fetch('/api/harness' + path, { signal, credentials: 'same-origin', ...options });
  const data = await response.json().catch(error => {
    if (response.ok) throw error;
    return {};
  });
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
export const chatApi = {
  async current(signal) {
    const id = tabSelection();
    if (id === DRAFT) return emptyConversation;
    if (id) {
      try { return await this.get(id, signal); }
      catch (error) { if (error.status !== 404) throw error; }
    }
    return request('/conversation', { signal });
  },
  get: (id, signal) => request(conversationPath(id), { signal }),
  list: signal => request('/conversations', { signal }),
  async reasoning(signal) {
    const options = await request('/reasoning', { signal });
    if (!Array.isArray(options?.levels) || options.levels.some(level =>
      typeof level?.id !== 'string' || !level.id || typeof level.name !== 'string')) {
      throw new Error('Invalid reasoning options.');
    }
    return options;
  },
  remove: (id, signal) => request(conversationPath(id), { method: 'DELETE', signal }),
  activate: (id, signal) => request(conversationPath(id) + '/activate', { method: 'POST', signal }),
  async send(body, signal, draftKey) {
    const key = body.conversation_id ?? draftKey;
    const fingerprint = JSON.stringify(body);
    const previous = pending.get(key);
    const id = previous?.fingerprint === fingerprint ? previous.id : requestId();
    pending.set(key, { fingerprint, id });
    if (pending.size > 16) pending.delete(pending.keys().next().value);
    const task = await request('/tasks', { method: 'POST', signal,
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, request_id: id }) });
    if (pending.get(key)?.id === id) pending.delete(key);
    return task;
  },
  cancel: (id, signal) => request(taskPath(id) + '/cancel', { method: 'POST', signal }),
  reloadLayer: (cid, layerId) => request(conversationPath(cid) + '/layers/' + encodeURIComponent(layerId) + '/reload', { method: 'POST' }),
  subscribe: id => new EventSource('/api/harness' + taskPath(id) + '/events'),
};
