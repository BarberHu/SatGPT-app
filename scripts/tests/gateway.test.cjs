const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

test('production gateway preserves API and streaming contracts', { timeout: 20000 }, async (t) => {
  let runtimeHealthy = true;
  let finishStream;
  const agent = http.createServer(async (req, res) => {
    if (req.url === '/health') return res.end('{"status":"ok"}');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
  });
  const runtime = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(runtimeHealthy ? 200 : 503);
      return res.end('{}');
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write('data: first\n\n');
    finishStream = () => res.end('data: last\n\n');
  });
  t.after(() => { agent.closeAllConnections(); agent.close(); runtime.closeAllConnections(); runtime.close(); });
  const agentPort = await listen(agent);
  const runtimePort = await listen(runtime);
  const reservation = http.createServer();
  const frontendPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../frontend/server.cjs')], {
    windowsHide: true,
    env: {
      ...process.env,
      FRONTEND_HOST: '127.0.0.1', FRONTEND_PORT: String(frontendPort),
      SATGPT_SERVICE_HOST: '127.0.0.1', AGENT_PORT: String(agentPort),
      RUNTIME_PORT: String(runtimePort), PROXY_TIMEOUT_MS: '5000', PROXY_MAX_SOCKETS: '16',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (child.exitCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await exited;
    }
  });
  await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Gateway exited before ready: ${code}`)));
    child.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('production frontend listening')) resolve();
    });
  });
  const base = `http://127.0.0.1:${frontendPort}`;

  await t.test('forwards method, query and per-request PDF body', async () => {
    const body = JSON.stringify({ script: 'print("request-owned-script")' });
    const response = await fetch(`${base}/api/scripts/pdf?download=1`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.deepEqual(await response.json(), { method: 'POST', url: '/api/scripts/pdf?download=1', body });
  });

  await t.test('forwards the Agent endpoint', async () => {
    const response = await fetch(`${base}/agent`, { method: 'POST', body: '{}' });
    assert.equal((await response.json()).url, '/agent');
  });

  await t.test('delivers the first stream event before upstream completion', async () => {
    const response = await fetch(`${base}/copilotkit`, { method: 'POST', body: '{}' });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /data: first/);
    finishStream();
    let remainder = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      remainder += Buffer.from(next.value).toString();
    }
    assert.match(remainder, /data: last/);
  });

  await t.test('readiness changes when an upstream becomes unavailable', async () => {
    assert.equal((await fetch(`${base}/readyz`)).status, 200);
    runtimeHealthy = false;
    const degraded = await fetch(`${base}/readyz`);
    assert.equal(degraded.status, 503);
    assert.deepEqual(await degraded.json(), { status: 'degraded', agent: true, runtime: false });
  });

  await t.test('serves the built frontend', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /<div id="root">/);
  });
});
