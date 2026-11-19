import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { WorkerClient } from '../integrations/gee-tools/worker-client.js';

test('tools capture separate native session bindings and do not accept model-owned paths', async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'satgpt-region-'));
  const geometry = {type:'Polygon', coordinates:[[[100,10],[101,10],[100,11],[100,10]]]};
  const first = {task_id:'one', conversation_id:'a', bounds:[100,10,101,11], analysis_region:geometry};
  const second = {task_id:'two', conversation_id:'b', bounds:[110,10,111,11], analysis_region:null};
  const oldRun = WorkerClient.prototype.run;
  const seen = [];
  WorkerClient.prototype.run = async function(payload) {
    seen.push(payload);
    return { result: payload.analysis_context };
  };
  process.env.SATGPT_RUN_BINDINGS = folder;
  try {
    const ids = ['satgpt-' + 'a'.repeat(32), 'satgpt-' + 'b'.repeat(32)];
    await Promise.all([first,second].map((value,index) =>
      fs.writeFile(path.join(folder, ids[index]+'.json'), JSON.stringify({
        ...value, session_id:ids[index], run_id:'native-run', owner_id:'native-owner-' + index,
        artifact_dir:path.join(folder, 'actual-' + index),
      }))));
    const { runWithContext } = await import('../integrations/gee-tools/index.js');
    const results = await Promise.all(ids.map(id => runWithContext(
      {operation:'eval', code:'result = analysis_region_geojson', artifact_dir:'client path'}, {agent:{session:{id}}})));
    assert.deepEqual(results.map(value => value.result), [first,second]);
    assert.deepEqual(seen.map(value => path.basename(value.artifact_dir)), ['actual-0','actual-1']);
  } finally {
    WorkerClient.prototype.run = oldRun;
    delete process.env.SATGPT_RUN_BINDINGS;
    await fs.rm(folder, { recursive:true, force:true });
  }
});
