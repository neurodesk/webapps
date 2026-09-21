// Browser client for the Neurodesk remote compute protocol v1.
// See docs/architecture/remote-compute-protocol.md for the contract.
import { ComputeError, describeConnectionError, normalizeBaseUrl } from './errors.js';

const API = '/api/v1';
const POLL_INTERVAL_MS = 1500;

export class ComputeClient {
  #fetch;
  #token;

  constructor({ baseUrl, token = '', fetch = globalThis.fetch?.bind(globalThis) } = {}) {
    if (typeof fetch !== 'function') throw new Error('createComputeClient needs a fetch implementation');
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.#token = token || '';
    this.#fetch = fetch;
  }

  get token() {
    return this.#token;
  }

  /** Capability probe. Includes tools and GPU details when the token is accepted. */
  async info({ signal } = {}) {
    return this.#json('GET', `${API}/info`, { signal });
  }

  /** Submit a job: `files` maps multipart part names to Blobs. */
  async submit(spec, files, { signal } = {}) {
    const body = new FormData();
    body.append('spec', new Blob([JSON.stringify(spec)], { type: 'application/json' }), 'spec.json');
    for (const [name, blob] of Object.entries(files)) {
      body.append(name, blob, blob.name || name);
    }
    return this.#json('POST', `${API}/jobs`, { body, signal });
  }

  async job(id, { signal } = {}) {
    return this.#json('GET', `${API}/jobs/${encodeURIComponent(id)}`, { signal });
  }

  async cancel(id, { signal } = {}) {
    const response = await this.#request('DELETE', `${API}/jobs/${encodeURIComponent(id)}`, { signal });
    if (!response.ok && response.status !== 404) throw await this.#error(response);
  }

  /** Bytes of one named output as a Blob. */
  async output(id, name, { signal } = {}) {
    const response = await this.#request('GET', `${API}/jobs/${encodeURIComponent(id)}/outputs/${encodeURIComponent(name)}`, { signal });
    if (!response.ok) throw await this.#error(response);
    return response.blob();
  }

  /**
   * Follow a job until it finishes. Streams Server-Sent Events over fetch so the
   * bearer token stays in a header, and falls back to polling when the stream
   * cannot be read. Resolves with the final job object.
   */
  async watch(id, handlers = {}, { signal } = {}) {
    let done = null;
    try {
      done = await this.#stream(id, handlers, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      if (error instanceof ComputeError && error.status) throw error;
      handlers.onLog?.({ line: `Event stream unavailable (${error.message}); polling instead.`, level: 'warning' });
    }
    if (!done) done = await this.#poll(id, handlers, signal);
    if (done.status === 'failed') {
      throw new ComputeError(done.error?.code || 'tool-failed', done.error?.message || 'The job failed', { job: done });
    }
    if (done.status === 'cancelled') throw new ComputeError('cancelled', 'The job was cancelled', { job: done });
    return done;
  }

  async #stream(id, handlers, signal) {
    const response = await this.#request('GET', `${API}/jobs/${encodeURIComponent(id)}/events`, { signal, headers: { Accept: 'text/event-stream' } });
    if (!response.ok) throw await this.#error(response);
    if (!response.body) throw new Error('streaming responses are not supported');
    const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = '';
    let event = null;
    let data = [];
    const dispatch = () => {
      if (event === null && !data.length) return null;
      const payload = data.length ? JSON.parse(data.join('\n')) : {};
      const name = event || 'message';
      event = null;
      data = [];
      return this.#deliver(name, payload, handlers);
    };
    while (true) {
      const { value, done: finished } = await reader.read();
      if (finished) break;
      buffer += value;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, '');
        buffer = buffer.slice(index + 1);
        if (line === '') {
          const result = dispatch();
          if (result) {
            await reader.cancel().catch(() => {});
            return result;
          }
        } else if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
    }
    return dispatch();
  }

  #deliver(name, payload, handlers) {
    if (name === 'status') handlers.onStatus?.(payload);
    else if (name === 'progress') handlers.onProgress?.(payload);
    else if (name === 'log') handlers.onLog?.(payload);
    else if (name === 'done') return payload;
    return null;
  }

  async #poll(id, handlers, signal) {
    let lastStatus = null;
    let lastProgress = null;
    while (true) {
      signal?.throwIfAborted();
      const job = await this.job(id, { signal });
      if (job.status !== lastStatus) {
        lastStatus = job.status;
        handlers.onStatus?.({ status: job.status, position: job.position });
      }
      if (job.progress !== lastProgress && job.progress !== null) {
        lastProgress = job.progress;
        handlers.onProgress?.({ fraction: job.progress, stage: job.stage });
      }
      if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, POLL_INTERVAL_MS);
        signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      });
    }
  }

  async #json(method, path, options) {
    const response = await this.#request(method, path, options);
    if (!response.ok) throw await this.#error(response);
    return response.json();
  }

  async #request(method, path, { body, signal, headers = {} } = {}) {
    const init = { method, signal, headers: { ...headers }, cache: 'no-store' };
    if (this.#token) init.headers.Authorization = `Bearer ${this.#token}`;
    if (body) init.body = body;
    return this.#fetch(this.baseUrl + path, init);
  }

  async #error(response) {
    let payload = null;
    try {
      payload = await response.json();
    } catch {
      payload = null;
    }
    const code = payload?.error?.code || (response.status === 401 ? 'unauthorized' : `http-${response.status}`);
    const message = payload?.error?.message || `${response.status} ${response.statusText}`.trim();
    return new ComputeError(code, message, { status: response.status });
  }
}

export function createComputeClient(options) {
  return new ComputeClient(options);
}

export { ComputeError, describeConnectionError, normalizeBaseUrl };
