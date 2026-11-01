// Shared hosts such as Hugging Face answer bursts of requests with 429 Too Many Requests.
// Retry those, honouring Retry-After, instead of failing the whole example or volume.
// CI downloaders can also opt into retrying transient GET/HEAD failures. Each attempt waits
// for its headers under the stall guard; the waits between attempts are not counted.
import { stallGuard } from './stallGuard.js';

export function retryDelay(response, attempt, { baseDelay = 1000, maxDelay = 30000 } = {}) {
  const header = response?.headers?.get?.('Retry-After');
  if (header) {
    const seconds = Number(header);
    const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - Date.now();
    if (Number.isFinite(ms)) return Math.min(Math.max(ms, 0), maxDelay);
  }
  return Math.min(baseDelay * 2 ** attempt, maxDelay) * (0.5 + Math.random() / 2);
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener('abort', abort);
      resolve();
    }
    function abort() {
      clearTimeout(timer);
      reject(signal.reason);
    }
    signal?.addEventListener('abort', abort, { once: true });
  });
}

async function requestWithRetry(input, init, { retries = 4, baseDelay, maxDelay, retryTransient = false, stallTimeout, fetch: fetchImpl = globalThis.fetch, onRetry = () => {} }, read) {
  const signal = init.signal ?? (input instanceof Request ? input.signal : undefined);
  const method = init.method ?? (input instanceof Request ? input.method : 'GET');
  const transient = retryTransient && ['GET', 'HEAD'].includes(method.toUpperCase());
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    let response;
    try {
      const guard = stallGuard(signal, stallTimeout);
      try {
        response = await fetchImpl(input instanceof Request ? input.clone() : input, { ...init, signal: guard.signal });
      } finally {
        guard.stop();
      }
      if (attempt >= retries || (response.status !== 429 && !(transient && [502, 503, 504].includes(response.status)))) return await read(response);
    } catch (error) {
      const code = error.cause?.code ?? error.code;
      if (!transient || signal?.aborted || attempt >= retries ||
        !['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) throw error;
    }
    const delay = retryDelay(response, attempt, { baseDelay, maxDelay });
    onRetry({ status: response?.status ?? 0, attempt: attempt + 1, delay });
    await response?.body?.cancel().catch(() => {});
    await wait(delay, signal);
  }
}

export function fetchWithRetry(input, init = {}, options = {}) {
  return requestWithRetry(input, init, options, response => response);
}

export function fetchBytesWithRetry(input, init = {}, options = {}) {
  return requestWithRetry(input, init, options, async response => {
    if (!response.ok) throw new Error(`${response.status}: ${input}`);
    return new Uint8Array(await response.arrayBuffer());
  });
}
