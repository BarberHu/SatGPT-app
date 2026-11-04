import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

test('GEE plugin registers tools and delegates code checks to Python', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  process.env.WEBGIS_ROOT = root;
  process.env.SATGPT_HARNESS_PYTHON = process.env.PYTHON || 'python';
  const { apply, stopWorker } = await import('../integrations/gee-tools/index.js');
  const registered = [];
  apply({ tools: { register: tool => registered.push(tool) } });
  const check = registered.find(tool => tool.name === 'gee_check');
  assert.ok(check);
  const layer = registered.find(tool => tool.name === 'gee_layer');
  assert.ok(layer);
  assert.ok(layer.parameters.properties.bounds);
  try {
    const valid = await check.execute({ code: 'result = ee.Image("USGS/SRTMGL1_003")' }, {});
    const invalid = await check.execute({ code: 'import os\nresult = 1' }, {});
    assert.equal(valid.valid, true);
    assert.equal(invalid.valid, false);
    await assert.rejects(layer.execute({ name: 'Wrong location', code: 'result = ee.Image(1)',
      bounds: [119, 31, 114, 35] }, {}), /bounds/);
  } finally {
    stopWorker();
  }
});
