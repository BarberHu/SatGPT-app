import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setImmediate as nextTurn, setTimeout as sleep } from 'node:timers/promises';
import { test } from 'node:test';

const auth = { Authorization: 'Bearer test-token' };
const fakeWorker = `import json, os, sys, time
from pathlib import Path
root = Path(__file__).parent.parent
for line in sys.stdin:
    call = json.loads(line)
    operation = call['payload']['operation']
    if operation == 'layer_thumbnail_warmup':
        (root / 'warm.pid').write_text(str(os.getpid()))
        while not (root / 'release').exists():
            time.sleep(.01)
        ok = not (root / 'fail').exists()
        answer = {'ok': ok, 'data': {'initialized': True}, 'error': 'initialization failed'}
    else:
        answer = {'ok': True, 'data': {'pid': os.getpid(), 'operation': operation}}
    print(json.dumps({'id': call['id'], **answer}), flush=True)
`;

async function waitFor(read, budget = 5000) {
  const until = Date.now() + budget;
  do {
    const value = await read();
    if (value) return value;
    await sleep(20);
  } while (Date.now() < until);
  assert.fail('Timed out waiting for worker fixture');
}

async function fixture(t, { delayScheduling = false, fail = false, closeImmediately = false } = {}) {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'satgpt-thumbnail-warmup-'));
  const control = path.join(folder, 'port');
  const timing = path.join(folder, 'timing.jsonl');
  const values = { WEBGIS_ROOT: folder, SATGPT_HARNESS_PYTHON: process.env.PYTHON || 'python',
    GEE_PROJECT_ID: 'fixture', SATGPT_CONTROL_TOKEN: 'test-token', SATGPT_CONTROL_PORT_FILE: control,
    SATGPT_HARNESS_TIMING_LOG: timing, SATGPT_CATALOG_CACHE: '' };
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  Object.assign(process.env, values);
  const disposers = [];
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    await Promise.all(disposers.map(callback => callback()));
  };
  t.after(async () => {
    try { await dispose(); }
    finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(folder, { recursive: true, force: true });
    }
  });
  await fs.mkdir(path.join(folder, 'app'));
  await fs.writeFile(path.join(folder, 'app', 'gee_worker.py'), fakeWorker);
  if (fail) await fs.writeFile(path.join(folder, 'fail'), '');
  const moduleUrl = new URL('../integrations/gee-tools/index.js', import.meta.url);
  moduleUrl.searchParams.set('fixture', path.basename(folder));
  const {apply} = await import(moduleUrl);
  const ctx = { tools: { register() {}, guard() {} },
    systemPrompt: { section() {} },
    on(event, callback) { if (event === 'dispose') disposers.push(callback); } };
  let launch;
  if (delayScheduling) {
    const schedule = globalThis.setImmediate;
    const mock = t.mock.method(globalThis, 'setImmediate', callback => {
      launch = callback;
      return schedule(() => {});
    });
    try { apply(ctx); } finally { mock.mock.restore(); }
    assert.equal(typeof launch, 'function');
  } else {
    apply(ctx);
  }
  const read = async file => fs.readFile(file, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return null;
  });
  if (closeImmediately) await dispose();
  const url = closeImmediately ? null : 'http://127.0.0.1:' + await waitFor(() => read(control));
  const warmPid = () => read(path.join(folder, 'warm.pid'));
  const events = async () => (await read(timing) || '').trim().split('\n').filter(Boolean).map(JSON.parse);
  const event = (operation, phase) => waitFor(async () =>
    (await events()).find(row => row.operation === operation && row.event === phase), 20_000);
  const render = async () => {
    const response = await fetch(url+'/thumbnail', { method: 'POST', headers: {...auth, 'Content-Type': 'application/json'},
      body: JSON.stringify({ owner_id: 'a'.repeat(32), payload: {}, tool_call_id: 'render-test' }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  return { health: () => fetch(url+'/health', {headers: auth}), warmPid, events, event, render, dispose, launch,
    release: () => fs.writeFile(path.join(folder, 'release'), '') };
}

test('control health stays ready during warmup and an overlapping render reuses the warming process', async t => {
  const runtime = await fixture(t);
  const pid = await waitFor(runtime.warmPid);
  assert.equal((await runtime.health()).status, 200);
  const rendered = runtime.render();
  await runtime.event('layer_thumbnail', 'enqueued');
  await runtime.release();
  const result = await rendered;
  assert.equal(result.operation, 'layer_thumbnail');
  assert.equal(result.pid, Number(pid));
  assert.equal((await runtime.event('layer_thumbnail_warmup', 'returned')).outcome, 'ok');
});

test('a render admitted before the scheduled warmup suppresses the startup request', async t => {
  const runtime = await fixture(t, {delayScheduling: true});
  const result = await runtime.render();
  assert.equal(result.operation, 'layer_thumbnail');
  runtime.launch();
  assert.equal(await runtime.warmPid(), null);
  assert.deepEqual((await runtime.events()).map(row => row.operation), ['layer_thumbnail', 'layer_thumbnail']);
});

test('a failed warmup leaves health ready and permits a render without background retries', async t => {
  const runtime = await fixture(t, {fail: true});
  await waitFor(runtime.warmPid);
  await runtime.release();
  assert.equal((await runtime.event('layer_thumbnail_warmup', 'returned')).outcome, 'worker_error');
  assert.equal((await runtime.health()).status, 200);
  assert.equal((await runtime.render()).operation, 'layer_thumbnail');
  assert.equal((await runtime.events()).filter(row => row.operation === 'layer_thumbnail_warmup' && row.event === 'claimed').length, 1);
});

test('a timed-out warmup frees the one slot and the waiting render starts a new process', {timeout: 23_000}, async t => {
  const runtime = await fixture(t);
  const pid = await waitFor(runtime.warmPid);
  const rendered = runtime.render();
  const terminal = await runtime.event('layer_thumbnail_warmup', 'returned');
  assert.equal(terminal.outcome, 'worker_timeout');
  assert.notEqual((await rendered).pid, Number(pid));
});

test('disposing with a blocked warmup settles the worker as cancelled', async t => {
  const runtime = await fixture(t);
  await waitFor(runtime.warmPid);
  await runtime.dispose();
  assert.equal((await runtime.event('layer_thumbnail_warmup', 'returned')).outcome, 'cancelled');
});

test('disposing before dispatch cancels the scheduled warmup', async t => {
  const runtime = await fixture(t, {closeImmediately: true});
  await nextTurn();
  assert.equal(await runtime.warmPid(), null);
  assert.deepEqual(await runtime.events(), []);
});
