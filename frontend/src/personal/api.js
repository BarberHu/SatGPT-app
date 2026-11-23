let csrf = '';
let localCsrf = '';
let workspace = 'system';
export function setPersonalCsrf(value, owner = 'system') { csrf = value || ''; workspace = owner; }
export function currentWorkspace() { return workspace; }
export function sessionHeaders() { return { ...(csrf ? { 'X-SatGPT-CSRF': csrf } : {}), ...(localCsrf ? { 'X-SatGPT-Local-CSRF': localCsrf } : {}) }; }
export function validateWorkspace(response, expected) {
  const actual = response.headers?.get('X-SatGPT-Workspace');
  if (workspace !== expected || (actual && actual !== expected) || response.status === 401) {
    window.dispatchEvent(new Event('satgpt-account-changed'));
    const error = new Error('The account workspace changed. Refreshing your connection.'); error.name = 'AbortError'; throw error;
  }
}
export async function personalRequest(path, { body, ...options } = {}) {
  const expected = workspace;
  const response = await fetch(`/api/personal${path}`, { credentials: 'same-origin', ...options,
    headers: { ...sessionHeaders(), ...(body && !(body instanceof File) ? { 'Content-Type': 'application/json' } : {}), ...options.headers },
    body: body instanceof File ? body : body === undefined ? undefined : JSON.stringify(body) });
  if (path === '/status') localCsrf = response.headers?.get('X-SatGPT-Local-CSRF') || '';
  if (path !== '/status' && path !== '/logout') validateWorkspace(response, expected);
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'The request could not be completed.');
  return data;
}

export async function localRequest(path, body) {
  const response = await fetch(`/api/local${path}`, { credentials: 'same-origin', method: body ? 'PUT' : 'GET',
    headers: { ...sessionHeaders(), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await response.json();
  if (!response.ok) throw new Error(typeof data.detail === 'string' ? data.detail : 'Local configuration could not be saved.');
  return data;
}
