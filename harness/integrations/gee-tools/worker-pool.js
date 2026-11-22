import { WorkerClient } from './worker-client.js';

/** Fixed-size lazy pool, with bounded waiting and round-robin owners. */
export class WorkerPool {
  constructor(options, size, limit = 128) {
    this.service = options.service || 'GEE';
    this.slots = Array.from({ length: size }, () => new WorkerClient(options));
    this.idle = [...this.slots];
    this.waiting = new Map();
    this.limit = limit;
    this.ownerLimit = Math.ceil(limit / 2);
    this.waitCount = 0;
    this.closed = false;
  }

  run(owner, payload, { signal, timeout, observe }) {
    const record = observe ? (event, fields) => observe({ event, at_ms: Date.now(), waiting: this.waitCount, ...fields }) : undefined;
    if (this.closed || signal?.aborted) {
      record?.('returned', { outcome: 'cancelled', worker_stages_reported: false });
      return Promise.reject(new Error('Tool call cancelled'));
    }
    const deadline = Date.now() + timeout;
    if (this.idle.length && !this.waitCount) {
      return this.execute(this.idle.shift(), payload, signal, deadline, record, false);
    }
    if (this.waitCount >= this.limit || (this.waiting.get(owner)?.length || 0) >= this.ownerLimit) {
      record?.('rejected', { reason: this.waitCount >= this.limit ? 'global_limit' : 'owner_limit', worker_stages_reported: false });
      return Promise.reject(new Error(this.service + ' worker queue is full'));
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
        record?.('returned', { outcome, worker_stages_reported: false });
        reject(error);
      };
      const abort = () => remove(new Error('Tool call cancelled'), 'cancelled');
      const timer = setTimeout(() => remove(new Error(this.service + ' worker wait timed out'), 'wait_timeout'), timeout);
      const entry = { cleanup, remove, resolve, reject, payload, signal, deadline, record };
      signal?.addEventListener('abort', abort, { once: true });
      queue.push(entry);
      this.waiting.set(owner, queue);
      this.waitCount++;
      record?.('enqueued');
    });
  }

  async execute(slot, payload, signal, deadline, record, queued) {
    record?.('claimed', { queued });
    let stagesReported = false;
    let requests;
    const timing = () => ({ worker_stages_reported: stagesReported, http_requests: requests });
    const onTiming = record && ((stages, count) => {
      if (!Array.isArray(stages)) return;
      stagesReported = true;
      if (Number.isSafeInteger(count) && count >= 0) requests = count;
      for (const { stage, duration_ms, outcome } of stages) {
        if (typeof stage === 'string' && Number.isFinite(duration_ms) && duration_ms >= 0
            && ['ok', 'error'].includes(outcome)) {
          record('worker_stage', { stage, duration_ms, outcome });
        }
      }
    });
    try {
      const result = await slot.run(payload, { signal, timeout: Math.max(1, deadline - Date.now()), onTiming });
      record?.('returned', { outcome: 'ok', ...timing() });
      return result;
    } catch (error) {
      const outcome = signal?.aborted || this.closed ? 'cancelled'
        : error?.message === this.service + ' worker timed out' ? 'worker_timeout'
        : error?.message?.startsWith(this.service + ' worker exited') ? 'worker_exited' : 'worker_error';
      record?.('returned', { outcome, ...timing() });
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
      for (const entry of [...entries]) entry.remove(new Error(this.service + ' worker pool is closing'), 'cancelled');
    }
    await Promise.all(this.slots.map(slot => slot.close()));
  }
}
