import { setTimeout as sleep } from 'node:timers/promises';

export async function downloadBytes(url, { attempts = 4, timeoutMs = 120000, fetcher = globalThis.fetch, wait = sleep, log = console.warn } = {}) {
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController();
    let timer;
    const resetDeadline = () => {
      clearTimeout(timer);
      timer = setTimeout(() => controller.abort(new DOMException('Download stalled', 'TimeoutError')), timeoutMs);
      timer.unref();
    };
    let response;
    let error;
    try {
      resetDeadline();
      response = await fetcher(url, { signal: controller.signal });
      resetDeadline();
      if (response.ok) {
        const chunks = [];
        if (response.body) {
          for await (const chunk of response.body) {
            chunks.push(chunk);
            resetDeadline();
          }
        }
        return Buffer.concat(chunks);
      }
      error = new Error(`HTTP ${response.status}`);
    } catch (cause) {
      error = cause;
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    await response?.body?.cancel().catch(() => {});
    const retryable = !response || response.ok || [408, 429].includes(response.status) || response.status >= 500;
    if (!retryable || attempt >= attempts) {
      throw new Error(`Failed to download ${url} after ${attempt} attempt(s): ${error.message}`, { cause: error });
    }
    const retryAfter = response?.headers.get('Retry-After');
    const requestedDelay = !retryAfter?.trim() ? NaN : Number.isFinite(Number(retryAfter))
      ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now();
    const delay = Math.min(30000, Math.max(1000 * 2 ** (attempt - 1), Number.isFinite(requestedDelay) ? requestedDelay : 0));
    const detail = error.cause?.code ?? error.cause?.message;
    log(`Download ${url} failed: ${error.message}${detail ? ` (${detail})` : ''}; retrying attempt ${attempt + 1}/${attempts} in ${delay} ms`);
    await wait(delay);
  }
}
