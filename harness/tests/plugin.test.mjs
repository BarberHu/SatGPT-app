import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('GEE plugin requires a native bound session and delegates checks to the Python worker', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'satgpt-plugin-'));
  const id = 'satgpt-' + 'a'.repeat(32);
  const control = path.join(folder, 'control');
  Object.assign(process.env, { WEBGIS_ROOT: root, SATGPT_RUN_BINDINGS: folder,
    SATGPT_HARNESS_PYTHON: process.env.PYTHON || 'python',
    SATGPT_CONTROL_TOKEN: 'test-token', SATGPT_CONTROL_PORT_FILE: control });
  await fs.writeFile(path.join(folder, id + '.json'), JSON.stringify({
    session_id: id, run_id: 'test', owner_id: 'b'.repeat(32), bounds: [100, 10, 101, 11],
  }));
  const { apply } = await import('../integrations/gee-tools/index.js');
  const registered = [];
  const disposers = [];
  let guard;
  apply({ tools: { register: tool => registered.push(tool), guard: callback => { guard = callback; } },
    on: (event, callback) => { if (event === 'dispose') disposers.push(callback); },
    agents: { get: () => undefined } });
  try {
    const check = registered.find(tool => tool.name === 'gee_check');
    const layer = registered.find(tool => tool.name === 'gee_layer');
    const exec = { agent: { session: { id } } };
    assert.ok(layer.parameters.properties.bounds);
    await assert.rejects(check.execute({ code: 'result=1' }, {}), /No active SatGPT run/);
    assert.match(guard({ ...exec, name: 'terminal' }), /unavailable/);
    assert.equal(guard({ ...exec, name: 'gee_check' }), undefined);
    assert.equal((await check.execute({ code: 'result = ee.Image(1)' }, exec)).valid, true);
    assert.equal((await check.execute({ code: 'import os\nresult = 1' }, exec)).valid, false);
    await assert.rejects(layer.execute({ name: 'Wrong location', code: 'result = ee.Image(1)',
      bounds: [119, 31, 114, 35] }, exec), /bounds/);
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
