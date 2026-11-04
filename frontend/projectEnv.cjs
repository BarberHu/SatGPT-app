// Explicit root .env only; Vite's automatic env discovery is disabled.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');

const defaults = {
  FRONTEND_HOST: '127.0.0.1', FRONTEND_PORT: '3000',
  SATGPT_SERVICE_HOST: '127.0.0.1', AGENT_PORT: '8000',
  SATGPT_ALLOW_REMOTE_HARNESS: 'false', PROXY_TIMEOUT_MS: '300000', PROXY_MAX_SOCKETS: '256',
  GENERATE_SOURCEMAP: 'false',
  REACT_APP_MAPBOX_STYLE_URL: 'mapbox://styles/unuinweh/clsmw8jm201f201ql5wdgcifp',
};
const publicNames = ['REACT_APP_MAPBOX_ACCESS_TOKEN', 'REACT_APP_MAPBOX_STYLE_URL'];

function loadProjectEnv(root = path.resolve(__dirname, '..'), injected = process.env) {
  const file = path.join(root, '.env');
  const local = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  return { ...defaults, ...local, ...injected };
}
function invalid(name, detail) {
  throw new Error(`${name} ${detail}. Set ${name} in the project root .env (or process environment).`);
}
function port(env, name) {
  const raw = String(env[name] ?? '');
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > 65535) invalid(name, 'must be an integer between 1 and 65535');
  return Number(raw);
}
function positive(env, name, maximum = Number.MAX_SAFE_INTEGER) {
  const raw = String(env[name] ?? '');
  if (!/^\d+$/.test(raw) || Number(raw) < 1 || Number(raw) > maximum || !Number.isSafeInteger(Number(raw))) invalid(name, `must be an integer between 1 and ${maximum}`);
  return Number(raw);
}
function validateFrontend(env, { map = true } = {}) {
  const ports = ['FRONTEND_PORT', 'AGENT_PORT'].map(name => port(env, name));
  if (new Set(ports).size !== ports.length) invalid('FRONTEND_PORT/AGENT_PORT', 'must use distinct ports');
  if (map) for (const name of publicNames) if (!env[name]?.trim()) invalid(name, 'is required');
  if (map && env.REACT_APP_MAPBOX_ACCESS_TOKEN?.startsWith('sk.')) invalid('REACT_APP_MAPBOX_ACCESS_TOKEN', 'must be a browser public token, not a Mapbox secret token');
  positive(env, 'PROXY_TIMEOUT_MS', 86400000); positive(env, 'PROXY_MAX_SOCKETS', 65535);
  for (const name of ['SATGPT_ALLOW_REMOTE_HARNESS', 'GENERATE_SOURCEMAP']) {
    if (!['true', 'false'].includes(env[name])) invalid(name, 'must be true or false');
  }
  for (const name of ['SATGPT_SERVICE_HOST', 'FRONTEND_HOST']) {
    if (env[name] !== undefined && !/^[a-zA-Z0-9.:[\]_-]+$/.test(env[name])) invalid(name, 'must be a host name or IP address');
  }
}
function publicConfig(env) {
  return Object.fromEntries(publicNames.map(name => [`import.meta.env.${name}`, JSON.stringify(env[name] || '')]));
}
module.exports = { loadProjectEnv, validateFrontend, publicConfig, port, positive, defaults };
