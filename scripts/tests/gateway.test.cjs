const assert = require('node:assert/strict');
const { readFile } = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { gunzipSync } = require('node:zlib');

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function getRawResponse(url, encoding) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers: { 'Accept-Encoding': encoding } }, async response => {
      try {
        const chunks = [];
        for await (const chunk of response) chunks.push(chunk);
        resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) });
      } catch (error) {
        reject(error);
      }
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error('Static response timed out')));
  });
}

test('production gateway preserves Basic and Harness contracts', { timeout: 20000 }, async (t) => {
  let harnessHealthy = true;
  let basicHealthy = true;
  let readinessStatus;
  let finishStream;
  const backend = http.createServer(async (req, res) => {
    if (req.url === '/readyz') {
      res.writeHead(readinessStatus || (harnessHealthy && basicHealthy ? 200 : 503));
      return res.end(JSON.stringify({ status: harnessHealthy && basicHealthy ? 'ready' : 'degraded',
        harness: harnessHealthy, basic: basicHealthy }));
    }
    if (req.url === '/health') {
      res.writeHead(harnessHealthy ? 200 : 503);
      return res.end('{}');
    }
    if (req.url === '/api/harness/tasks/job/events') {
      assert.equal(req.headers['last-event-id'], '7');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write('id: 8\ndata: {"type":"answer.delta","text":"live"}\n\n');
      finishStream = () => res.end('id: 9\ndata: {"type":"task","patch":{"status":"completed"}}\n\n');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ method: req.method, url: req.url, body: Buffer.concat(chunks).toString() }));
  });
  t.after(() => { backend.closeAllConnections(); backend.close(); });
  const backendPort = await listen(backend);
  const reservation = http.createServer();
  const frontendPort = await listen(reservation);
  await new Promise((resolve) => reservation.close(resolve));
  const child = spawn(process.execPath, [path.resolve(__dirname, '../../frontend/server.cjs')], {
    windowsHide: true,
    env: {
      ...process.env,
      FRONTEND_HOST: '127.0.0.1', FRONTEND_PORT: String(frontendPort),
      SATGPT_SERVICE_HOST: '127.0.0.1', AGENT_PORT: String(backendPort), HARNESS_PORT: 'ignored',
      BASIC_SERVICE_HOST: 'ignored.invalid', HARNESS_SERVICE_HOST: 'ignored.invalid',
      PROXY_TIMEOUT_MS: '5000', PROXY_MAX_SOCKETS: '16',
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

  await t.test('forwards Harness task requests', async () => {
    const body = JSON.stringify({ prompt: 'Map rainfall', bounds: [100, 10, 101, 11] });
    const response = await fetch(`${base}/api/harness/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.deepEqual(await response.json(), { method: 'POST', url: '/api/harness/tasks', body });
  });

  await t.test('forwards Basic API requests', async () => {
    const body = JSON.stringify({ message: 'hello' });
    const response = await fetch(`${base}/api/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.deepEqual(await response.json(), { method: 'POST', url: '/api/chat', body });
  });

  await t.test('forwards SSE incrementally and preserves the reconnect cursor', async () => {
    const response = await fetch(`${base}/api/harness/tasks/job/events`, { headers: { 'Last-Event-ID': '7' } });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader();
    const first = await reader.read();
    assert.match(Buffer.from(first.value).toString(), /id: 8[\s\S]*answer.delta/);
    finishStream();
    let remainder = '';
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      remainder += Buffer.from(next.value).toString();
    }
    assert.match(remainder, /id: 9[\s\S]*completed/);
  });

  await t.test('readiness follows both module flags in one backend response', async () => {
    assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { status: 'ready', harness: true, basic: true });
    harnessHealthy = false;
    const degraded = await fetch(`${base}/readyz`);
    assert.equal(degraded.status, 503);
    assert.deepEqual(await degraded.json(), { status: 'degraded', harness: false, basic: true });
    harnessHealthy = true;
    basicHealthy = false;
    assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { status: 'degraded', harness: true, basic: false });
    basicHealthy = true;
    readinessStatus = 503;
    assert.equal((await fetch(`${base}/readyz`)).status, 503);
    readinessStatus = undefined;
  });

  await t.test('forwards previews to the same backend', async () => {
    const response = await fetch(`${base}/api/previews/fixture.png`);
    assert.equal((await response.json()).url, '/api/previews/fixture.png');
  });

  await t.test('serves the built frontend', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /<div id="root">/);
  });

  await t.test('serves the original grid GeoJSON with or without gzip', async () => {
    const asset = 'assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson';
    const original = await readFile(path.join(__dirname, '../../frontend/public', asset));
    const url = `${base}/${asset}`;
    const gzip = await getRawResponse(url, 'gzip');
    const identity = await getRawResponse(url, 'identity');

    for (const response of [gzip, identity]) {
      assert.equal(response.status, 200);
      assert.equal(response.headers['content-type'], 'application/geo+json');
      assert.equal(response.headers['vary'], 'Accept-Encoding');
      assert.equal(response.headers['cache-control'], 'no-cache');
    }
    assert.equal(gzip.headers['content-encoding'], 'gzip');
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(Number(identity.headers['content-length']), original.length);
    assert.ok(identity.body.equals(original), 'uncompressed GeoJSON must match the source asset');
    assert.ok(gunzipSync(gzip.body).equals(original), 'decompressed GeoJSON must match the source asset');
    assert.ok(gzip.body.length <= identity.body.length * 0.05, 'gzip must save at least 95% of the grid payload');
    t.diagnostic(`GeoJSON HTTP body: ${identity.body.length} bytes uncompressed, ${gzip.body.length} bytes gzip`);
  });
});
