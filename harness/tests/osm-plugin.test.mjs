import assert from 'node:assert/strict';
import test from 'node:test';
import { registerTools } from '../integrations/osm-tools/index.js';
import { WorkerPool } from '../integrations/gee-tools/worker-pool.js';

test('OSM tools expose bounded parameters and retain task-owned geometry/artifact metadata', async () => {
  const tools = new Map();
  const bound = { owner_id: 'owner', run_id: 'run', task_id: 'task', bounds: [1, 2, 3, 4],
    analysis_region: { type: 'Polygon' }, artifact_dir: '/task' };
  const seen = [];
  const pool = { async run(owner, payload, options) {
    seen.push({ owner, payload, signal: options.signal });
    return { summary: { count: 1, attribution: 'OpenStreetMap', osm_data_time: '2026-11-01' }, artifact_ref: 'a'.repeat(32) };
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
    assert.equal(tool.output.presentationMeta({}, result).task_id, 'task');
    assert.equal(seen.at(-1).owner, 'owner');
    assert.equal(seen.at(-1).payload.category, categories[name]);
    assert.deepEqual(seen.at(-1).payload.bounds, bound.bounds);
    assert.equal(seen.at(-1).payload.artifact_dir, '/task');
    assert.equal(seen.at(-1).signal, signal);
  }
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
