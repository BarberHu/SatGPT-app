import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerClient } from '../integrations/gee-tools/worker-client.js';

test('queued calls share a resident Python worker and keep replies paired', async () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const client = new WorkerClient({ python: process.env.PYTHON || 'python',
    worker: path.join(directory, 'fake_worker.py'), cwd: directory });
  try {
    const [first, second] = await Promise.all([
      client.run({ value: 'a' }, { timeout: 5000 }),
      client.run({ value: 'b' }, { timeout: 5000 }),
    ]);
    assert.deepEqual([first.value, second.value], ['a', 'b']);
    assert.deepEqual([first.count, second.count], [1, 2]);
    assert.equal(first.pid, second.pid);
    assert.notEqual(first.pid, process.pid);
  } finally {
    client.child?.kill();
  }
});
