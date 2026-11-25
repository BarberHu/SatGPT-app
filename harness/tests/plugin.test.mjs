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
    SATGPT_FLEXTH_PYTHON: '',
    SATGPT_CONTROL_TOKEN: 'test-token', SATGPT_CONTROL_PORT_FILE: control });
  await fs.writeFile(path.join(folder, id + '.json'), JSON.stringify({
    session_id: id, run_id: 'test', owner_id: 'b'.repeat(32), bounds: [100, 10, 101, 11],
  }));
  const { apply } = await import('../integrations/gee-tools/index.js');
  const registered = [];
  const sections = [];
  const disposers = [];
  let onAgentCreated;
  let guard;
  apply({ tools: { register: tool => registered.push(tool), guard: callback => { guard = callback; } },
    systemPrompt: { section: section => sections.push(section) },
    on: (event, callback) => {
      if (event === 'dispose') disposers.push(callback);
      if (event === 'agent/created') onAgentCreated = callback;
    },
    agents: { get: () => undefined } });
  try {
    assert.equal(sections.length, 1);
    assert.equal(sections[0].name, 'satgpt:analysis');
    assert.match(sections[0].text, /Wait for explicit approval of that plan/);
    const check = registered.find(tool => tool.name === 'gee_check');
    const evaluate = registered.find(tool => tool.name === 'gee_eval');
    const layer = registered.find(tool => tool.name === 'gee_layer');
    const population = registered.find(tool => tool.name === 'flood_population_exposure');
    const flexth = registered.find(tool => tool.name === 'flexth_estimate');
    const exec = { agent: { session: { id } } };
    assert.ok(layer.parameters.properties.bounds);
    assert.deepEqual(evaluate.parameters.properties.result_format.enum, ['scene_metadata']);
    assert.deepEqual(population.parameters.required, ['event_id', 'country', 'year', 'exclude_permanent_water']);
    assert.equal(population.parameters.properties.show_on_map.type, 'boolean');
    const populationLayer = { name: 'Population density', url: 'test-tile-url' };
    const populationResult = { exposed_people: 12, map_status: 'published', layer: populationLayer,
      reference: { task_id: 'task', run_id: 'run' }, display_code: 'result = image', thumbnail_ref: 'thumb' };
    assert.deepEqual(JSON.parse(population.output.render({}, populationResult)[0].text),
      { exposed_people: 12, map_status: 'published' });
    assert.deepEqual(population.output.presentationMeta({}, populationResult),
      { task_id: 'task', run_id: 'run', layer: populationLayer, code: 'result = image', thumbnail_ref: 'thumb' });
    assert.deepEqual(population.output.presentationMeta({}, { exposed_people: 0 }), {});
    await assert.rejects(population.execute({ event_id: 4020, country: 'IDN', year: 2013,
      exclude_permanent_water: true }, {}), /No active SatGPT run/);
    const floodArgs = { flood_data_ref: 'g_' + 'a'.repeat(32) };
    await assert.rejects(flexth.execute(floodArgs, {}), /No active SatGPT run/);
    assert.equal((await flexth.execute(floodArgs, exec)).summary.status, 'unavailable');
    await assert.rejects(check.execute({ code: 'result=1' }, {}), /No active SatGPT run/);
    let visible;
    onAgentCreated({ agent: { ctx: { tools: { restrict: rule => { visible = rule.allow; } } } } });
    const webTools = ['web_search', 'web_fetch'];
    assert.deepEqual(new Set(visible), new Set([...registered.map(tool => tool.name), ...webTools, 'skill']));
    for (const name of webTools) {
      assert.equal(guard({ ...exec, name }), undefined);
      assert.match(guard({ name }), /unavailable/);
      assert.match(guard({ name, agent: { session: { id: 'unbound' } } }), /unavailable/);
    }
    const loadSkill = name => ({ ...exec, name: 'skill', arguments: { name } });
    assert.equal(guard(loadSkill('flood-extent')), undefined);
    assert.equal(guard(loadSkill('flood-exposure')), undefined);
    assert.equal(guard(loadSkill('sentinel2-latest')), undefined);
    assert.equal(guard(loadSkill('rainfall-analysis')), undefined);
    assert.match(guard(loadSkill('unrelated-skill')), /unavailable/);
    assert.match(guard({ ...exec, name: 'skill' }), /unavailable/);
    assert.match(guard({ ...loadSkill('flood-extent'), agent: { session: { id: 'unbound' } } }), /unavailable/);
    assert.match(guard({ ...exec, name: 'terminal' }), /unavailable/);
    assert.equal(guard({ ...exec, name: 'gee_check' }), undefined);
    assert.equal((await check.execute({ code: 'result = ee.Image(1)' }, exec)).valid, true);
    assert.equal((await check.execute({ code: 'import os\nresult = 1' }, exec)).valid, false);
    const code = 'result = image.reduceRegion(reducer, analysis_region, 30, None, 1e9)';
    const invalid = await check.execute({ code }, exec);
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors[0], /crsTransform.*line 1.*maxPixels/);
    await assert.rejects(evaluate.execute({ code }, exec), error =>
      error.message === `ValueError: ${invalid.errors[0]}`);
    const dates = 'scenes = ee.ImageCollection("CHIRPS").filterBounds(analysis_region)\n'
      + 'result = scenes.map(lambda image: ee.Date(image.get("system:time_start")).format("YYYY-MM-dd"))';
    const invalidMap = await check.execute({ code: dates }, exec);
    assert.equal(invalidMap.valid, false);
    assert.match(invalidMap.errors[0], /ImageCollection\.map.*line 2.*ee\.List\.map/);
    await assert.rejects(evaluate.execute({ code: dates }, exec), error =>
      error.message === `ValueError: ${invalidMap.errors[0]}`);
    await assert.rejects(layer.execute({ name: 'Wrong location', code: 'result = ee.Image(1)',
      bounds: [119, 31, 114, 35] }, exec), /bounds/);
  } finally {
    await Promise.all(disposers.map(dispose => dispose()));
    await fs.rm(folder, { recursive: true, force: true });
  }
});
