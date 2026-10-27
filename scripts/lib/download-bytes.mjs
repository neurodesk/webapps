import { setTimeout as sleep } from 'node:timers/promises';

export async function downloadBytes(url, { attempts = 4, timeoutMs = 120000, fetcher = globalThis.fetch, wait = sleep, log = console.warn } = {}) {
  for (let attempt = 1; ; attempt++) {
    let response;
    let error;
    try {
      response = await fetcher(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
      error = new Error(`HTTP ${response.status}`);
    } catch (cause) {
      error = cause;
    }
    await response?.body?.cancel().catch(() => {});
    const retryable = !response || response.ok || [408, 429].includes(response.status) || response.status >= 500;
    if (!retryable || attempt >= attempts) {
      throw new Error(`Failed to download ${url} after ${attempt} attempt(s): ${error.message}`, { cause: error });
    }
    const retryAfter = response?.headers.get('Retry-After');
    const requestedDelay = retryAfter == null ? NaN : Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    const delay = Math.min(30000, Math.max(0, Number.isFinite(requestedDelay) ? requestedDelay : 1000 * 2 ** (attempt - 1)));
    log(`Download ${url} failed: ${error.message}; retrying attempt ${attempt + 1}/${attempts} in ${delay} ms`);
    await wait(delay);
  }
}
