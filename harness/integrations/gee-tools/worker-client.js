import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

/** One queued JSON-lines channel keeps GEE initialized across tool calls. */
export class WorkerClient {
  constructor({ python, worker, cwd }) {
    Object.assign(this, { python, worker, cwd });
    this.child = null;
    this.pending = new Map();
    this.buffer = '';
    this.queue = Promise.resolve();
  }

  start() {
    if (this.child) return;
    const child = spawn(this.python, ['-X', 'utf8', '-I', this.worker], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
      env: process.env,
    });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      this.buffer += chunk;
      if (this.buffer.length > 20_000_000) return child.kill();
      let end;
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        try {
          const result = JSON.parse(line);
          const pending = this.pending.get(result.id);
          if (!pending) continue;
          this.pending.delete(result.id);
          result.ok ? pending.resolve(result.data) : pending.reject(new Error(result.error || 'GEE worker failed'));
        } catch (error) {
          this.fail(error);
          child.kill();
        }
      }
    });
    child.stderr.on('data', () => {});
    child.on('error', error => this.fail(error));
    child.on('close', code => {
      this.fail(new Error(`GEE worker exited (${code})`));
      if (this.child === child) this.child = null;
      this.buffer = '';
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  close() {
    this.child?.kill();
    this.child = null;
  }

  run(payload, { signal, timeout }) {
    const queued = this.queue.then(() => this.call(payload, signal, timeout));
    this.queue = queued.catch(() => {});
    return queued;
  }

  call(payload, signal, timeout) {
    if (signal?.aborted) return Promise.reject(new Error('Tool call cancelled'));
    this.start();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const child = this.child;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        child.kill();
        reject(new Error('GEE worker timed out'));
      }, timeout);
      const abort = () => {
        this.pending.delete(id);
        child.kill();
        reject(new Error('Tool call cancelled'));
      };
      const finish = fn => value => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        fn(value);
      };
      this.pending.set(id, { resolve: finish(resolve), reject: finish(reject) });
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(JSON.stringify({ id, payload }) + '\n');
    });
  }
}
