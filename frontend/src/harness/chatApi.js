async function request(path, { signal, ...options } = {}) {
  const response = await fetch(`/api/harness${path}`, { signal, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.detail || data.error || `HTTP ${response.status}`);
  return data;
}

export const chatApi = {
  current: signal => request('/conversation', { signal }),
  list: signal => request('/conversations', { signal }),
  create: signal => request('/conversation/new', { method: 'POST', signal }),
  activate: (id, signal) => request(`/conversations/${encodeURIComponent(id)}/activate`, { method: 'POST', signal }),
  send: (body, signal) => request('/tasks', { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
  subscribe: id => new EventSource(`/api/harness/tasks/${encodeURIComponent(id)}/events`),
};
