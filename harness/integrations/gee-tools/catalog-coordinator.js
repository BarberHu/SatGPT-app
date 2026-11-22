const RETRY_MS = 60_000;

function waitFor(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(new Error('Tool call cancelled'));
  }
  return new Promise((resolve, reject) => {
    const cancel = () => reject(new Error('Tool call cancelled'));
    signal.addEventListener('abort', cancel, { once: true });
    const settle = callback => value => {
      signal.removeEventListener('abort', cancel);
      callback(value);
    };
    promise.then(settle(resolve), settle(reject));
  });
}

/** One in-flight refresh for the shared runtime's catalog directory. */
export class CatalogCoordinator {
  constructor(read, rebuild, now = Date.now) {
    this.read = read;
    this.rebuild = rebuild;
    this.now = now;
    this.refreshing = null;
    this.generation = 0;
    this.retryAt = 0;
  }

  refresh(owner, observe, explicit) {
    if (this.refreshing) return this.refreshing;
    if (!explicit && this.now() < this.retryAt) {
      return Promise.reject(new Error('Earth Engine catalog refresh is temporarily unavailable'));
    }
    this.refreshing = Promise.resolve().then(() => this.rebuild(owner, observe)).then(value => {
      this.generation++;
      this.retryAt = 0;
      return value;
    }, error => {
      this.retryAt = this.now() + RETRY_MS;
      throw error;
    }).finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  async search(owner, payload, { signal, observe } = {}) {
    if (signal?.aborted) throw new Error('Tool call cancelled');
    if (payload.refresh) {
      await waitFor(this.refresh(owner, observe, true), signal);
      return this.readRefreshed(owner, payload, signal, observe);
    }
    const generation = this.generation;
    const cached = await this.read(owner, payload, signal, observe);
    if (cached.cache_state === 'fresh') return cached;
    if (cached.cache_state === 'stale') {
      if (generation === this.generation) this.refresh(owner, observe, false).catch(() => {});
      return cached;
    }
    if (signal?.aborted) throw new Error('Tool call cancelled');
    if (generation === this.generation) await waitFor(this.refresh(owner, observe, false), signal);
    return this.readRefreshed(owner, payload, signal, observe);
  }

  async readRefreshed(owner, payload, signal, observe) {
    const refreshed = await this.read(owner, payload, signal, observe);
    if (refreshed.cache_state === 'missing') throw new Error('The refreshed Earth Engine catalog is unavailable');
    return { ...refreshed, rebuilt: true };
  }
}
