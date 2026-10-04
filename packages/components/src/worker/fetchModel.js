/**
 * Returns model bytes as an ArrayBuffer after integrity verification.
 * options.cache accepts null, a Cache Storage name, or a get/set adapter with optional delete.
 * Named cache opening is optional. Cache writes publish only verified bytes.
 * options.requestFailureMessage replaces the error message after all request URLs fail,
 * retaining the last error as cause. AbortError and errors reading or verifying bytes are unchanged.
 */
export async function fetchModel(asset, options = {}) {
  const {
    fetch: fetchImpl = globalThis.fetch,
    cache = null,
    signal,
    onProgress = () => {},
  } = options;
  const normalized = typeof asset === 'string' ? { url: asset, cacheKey: asset } : asset;
  if (!normalized?.url) throw new Error('fetchModel requires an asset URL');
  if (typeof fetchImpl !== 'function') throw new Error('fetchModel requires fetch');

  const cacheKey = normalized.cacheKey || normalized.url;
  const namedCache = typeof cache === 'string';
  const storage = namedCache ? await openCache(cache) : cache;
  const cached = storage ? await (namedCache ? storage.match(cacheKey) : storage.get(cacheKey)) : null;
  if (cached) {
    try {
      const bytes = namedCache
        ? await readResponse(cached, normalized.integrity, onProgress)
        : toArrayBuffer(cached);
      await verifyModel(bytes, normalized.integrity);
      return bytes;
    } catch (error) {
      if (!(error instanceof InvalidModelBytes)) throw error;
      await storage.delete?.(cacheKey);
      options.onInvalidCache?.(error);
    }
  }

  const urls = normalized.urls || [normalized.url];
  let response;
  let selectedUrl;
  let lastError;
  for (const url of urls) {
    try {
      const candidate = await fetchImpl(url, { signal, cache: options.requestCache });
      if (!candidate.ok || candidate.headers?.get?.('content-type')?.toLowerCase().includes('text/html')) {
        try {
          await candidate.body?.cancel();
        } catch {}
        throw new Error(`Model download failed (${candidate.status}): ${url}`);
      }
      response = candidate;
      selectedUrl = url;
      break;
    } catch (error) {
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
  const bytes = await readResponse(response, normalized.integrity, onProgress);

  await verifyModel(bytes, normalized.integrity);
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
      options.onCacheError?.(error);
    }
  }
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

async function openCache(name) {
  try {
    return await globalThis.caches?.open(name) || null;
  } catch {
    return null;
  }
}

async function readResponse(response, integrity = {}, onProgress) {
  if (!response.body?.getReader) return response.arrayBuffer();
  const total = integrity.bytes || Number(response.headers?.get?.('content-length')) || 0;
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;
  let lastProgress = -1;
  try {
    for (;;) {
      const { done, value } = await reader.read();
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
    } catch {}
    throw error;
  } finally {
    try {
      reader.releaseLock?.();
    } catch {}
  }
  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
