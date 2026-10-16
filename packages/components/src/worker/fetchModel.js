/**
 * Returns model bytes as an ArrayBuffer after integrity verification.
 * SHA-256-pinned assets use a shared, content-addressed Cache Storage by default.
 * options.cache accepts null to opt out, a Cache Storage name, or a get/set adapter with optional delete.
 * Cache Storage opening and writes are optional. Cache writes publish only verified bytes.
 * options.requestFailureMessage replaces the error message after all request URLs fail,
 * retaining the last error as cause. AbortError and errors reading or verifying bytes are unchanged.
 */
export const VERIFIED_ASSET_CACHE = 'neurodesk-verified-assets-v1';

const persistenceRequested = Symbol.for('neurodesk.storage.persistenceRequested');

export async function fetchModel(asset, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    cache,
    signal,
    onProgress = () => {},
  } = options;
  const normalized = typeof asset === 'string' ? { url: asset, cacheKey: asset } : asset;
  if (!normalized?.url) throw new Error('fetchModel requires an asset URL');
  if (typeof fetchImpl !== 'function') throw new Error('fetchModel requires fetch');

  signal?.throwIfAborted();
  const origin = globalThis.location?.origin;
  const sharedCache = cache === undefined && /^[a-f0-9]{64}$/i.test(normalized.integrity?.sha256 || '')
    && /^https?:\/\//.test(origin || '');
  const cacheKey = sharedCache
    ? new URL(`/__neurodesk_cache__/sha256/${normalized.integrity.sha256.toLowerCase()}`, origin).href
    : normalized.cacheKey || normalized.url;
  const namedCache = sharedCache || typeof cache === 'string';
  const reportCacheError = error => {
    if (options.onCacheError) options.onCacheError(error);
    else console.warn('Could not persist verified asset:', error);
  };
  const storage = namedCache ? await openCache(sharedCache ? VERIFIED_ASSET_CACHE : cache, reportCacheError) : cache;
  let cached;
  try {
    cached = storage ? await (namedCache ? storage.match(cacheKey) : storage.get(cacheKey)) : null;
  } catch (error) {
    if (!sharedCache) throw error;
    reportCacheError(error);
  }
  signal?.throwIfAborted();
  if (cached) {
    let bytes;
    let invalidCacheError;
    try {
      bytes = namedCache
        ? await readResponse(cached, normalized.integrity, onProgress, signal)
        : toArrayBuffer(cached);
    } catch (error) {
      signal?.throwIfAborted();
      if (!(error instanceof InvalidModelBytes) && !sharedCache) throw error;
      if (error instanceof InvalidModelBytes) invalidCacheError = error;
      else reportCacheError(error);
    }
    try {
      if (bytes) await verifyModel(bytes, normalized.integrity);
      signal?.throwIfAborted();
      if (bytes) {
        if (sharedCache) requestPersistence(reportCacheError);
        return bytes;
      }
    } catch (error) {
      if (!(error instanceof InvalidModelBytes)) throw error;
      invalidCacheError = error;
    }
    try {
      await storage.delete?.(cacheKey);
    } catch (error) {
      if (!sharedCache) throw error;
      reportCacheError(error);
    }
    if (invalidCacheError) options.onInvalidCache?.(invalidCacheError);
  }

  const urls = normalized.urls || [normalized.url];
  let response;
  let selectedUrl;
  let lastError;
  for (const url of urls) {
    signal?.throwIfAborted();
    try {
      const candidate = await fetchImpl(url, { signal, cache: options.requestCache });
      if (!candidate.ok || candidate.headers?.get?.('content-type')?.toLowerCase().includes('text/html')) {
        try {
          await candidate.body?.cancel();
        } catch { /* Cancelling an unusable body must not replace the download or integrity failure. */ }
        throw new Error(`Model download failed (${candidate.status}): ${url}`);
      }
      response = candidate;
      selectedUrl = url;
      break;
    } catch (error) {
      signal?.throwIfAborted();
      if (error.name === 'AbortError') throw error;
      lastError = error;
    }
  }
  if (!response) {
    const error = lastError || new Error(`Model download failed: ${normalized.url}`);
    if (options.requestFailureMessage && error.name !== 'AbortError') {
      throw new Error(options.requestFailureMessage, { cause: error });
    }
    throw error;
  }
  const bytes = await readResponse(response, normalized.integrity, onProgress, signal);

  await verifyModel(bytes, normalized.integrity);
  signal?.throwIfAborted();
  if (storage) {
    try {
      if (namedCache) {
        await storage.put(cacheKey, new Response(bytes.slice(0), {
          headers: { 'Content-Type': 'application/octet-stream' },
        }));
      } else {
        await storage.set(cacheKey, bytes.slice(0));
      }
    } catch (error) {
      reportCacheError(error);
    }
  }
  if (sharedCache && storage) requestPersistence(reportCacheError);
  signal?.throwIfAborted();
  options.onDownloaded?.({ url: selectedUrl, bytes: bytes.byteLength });
  return bytes;
}

async function verifyModel(bytes, integrity = {}) {
  if (integrity.bytes && bytes.byteLength !== integrity.bytes) {
    throw new InvalidModelBytes(`Model size mismatch: expected ${integrity.bytes} bytes, received ${bytes.byteLength}`);
  }
  if (integrity.minBytes && bytes.byteLength < integrity.minBytes) {
    throw new InvalidModelBytes(`Model is truncated: expected at least ${integrity.minBytes} bytes, received ${bytes.byteLength}`);
  }
  if (integrity.sha256) {
    if (!globalThis.crypto?.subtle) throw new Error('SHA-256 verification requires Web Crypto');
    const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
    const actual = [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
    if (actual !== integrity.sha256.toLowerCase()) throw new InvalidModelBytes('Model SHA-256 mismatch');
  }
}

function toArrayBuffer(value) {
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
  throw new Error('Model cache returned unsupported data');
}

class InvalidModelBytes extends Error {}

async function openCache(name, reportError) {
  try {
    return await globalThis.caches?.open(name) || null;
  } catch (error) {
    reportError(error);
    return null;
  }
}

function requestPersistence(reportError) {
  const storage = globalThis.navigator?.storage;
  if (globalThis.window !== globalThis || !storage?.persist || globalThis[persistenceRequested]) return;
  globalThis[persistenceRequested] = true;
  Promise.resolve().then(() => storage.persist()).catch(reportError);
}

async function readResponse(response, integrity = {}, onProgress, signal) {
  signal?.throwIfAborted();
  if (!response.body?.getReader) {
    const bytes = await response.arrayBuffer();
    signal?.throwIfAborted();
    return bytes;
  }
  const total = integrity.bytes || Number(response.headers?.get?.('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastProgress = -1;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      received += value.byteLength;
      if (integrity.bytes && received > integrity.bytes) {
        throw new InvalidModelBytes(`Model size mismatch: expected ${integrity.bytes} bytes, received ${received}`);
      }
      chunks.push(value);
      const progress = total ? Math.floor(received / total * 100) : Math.floor(received / (1024 * 1024));
      if (progress !== lastProgress) {
        onProgress({ received, total, fraction: total ? received / total : null });
        lastProgress = progress;
      }
    }
  } catch (error) {
    try {
      await reader.cancel?.();
    } catch { /* Cancelling an unusable body must not replace the download or integrity failure. */ }
    throw error;
  } finally {
    try {
      reader.releaseLock?.();
    } catch { /* Releasing a failed reader's lock must not replace its download or integrity error. */ }
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
