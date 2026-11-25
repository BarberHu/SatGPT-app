import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_RESPONSE = 20_000_000;

/** A resident JSON-lines worker. A slot is reusable only once its old child exits. */
export class WorkerClient {
  constructor({ python, worker, cwd, service = 'GEE', endpoint, geocodingLockFile, roadSnapshot, osmSnapshotDir }) {
    Object.assign(this, { python, worker, cwd, service, endpoint, geocodingLockFile, roadSnapshot, osmSnapshotDir });
    this.child = null;
    this.pending = null;
    this.buffer = '';
  }

  start() {
    if (this.child) return this.child;
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
      /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|LANG|LC_.*|HTTPS?_PROXY|NO_PROXY|SSL_CERT_FILE|REQUESTS_CA_BUNDLE|GOOGLE_APPLICATION_CREDENTIALS)$/i.test(key)));
    if (this.service === 'OSM') {
      delete env.GOOGLE_APPLICATION_CREDENTIALS;
      env.SATGPT_OVERPASS_URL = this.endpoint;
      if (this.roadSnapshot) env.SATGPT_ROAD_SNAPSHOT = this.roadSnapshot;
      if (this.osmSnapshotDir) env.SATGPT_OSM_SNAPSHOT_DIR = this.osmSnapshotDir;
    }
    if (this.service === 'FLEXTH') delete env.GOOGLE_APPLICATION_CREDENTIALS;
    if (this.service === 'Geocoding') {
      delete env.GOOGLE_APPLICATION_CREDENTIALS;
      env.SATGPT_GEOCODING_URL = this.endpoint;
      if (this.geocodingLockFile) env.SATGPT_GEOCODING_LOCK_FILE = this.geocodingLockFile;
      // DSH may add bracketed IPv6 literals to NO_PROXY. HTTPX expects them bare.
      for (const key of Object.keys(env).filter(key => key.toUpperCase() === 'NO_PROXY')) {
        env[key] = env[key].replace(/(^|,)\s*\[([\da-f:.]*:[\da-f:.]*)\]\s*(?=,|$)/gi, '$1$2');
      }
    }
    const child = spawn(this.python, ['-X', 'utf8', '-I', this.worker], {
      cwd: this.cwd, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, env,
    });
    this.child = child;
    this.exited = new Promise(resolve => {
      child.on('close', code => {
        this.child = null;
        this.buffer = '';
        this.pending?.reject(new Error(this.service + ' worker exited (' + code + ')'));
        resolve();
      });
    });
    child.on('error', () => this.terminate(child, new Error('Unable to start ' + this.service + ' worker')));
    child.stdin.on('error', () => this.terminate(child, new Error(this.service + ' worker input is unavailable')));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (child !== this.child) return;
      this.buffer += chunk;
      if (this.buffer.length > MAX_RESPONSE) {
        this.terminate(child, new Error(this.service + ' worker output exceeds the response limit'));
        return;
      }
      const end = this.buffer.indexOf('\n');
      if (end < 0) return;
      try {
        const result = JSON.parse(this.buffer.slice(0, end));
        this.buffer = this.buffer.slice(end + 1);
        if (result.id !== this.pending?.id || this.buffer) throw new Error('Mismatched ' + this.service + ' worker response');
        this.pending.onTiming(result.timings, result.http_requests);
        if (result.ok) this.pending.resolve(result.data);
        else this.pending.reject(new Error(result.error || this.service + ' worker failed'));
      } catch (error) {
        this.terminate(child, error);
      }
    });
    return child;
  }

  terminate(child, error) {
    if (child !== this.child) return this.exited;
    const pending = this.pending;
    child.kill('SIGKILL');
    return this.exited.then(() => pending?.reject(error));
  }

  close() {
    if (!this.child) return Promise.resolve();
    return this.terminate(this.child, new Error(this.service + ' worker is closing'));
  }

  run(payload, { signal, timeout, onTiming }) {
    if (this.pending) return Promise.reject(new Error(this.service + ' worker slot is occupied'));
    if (signal?.aborted) return Promise.reject(new Error('Tool call cancelled'));
    const child = this.start();
    const id = randomUUID();
    const line = JSON.stringify({ id, payload, ...(onTiming && { timing: true }) }) + '\n';
    return new Promise((resolve, reject) => {
      let stopping = false;
      const stop = message => {
        if (stopping) return;
        stopping = true;
        this.terminate(child, new Error(message)).then(() => finish(reject)(new Error(message)));
      };
      const abort = () => stop('Tool call cancelled');
      const timer = setTimeout(() => stop(this.service + ' worker timed out'), timeout);
      const finish = callback => value => {
        if (this.pending?.id !== id) return;
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        this.pending = null;
        callback(value);
      };
      this.pending = {
        id,
        onTiming: (stages, requests) => { if (!stopping) onTiming?.(stages, requests); },
        resolve: value => { if (!stopping) finish(resolve)(value); },
        reject: error => { if (!stopping) finish(reject)(error); },
      };
      signal?.addEventListener('abort', abort, { once: true });
      child.stdin.write(line);
    });
  }
}
