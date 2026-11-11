import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerClient } from '../integrations/gee-tools/worker-client.js';

test('GEE plugin captures task geometry and identity before persistent-worker queue execution', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'satgpt-region-'));
  const file = path.join(directory, 'context.json');
  const geometry = {type:'Polygon',coordinates:[[[100,10],[101,10],[100,11],[100,10]]]};
  const first = {task_id:'one',conversation_id:'a',bounds:[100,10,101,11],analysis_region:geometry};
  const original = WorkerClient.prototype.run;
  const previous = process.env.SATGPT_ANALYSIS_CONTEXT;
  const payloads = [];
  WorkerClient.prototype.run = async function(payload) { payloads.push(payload); return {result:payload.analysis_context}; };
  process.env.SATGPT_ANALYSIS_CONTEXT = file;
  try {
    await fs.writeFile(file, JSON.stringify(first));
    const { apply } = await import('../integrations/gee-tools/index.js');
    const registered = []; apply({tools:{register:tool => registered.push(tool)}});
    const evaluate = registered.find(tool => tool.name === 'gee_eval');
    const result = await evaluate.execute({code:'result = analysis_region.area().getInfo()'}, {});
    await fs.writeFile(file, JSON.stringify({...first,task_id:'two',conversation_id:'b',analysis_region:null}));
    await evaluate.execute({code:'result = analysis_region_geojson'}, {});
    assert.deepEqual(result.result, first);
    assert.deepEqual(payloads[0].analysis_context.analysis_region, geometry);
    assert.equal(payloads[1].analysis_context.analysis_region, null);
    assert.equal(payloads[1].analysis_context.task_id, 'two');
    assert.notEqual(payloads[0].analysis_context.conversation_id, payloads[1].analysis_context.conversation_id);
  } finally {
    WorkerClient.prototype.run = original;
    previous === undefined ? delete process.env.SATGPT_ANALYSIS_CONTEXT : process.env.SATGPT_ANALYSIS_CONTEXT = previous;
    await fs.rm(directory, {recursive:true,force:true});
  }
});
