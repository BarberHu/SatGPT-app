const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { copyFile, mkdir, mkdtemp, readFile, rm, rmdir, writeFile } = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { once } = require('node:events');
const { test } = require('node:test');
const { promisify } = require('node:util');
const { gunzipSync, gzipSync } = require('node:zlib');

const frontend = path.resolve(__dirname, '../../frontend');
const gridAsset = 'assets/data/HFMT_Fishnet_3_FeaturesToJSO.geojson';
const runFile = promisify(execFile);
const etagFor = content => `"${createHash('sha256').update(content).digest('hex')}"`;

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server.address().port;
}

function getRawResponse(url, { encoding, method = 'GET', ifNoneMatch } = {}) {
  return new Promise((resolve, reject) => {
    const headers = encoding === undefined ? {} : { 'Accept-Encoding': encoding };
    if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
    const request = http.get(url, { method, headers }, async response => {
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

async function startGateway(t, backendPort, directory = frontend) {
  const reservation = http.createServer();
  const frontendPort = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, [path.join(directory, 'server.cjs')], {
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
    if (child.exitCode === null && child.signalCode === null) {
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
  return `http://127.0.0.1:${frontendPort}`;
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
  const base = await startGateway(t, backendPort);

  await t.test('forwards Harness task requests', async () => {
    const body = JSON.stringify({ prompt: 'Map rainfall', bounds: [100, 10, 101, 11] });
    const response = await fetch(`${base}/api/harness/tasks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.deepEqual(await response.json(), { method: 'POST', url: '/api/harness/tasks', body });
  });

  await t.test('forwards Basic API requests', async () => {
    const body = JSON.stringify({ preset_id: 'singleInundationEvent' });
    const response = await fetch(`${base}/api/preset-layers`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
    });
    assert.deepEqual(await response.json(), { method: 'POST', url: '/api/preset-layers', body });
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

  await t.test('serves the built frontend with direct script and stylesheet references', async () => {
    const response = await fetch(base);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    const html = await response.text();
    assert.match(html, /<div id="root">/);
    assert.match(html, /<script\b[^>]*type="module"[^>]*src="\/static\/[^"]+\.js"/);
    assert.match(html, /<link\b[^>]*rel="stylesheet"[^>]*href="\/static\/[^"]+\.css"/);
  });

  await t.test('serves the built grid gzip and honors the requested encoding', async t => {
    const original = await readFile(path.join(frontend, 'public', gridAsset));
    const compact = await readFile(path.join(frontend, 'build', gridAsset));
    const compressed = await readFile(path.join(frontend, 'build', `${gridAsset}.gz`));
    const url = `${base}/${gridAsset}`;
    for (const [encoding, useGzip] of [
      ['gzip', true], ['br, GZIP; q=0.5', true], ['identity', false], [undefined, false], ['br', false],
      ['br, gzip;q=0', false], ['gzip;q=0.000, *;q=1', false],
    ]) {
      const expected = useGzip ? compressed : compact;
      const response = await getRawResponse(url, { encoding });
      assert.equal(response.status, 200, encoding);
      assert.equal(response.headers['content-type'], 'application/geo+json', encoding);
      assert.equal(response.headers['vary'], 'Accept-Encoding', encoding);
      assert.equal(response.headers['cache-control'], 'no-cache', encoding);
      assert.equal(response.headers['content-encoding'], useGzip ? 'gzip' : undefined, encoding);
      assert.equal(response.headers.etag, etagFor(expected), encoding);
      assert.equal(Number(response.headers['content-length']), expected.length, encoding);
      assert.ok(response.body.equals(expected), `unexpected HTTP body for ${encoding ?? 'no encoding header'}`);
    }

    for (const encoding of ['gzip', 'gzip;q=0']) {
      const head = await getRawResponse(url, { encoding, method: 'HEAD' });
      const get = await getRawResponse(url, { encoding });
      assert.equal(head.status, get.status);
      assert.equal(head.body.length, 0);
      for (const header of ['content-type', 'content-length', 'content-encoding', 'cache-control', 'vary', 'etag']) {
        assert.equal(head.headers[header], get.headers[header], header);
      }
    }

    assert.deepEqual(gunzipSync(compressed), compact);
    const originalFeatures = JSON.parse(original).features;
    const compactFeatures = JSON.parse(compact).features;
    assert.equal(compactFeatures.length, originalFeatures.length);
    for (const [index, feature] of compactFeatures.entries()) {
      const { type, id, geometry, properties } = originalFeatures[index];
      assert.equal(id, properties.FID);
      assert.deepEqual(feature, { type, properties: { FID: properties.FID }, geometry });
    }
    assert.ok(compact.length <= original.length * 0.4, 'compact GeoJSON must reduce decoded bytes by at least 60%');
    const previousGzip = gzipSync(original, { level: 6 });
    assert.ok(compressed.length <= previousGzip.length * 0.75, 'compact GeoJSON must reduce gzip bytes by at least 25%');
    t.diagnostic(`GeoJSON HTTP body: ${compact.length} bytes uncompressed, ${compressed.length} bytes gzip`);
  });

  await t.test('revalidates both grid encodings with zero-body GET and HEAD responses', async t => {
    const url = `${base}/${gridAsset}`;
    const gzip = await getRawResponse(url, { encoding: 'gzip' });
    const raw = await getRawResponse(url, { encoding: 'identity' });
    assert.notEqual(gzip.headers.etag, raw.headers.etag);

    for (const [encoding, response] of [['gzip', gzip], ['gzip;q=0', raw]]) {
      const etag = response.headers.etag;
      for (const [method, ifNoneMatch] of [
        ['GET', etag], ['GET', `"other,tag", W/${etag}`], ['GET', '*'], ['HEAD', etag],
      ]) {
        const checked = await getRawResponse(url, { encoding, method, ifNoneMatch });
        assert.equal(checked.status, 304);
        assert.equal(checked.body.length, 0);
        assert.equal(checked.headers['content-length'], undefined);
        assert.equal(checked.headers.etag, etag);
        assert.equal(checked.headers['cache-control'], 'no-cache');
        assert.equal(checked.headers.vary, 'Accept-Encoding');
      }
    }

    const crossEncoding = await getRawResponse(url, { encoding: 'gzip;q=0', ifNoneMatch: gzip.headers.etag });
    assert.equal(crossEncoding.status, 200);
    assert.equal(crossEncoding.headers.etag, raw.headers.etag);
    assert.ok(crossEncoding.body.equals(raw.body));
    t.diagnostic('Revalidated grid HTTP body: 0 bytes for both encodings');
  });

  await t.test('falls back to the original GeoJSON without a precompressed file', async t => {
    const build = path.join(frontend, 'build');
    const fixture = await mkdtemp(path.join(build, 'geojson-test-'));
    const file = path.join(fixture, 'uncompressed.geojson');
    t.after(async () => {
      await rm(file, { force: true });
      await rmdir(fixture);
    });
    const original = Buffer.from('{"type":"FeatureCollection","features":[]}');
    await writeFile(file, original);
    const url = `${base}/${path.basename(fixture)}/${path.basename(file)}`;
    const response = await getRawResponse(url, { encoding: 'gzip' });
    assert.equal(response.status, 200);
    assert.equal(response.headers['content-encoding'], undefined);
    assert.equal(Number(response.headers['content-length']), original.length);
    assert.deepEqual(response.body, original);
  });

  await t.test('detects a changed grid at the same URL and supports older build artifacts', async t => {
    const temporaryRoot = os.tmpdir();
    const fixture = await mkdtemp(path.join(temporaryRoot, 'satgpt-grid-gateway-'));
    t.after(async () => {
      assert.match(path.relative(temporaryRoot, fixture), /^satgpt-grid-gateway-[\w-]+$/);
      await rm(fixture, { recursive: true, force: true });
    });
    const grid = path.join(fixture, 'build', gridAsset);
    await mkdir(path.dirname(grid), { recursive: true });
    await Promise.all(['server.cjs', 'projectEnv.cjs', 'precompress-grid.cjs']
      .map(file => copyFile(path.join(frontend, file), path.join(fixture, file))));
    const publish = async version => {
      const content = Buffer.from(JSON.stringify({ type: 'FeatureCollection', features: [], name: version }));
      await writeFile(grid, content);
      await runFile(process.execPath, [path.join(fixture, 'precompress-grid.cjs')], { windowsHide: true });
      return content;
    };

    const original = await publish('v1');
    const fixtureBase = await startGateway(t, backendPort, fixture);
    const url = `${fixtureBase}/${gridAsset}`;
    const encoding = 'gzip';
    const before = await getRawResponse(url, { encoding });
    assert.deepEqual(gunzipSync(before.body), original);
    const updated = await publish('v2');
    assert.equal(updated.length, original.length);
    const after = await getRawResponse(url, { encoding, ifNoneMatch: before.headers.etag });
    assert.equal(after.status, 200);
    assert.notEqual(after.headers.etag, before.headers.etag);
    assert.deepEqual(gunzipSync(after.body), updated);
    const revalidated = await getRawResponse(url, { encoding, ifNoneMatch: after.headers.etag });
    assert.equal(revalidated.status, 304);
    assert.equal(revalidated.body.length, 0);

    await rm(`${grid}.gz`);
    const identity = await getRawResponse(url, { encoding, ifNoneMatch: after.headers.etag });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers['content-encoding'], undefined);
    assert.equal(identity.headers.etag, etagFor(updated));
    assert.deepEqual(identity.body, updated);
    assert.equal((await getRawResponse(url, { encoding, ifNoneMatch: identity.headers.etag })).status, 304);

    await rm(`${grid}.etag.json`);
    const legacy = await getRawResponse(url, { encoding, ifNoneMatch: identity.headers.etag });
    assert.equal(legacy.status, 200);
    assert.equal(legacy.headers.etag, undefined);
    assert.deepEqual(legacy.body, updated);
  });

  await t.test('serves public runtime Mapbox config without exposing backend secrets', async t => {
    const response = await getRawResponse(`${base}/runtime-config.js`);
    assert.equal(response.status, 200);
    assert.match(response.headers['content-type'], /javascript/);
    assert.equal(response.headers['cache-control'], 'no-store');
    const text = response.body.toString('utf8');
    assert.match(text, /window\.__SATGPT_RUNTIME_CONFIG__\s*=/);
    assert.doesNotMatch(text, /DEEPSEEK_API_KEY|AIHUBMIX_API_KEY|OPENAI_API_KEY|PRIVATE KEY/i);
  });
});
