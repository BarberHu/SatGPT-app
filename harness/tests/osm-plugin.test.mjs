import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { registerTools } from '../integrations/osm-tools/index.js';
import { WorkerPool } from '../integrations/gee-tools/worker-pool.js';

test('OSM tools expose bounded parameters and retain task-owned geometry/artifact metadata', async () => {
  const tools = new Map();
  const bound = { owner_id: 'owner', run_id: 'run', task_id: 'task', bounds: [1, 2, 3, 4],
    analysis_region: { type: 'Polygon' }, artifact_dir: '/task', geo_context: { task_id: 'task' } };
  const seen = [];
  const pool = { async run(owner, payload, options) {
    seen.push({ owner, payload, ...options });
    return { summary: { count: 1, attribution: 'OpenStreetMap', osm_data_time: '2026-11-01',
      data_ref: 'g_' + 'b'.repeat(32), examples: ['external name'], geometry: bound.analysis_region }, artifact_ref: 'a'.repeat(32) };
  } };
  registerTools({ tools: { register: tool => tools.set(tool.name, tool) } }, pool,
    session => session === 'allowed' ? bound : null);
  assert.deepEqual([...tools.keys()], ['osm_roads', 'osm_pois', 'osm_buildings']);
  const signal = new AbortController().signal;
  const exec = { agent: { session: { id: 'allowed' } }, signal };
  const types = { osm_roads: 'line', osm_pois: 'circle', osm_buildings: 'fill' };
  const categories = { osm_roads: 'major', osm_pois: 'school', osm_buildings: null };
  for (const [name, tool] of tools) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert(!('bounds' in tool.parameters.properties));
    await assert.rejects(tool.execute({}, { agent: { session: { id: 'other' } } }), /active SatGPT task/);
    const result = await tool.execute({ show_on_map: name === 'osm_buildings', bounds: ['ignored'],
      artifact_dir: '/ignored', ...(name === 'osm_pois' && { category: 'school' }) }, exec);
    assert.equal(result.layer.renderAs, types[name]);
    assert.equal(result.layer.visible, name === 'osm_buildings');
    const rendered = JSON.parse(tool.output.render({}, result)[0].text);
    assert.equal(rendered.artifact_ref, 'a'.repeat(32));
    assert.equal(rendered.data_ref, 'g_' + 'b'.repeat(32));
    assert(!('examples' in rendered) && !('geometry' in rendered));
    assert.equal(tool.output.presentationMeta({}, result).task_id, 'task');
    assert.equal(seen.at(-1).owner, 'owner');
    assert.equal(seen.at(-1).payload.category, categories[name]);
    assert.deepEqual(seen.at(-1).payload.bounds, bound.bounds);
    assert.equal(seen.at(-1).payload.artifact_dir, '/task');
    assert.equal(seen.at(-1).payload.geo_context, bound.geo_context);
    assert.equal(seen.at(-1).timeout, name === 'osm_buildings' ? 90_000 : 22_000);
    assert.equal(seen.at(-1).signal, signal);
  }
});

test('roads with a saved flood reference use the original scope and reject unknown references', async () => {
  const tools = new Map();
  const ref = 'a'.repeat(32);
  const original = { type: 'Polygon', coordinates: [] };
  const bound = { bounds: [10, 20, 30, 40], analysis_region: null, flood_results: {
    [ref]: { bounds: [1, 2, 3, 4], analysis_region: original },
  } };
  const seen = [];
  registerTools({ tools: { register: tool => tools.set(tool.name, tool) } }, {
    async run(_, payload) { seen.push(payload); return { summary: { status: 'empty', count: 0 } }; },
  }, () => bound);
  const exec = { agent: { session: { id: 'allowed' } } };
  await assert.rejects(tools.get('osm_roads').execute({ flood_ref: 'b'.repeat(32) }, exec), /unavailable/);
  await tools.get('osm_roads').execute({ flood_ref: ref }, exec);
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].bounds, [1, 2, 3, 4]);
  assert.equal(seen[0].analysis_region, original);
  assert.equal(seen[0].flood_ref, ref);
});

test('OSM plugin omits layers for empty, failing, or cancelled queries', async () => {
  const tools = new Map();
  const control = new AbortController();
  const exec = { agent: { session: { id: 'active' } }, signal: control.signal };
  let reply;
  registerTools({ tools: { register: tool => tools.set(tool.name, tool) } },
    { run: async () => reply }, () => ({ bounds: [1, 2, 3, 4] }));
  const tool = tools.get('osm_pois');
  for (const show_on_map of [true, false]) {
    const args = { category: 'hospital', show_on_map };
    reply = { summary: { status: 'empty', count: 0 } };
    let value = await tool.execute(args, exec);
    assert.deepEqual(value, reply);
    assert.deepEqual(tool.output.presentationMeta(args, value), {});

    for (const code of ['area_limit', 'osm_timeout']) {
      reply = { error: { code, message: 'Query could not complete.' } };
      value = await tool.execute(args, exec);
      assert.deepEqual(value, { summary: { status: code, message: reply.error.message } });
      assert.deepEqual(tool.output.presentationMeta(args, value), {});
    }
  }
  control.abort();
  await assert.rejects(tool.execute({ category: 'hospital' }, exec), /cancelled/);
});

test('the OSM worker pool releases a cancelled queued query without starting it', async () => {
  const pool = new WorkerPool({ service: 'OSM' }, 1, 2);
  let finish;
  pool.slots[0].run = () => new Promise(resolve => { finish = resolve; });
  const running = pool.run('first', {}, { timeout: 500 });
  const abort = new AbortController();
  const waiting = pool.run('second', {}, { timeout: 500, signal: abort.signal });
  abort.abort();
  await assert.rejects(waiting, /cancelled/);
  finish('done');
  assert.equal(await running, 'done');
  assert.equal(pool.waitCount, 0);
  await pool.close();
});

test('the joint GEE tool requires a bound session and honors cancellation before execution', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gee-osm-tool-'));
  const id = 'satgpt-' + 'a'.repeat(32);
  const disposers = [];
  try {
    Object.assign(process.env, { SATGPT_OSM_TOOLS: '1', SATGPT_RUN_BINDINGS: directory,
      SATGPT_CONTROL_TOKEN: 'test-token', SATGPT_CONTROL_PORT_FILE: path.join(directory, 'port') });
    await fs.writeFile(path.join(directory, id + '.json'), JSON.stringify({
      session_id: id, owner_id: 'b'.repeat(32), task_id: 'c'.repeat(32), artifact_dir: directory,
    }));
    const { apply } = await import('../integrations/gee-tools/index.js');
    const registered = new Map();
    let guard;
    apply({ tools: { register: tool => registered.set(tool.name, tool), guard: applyGuard => { guard = applyGuard; } },
      systemPrompt: { section() {} },
      on(event, callback) { if (event === 'dispose') disposers.push(callback); } });
    const tool = registered.get('gee_osm_analyze');
    const abort = new AbortController();
    abort.abort();
    const exec = { agent: { session: { id } }, signal: abort.signal, name: tool.name };
    assert.equal(guard(exec), undefined);
    assert.equal(tool.parameters.additionalProperties, false);
    assert(!('artifact_dir' in tool.parameters.properties));
    const args = { osm_ref: 'a'.repeat(32) };
    await assert.rejects(tool.execute(args, {}), /No active SatGPT run/);
    await assert.rejects(tool.execute(args, exec), /cancelled/);
    await assert.rejects(tool.execute({ ...args, osm_data_ref: 'g_' + 'b'.repeat(32) }, exec), /exactly one/);
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    await fs.rm(directory, { recursive: true, force: true });
  }
});
