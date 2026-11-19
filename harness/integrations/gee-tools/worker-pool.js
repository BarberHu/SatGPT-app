import { WorkerClient } from './worker-client.js';

/** Fixed-size lazy pool, with bounded waiting and round-robin owners. */
export class WorkerPool {
  constructor(options, size, limit = 128) {
    this.slots = Array.from({ length: size }, () => new WorkerClient(options));
    this.idle = [...this.slots];
    this.waiting = new Map();
    this.limit = limit;
    this.ownerLimit = Math.ceil(limit / 2);
    this.waitCount = 0;
    this.closed = false;
  }

  run(owner, payload, { signal, timeout, observe }) {
    const record = (event, fields) => {
      if (observe) observe({ event, at_ms: Date.now(), waiting: this.waitCount, ...fields });
    };
    if (this.closed || signal?.aborted) {
      record('returned', { outcome: 'cancelled' });
      return Promise.reject(new Error('Tool call cancelled'));
    }
    const deadline = Date.now() + timeout;
    if (this.idle.length && !this.waitCount) {
      return this.execute(this.idle.shift(), payload, signal, deadline, record, false);
    }
    if (this.waitCount >= this.limit || (this.waiting.get(owner)?.length || 0) >= this.ownerLimit) {
      record('rejected', { reason: this.waitCount >= this.limit ? 'global_limit' : 'owner_limit' });
      return Promise.reject(new Error('GEE worker queue is full'));
    }
    return new Promise((resolve, reject) => {
      const queue = this.waiting.get(owner) || [];
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
      };
      const remove = (error, outcome) => {
        const index = queue.indexOf(entry);
        if (index < 0) return;
        queue.splice(index, 1);
        if (!queue.length) this.waiting.delete(owner);
        this.waitCount--;
        cleanup();
        record('returned', { outcome });
        reject(error);
      };
      const abort = () => remove(new Error('Tool call cancelled'), 'cancelled');
      const timer = setTimeout(() => remove(new Error('GEE worker wait timed out'), 'wait_timeout'), timeout);
      const entry = { cleanup, remove, resolve, reject, payload, signal, deadline, record };
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(entry);
      this.waiting.set(owner, queue);
      this.waitCount++;
      record('enqueued');
    });
  }

  async execute(slot, payload, signal, deadline, record, queued) {
    record('claimed', { queued });
    try {
      const result = await slot.run(payload, { signal, timeout: Math.max(1, deadline - Date.now()) });
      record('returned', { outcome: 'ok' });
      return result;
    } catch (error) {
      record('returned', { outcome: signal?.aborted ? 'cancelled' : 'worker_error' });
      throw error;
    } finally {
      if (!this.closed) this.release(slot);
    }
  }

  release(slot) {
    const next = this.waiting.entries().next().value;
    if (!next) this.idle.push(slot);
    else {
      const [owner, queue] = next;
      const entry = queue.shift();
      this.waiting.delete(owner);
      if (queue.length) this.waiting.set(owner, queue);
      this.waitCount--;
      entry.cleanup();
      this.execute(slot, entry.payload, entry.signal, entry.deadline, entry.record, true).then(entry.resolve, entry.reject);
    }
  }

  async close() {
    this.closed = true;
    for (const entries of [...this.waiting.values()]) {
      for (const entry of [...entries]) entry.remove(new Error('GEE worker pool is closing'), 'cancelled');
    }
    await Promise.all(this.slots.map(slot => slot.close()));
  }
}
