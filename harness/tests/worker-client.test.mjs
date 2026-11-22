import assert from 'node:assert/strict';
import { test } from 'node:test';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkerPool } from '../integrations/gee-tools/worker-pool.js';

const directory = path.dirname(fileURLToPath(import.meta.url));
const options = { python: process.env.PYTHON || 'python', worker: path.join(directory, 'fake_worker.py'), cwd: directory };
const deadline = { timeout: 5000 };

test('fixed worker pool executes calls in different workers and reuses them', async () => {
  const pool = new WorkerPool(options, 2);
  try {
    const [a, b] = await Promise.all([
      pool.run('a', { value: 'a', delay: .1 }, deadline),
      pool.run('b', { value: 'b', delay: .1 }, deadline),
    ]);
    assert.notEqual(a.pid, b.pid);
    const c = await pool.run('c', { value: 'c' }, deadline);
    assert.ok([a.pid, b.pid].includes(c.pid));
    assert.deepEqual([a.value, b.value, c.value], ['a', 'b', 'c']);
    assert.equal(c.count, 2);
  } finally {
    await pool.close();
  }
});

test('cancel removes a queued request and replaces only the running request’s worker', async () => {
  const pool = new WorkerPool(options, 2);
  try {
    const [a, b] = await Promise.all([pool.run('a', { value:'a' }, deadline), pool.run('b', { value:'b' }, deadline)]);
    const active = new AbortController();
    const waiting = new AbortController();
    const activeTiming = [], waitingTiming = [];
    const one = pool.run('a', { value:'cancelled', delay:5 },
      { ...deadline, signal:active.signal, observe:event=>activeTiming.push(event) });
    const two = pool.run('b', { value:'continues', delay:.15 }, deadline);
    const pending = pool.run('c', { value:'queued' },
      { ...deadline, signal:waiting.signal, observe:event=>waitingTiming.push(event) });
    const cancelled = assert.rejects(one, /cancelled/);
    const removed = assert.rejects(pending, /cancelled/);
    waiting.abort();
    active.abort();
    await Promise.all([cancelled, removed]);
    assert.deepEqual(activeTiming.map(event=>event.event), ['claimed', 'returned']);
    assert.deepEqual(waitingTiming.map(event=>event.event), ['enqueued', 'returned']);
    for (const events of [activeTiming, waitingTiming]) {
      assert.equal(events.at(-1).outcome, 'cancelled');
      assert.equal(events.at(-1).worker_stages_reported, false);
    }
    const recovered = await pool.run('d', { value:'recovered' }, deadline);
    const continued = await two;
    assert.equal(continued.value, 'continues');
    assert.ok([a.pid,b.pid].includes(continued.pid));
    assert.ok(![a.pid,b.pid].includes(recovered.pid));
    assert.equal(recovered.count, 1);
  } finally {
    await pool.close();
  }
});

test('worker timeout records a missing phase report and releases the slot', async () => {
  const pool = new WorkerPool(options, 1);
  const timing = [];
  try {
    await assert.rejects(pool.run('a', { value:'late', delay:5 }, { timeout:50, observe:event=>timing.push(event) }), /worker timed out/);
    assert.deepEqual(timing.map(event=>event.event), ['claimed', 'returned']);
    assert.equal(timing.at(-1).outcome, 'worker_timeout');
    assert.equal(timing.at(-1).worker_stages_reported, false);
    assert.equal((await pool.run('a', { value:'next' }, deadline)).value, 'next');
  } finally {
    await pool.close();
  }
});
