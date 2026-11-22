import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CatalogCoordinator } from '../integrations/gee-tools/catalog-coordinator.js';

test('stale reads finish before the shared refresh and cancelled cold readers detach', async () => {
  let state = 'stale', rebuilds = 0, release;
  const delay = new Promise(resolve => { release = resolve; });
  const coordinator = new CatalogCoordinator(async () => ({ cache_state: state, rebuilt: false }), async () => {
    rebuilds++;
    await delay;
    state = 'fresh';
  });
  const snapshots = await Promise.all(Array.from({ length: 6 }, () => coordinator.search('reader', {})));
  assert.ok(snapshots.every(row => row.cache_state === 'stale' && !row.rebuilt));
  assert.equal(rebuilds, 1);
  state = 'missing';
  const abort = new AbortController();
  const cancelled = coordinator.search('cold', {}, { signal: abort.signal });
  const refresh = coordinator.search('explicit', { refresh: true });
  abort.abort();
  await assert.rejects(cancelled, /cancelled/);
  release();
  assert.equal((await refresh).rebuilt, true);
  assert.equal((await coordinator.search('hot', {})).rebuilt, false);
  assert.equal(rebuilds, 1);
});

test('failed background refresh keeps serving stale rows and applies cooldown', async () => {
  let rebuilds = 0;
  const coordinator = new CatalogCoordinator(async () => ({ cache_state: 'stale', matches: ['kept'] }), async () => {
    rebuilds++;
    throw new Error('upstream offline');
  });
  assert.deepEqual((await coordinator.search('one', {})).matches, ['kept']);
  await assert.rejects(coordinator.refreshing, /offline/);
  assert.deepEqual((await coordinator.search('two', {})).matches, ['kept']);
  assert.equal(rebuilds, 1);
  await assert.rejects(coordinator.search('explicit', { refresh: true }), /offline/);
  assert.equal(rebuilds, 2);
});
