import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { retryDelay } from '../../packages/components/src/net/fetchWithRetry.js';

const sha256 = value => createHash('sha256').update(value).digest('hex');

export function exampleCachePath(directory, url) {
  return join(directory, sha256(url));
}

// The interface audit imports each app's first example, so those are the files it needs.
export function auditedExampleFiles(examples) {
  return examples.length ? examples[0].files : [];
}

function lockedAsset(assets, url) {
  const locked = assets[url];
  if (!locked || !/^[a-f0-9]{64}$/.test(locked.sha256)) {
    throw new Error(`Missing locked SHA-256 for cached example: ${url}`);
  }
  return locked;
}

export async function loadVerifiedExampleCache(files, { directory, assets }) {
  const entries = await Promise.all([...new Set(files.map(file => file.url))].map(async url => {
    const locked = lockedAsset(assets, url);
    const path = exampleCachePath(directory, url);
    let body;
    try {
      body = await readFile(path);
    } catch (cause) {
      throw new Error(`Cannot read cached example ${url} at ${path}; cache mode does not fall back to the network`, { cause });
    }
    if (sha256(body) !== locked.sha256 || body.length !== locked.bytes) {
      throw new Error(`Cached example checksum or size mismatch: ${url}`);
    }
    return [url, { path, body, contentType: locked.contentType || 'application/octet-stream' }];
  }));
  return new Map(entries);
}

async function entryMatches(path, locked) {
  const metadata = await stat(path).catch(() => null);
  if (!metadata?.isFile() || metadata.size !== locked.bytes) return false;
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex') === locked.sha256;
}

// One request. Resolves to null when the verified file is in place, or to what
// a later attempt may fix; throws what no retry can fix.
async function attemptDownload(url, path, locked, { fetchImpl, timeout, signal }) {
  const expired = AbortSignal.timeout(timeout);
  const attempt = AbortSignal.any([signal, expired]);
  const partial = `${path}.${randomUUID()}.partial`;
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    const response = await fetchImpl(url, { signal: attempt });
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      if (response.status !== 408 && response.status !== 429 && response.status < 500) {
        throw Object.assign(new Error(`Cannot download example ${url}: HTTP ${response.status}`), { fatal: true });
      }
      return { reason: `HTTP ${response.status}`, response };
    }
    const count = new Transform({
      transform(chunk, _encoding, done) {
        hash.update(chunk);
        bytes += chunk.length;
        done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(response.body), count, createWriteStream(partial), { signal: attempt });
  } catch (error) {
    await rm(partial, { force: true });
    if (error.fatal || signal.aborted) throw error;
    return { reason: expired.aborted ? `no complete response within ${timeout} ms` : error.message };
  }
  if (bytes !== locked.bytes || hash.digest('hex') !== locked.sha256) {
    await rm(partial, { force: true });
    throw new Error(`Downloaded example does not match its locked SHA-256 and size (${bytes} of ${locked.bytes} bytes): ${url}`);
  }
  await rename(partial, path);
  return null;
}

async function download(url, path, locked, { retries, baseDelay, maxDelay, onEvent, ...request }) {
  for (let attempt = 0; ; attempt++) {
    const failed = await attemptDownload(url, path, locked, request);
    if (!failed) return;
    if (attempt >= retries) {
      throw new Error(`Cannot download example ${url} after ${attempt + 1} attempts: ${failed.reason}`);
    }
    const delay = retryDelay(failed.response, attempt, { baseDelay, maxDelay });
    onEvent({ type: 'retry', url, attempt: attempt + 1, delay, reason: failed.reason });
    await sleep(delay, undefined, { signal: request.signal });
  }
}

/**
 * Brings the cache directory to the state loadVerifiedExampleCache accepts for these files.
 * Entries already matching the lock are kept; the rest are downloaded, checked and renamed into place.
 */
export async function fillExampleCache(files, {
  directory,
  assets,
  concurrency = 4,
  timeout = 300_000,
  retries = 4,
  baseDelay,
  maxDelay,
  prune = false,
  fetch: fetchImpl = globalThis.fetch,
  onEvent = () => {},
}) {
  const wanted = new Map([...new Set(files.map(file => file.url))].map(url => [url, lockedAsset(assets, url)]));
  await mkdir(directory, { recursive: true });
  const summary = { reused: [], downloaded: [], pruned: [], bytes: 0, downloadedBytes: 0 };
  const stop = new AbortController();
  const queue = wanted.entries();
  const worker = async () => {
    for (const [url, locked] of queue) {
      if (stop.signal.aborted) return;
      const path = exampleCachePath(directory, url);
      summary.bytes += locked.bytes;
      if (await entryMatches(path, locked)) {
        summary.reused.push(url);
        continue;
      }
      try {
        await download(url, path, locked, { fetchImpl, timeout, retries, baseDelay, maxDelay, onEvent, signal: stop.signal });
      } catch (error) {
        if (!stop.signal.aborted) stop.abort(error);
        return;
      }
      summary.downloaded.push(url);
      summary.downloadedBytes += locked.bytes;
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  if (stop.signal.aborted) throw stop.signal.reason;
  if (prune) {
    const keep = new Set([...wanted.keys()].map(url => sha256(url)));
    for (const name of await readdir(directory)) {
      if (keep.has(name)) continue;
      await rm(join(directory, name), { recursive: true, force: true });
      summary.pruned.push(name);
    }
  }
  return summary;
}
