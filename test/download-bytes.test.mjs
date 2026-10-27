import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import test from 'node:test';
import { downloadBytes } from '../scripts/lib/download-bytes.mjs';

const url = 'https://cdn.example/pinned/runtime.wasm';
const quiet = { log: () => {} };

test('connection failures and interrupted response bodies retry the whole download with backoff', async () => {
  let requests = 0;
  const delays = [];
  const logs = [];
  const bytes = await downloadBytes(url, {
    fetcher: async () => {
      requests++;
      if (requests === 1) throw new TypeError('fetch failed', { cause: new Error('Connect Timeout Error') });
      if (requests === 2) return new Response(new ReadableStream({ start(controller) { controller.error(new Error('connection reset')); } }));
      return new Response('complete pinned runtime');
    },
    wait: async ms => { delays.push(ms); },
    log: message => { logs.push(message); },
  });
  assert.equal(bytes.toString(), 'complete pinned runtime');
  assert.deepEqual(delays, [1000, 2000]);
  assert.equal(requests, 3);
  assert.match(logs[0], /runtime\.wasm.*fetch failed.*attempt 2\/4/);
  assert.match(logs[1], /connection reset.*attempt 3\/4/);
});

test('each retry gets a fresh deadline after a request times out', async () => {
  const signals = [];
  const bytes = await downloadBytes(url, {
    ...quiet, timeoutMs: 5, wait: async () => {},
    fetcher: async (_url, { signal }) => {
      signals.push(signal);
      if (signals.length === 1) {
        await sleep(15);
        signal.throwIfAborted();
      }
      return new Response('recovered');
    },
  });
  assert.equal(bytes.toString(), 'recovered');
  assert.equal(signals[0].aborted, true);
  assert.notEqual(signals[0], signals[1]);
});

for (const status of [408, 429, 500, 502, 503, 504]) {
  test(`HTTP ${status} retries, honours Retry-After, and releases the failed response`, async () => {
    let requests = 0;
    let cancelled = false;
    const delays = [];
    const bytes = await downloadBytes(url, {
      ...quiet,
      fetcher: async () => ++requests === 1
        ? new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status, headers: { 'Retry-After': '2' } })
        : new Response('runtime'),
      wait: async ms => { delays.push(ms); },
    });
    assert.equal(bytes.toString(), 'runtime');
    assert.equal(cancelled, true);
    assert.deepEqual(delays, [2000]);
  });
}

test('permanent HTTP errors fail immediately with the asset URL and status', async () => {
  let requests = 0;
  await assert.rejects(downloadBytes(url, {
    ...quiet, fetcher: async () => { requests++; return new Response('', { status: 404 }); },
    wait: async () => { throw new Error('Must not wait for a permanent error'); },
  }), /Failed to download https:\/\/cdn\.example\/pinned\/runtime\.wasm after 1 attempt\(s\): HTTP 404/);
  assert.equal(requests, 1);
});

test('persistent connection failures stop at the attempt limit and preserve the underlying error', async () => {
  let requests = 0;
  const failure = new TypeError('fetch failed', { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) });
  const delays = [];
  await assert.rejects(downloadBytes(url, {
    ...quiet, fetcher: async () => { requests++; throw failure; },
    wait: async ms => { delays.push(ms); },
  }), error => {
    assert.match(error.message, /runtime\.wasm after 4 attempt\(s\): fetch failed/);
    assert.equal(error.cause, failure);
    return true;
  });
  assert.equal(requests, 4);
  assert.deepEqual(delays, [1000, 2000, 4000]);
});

test('persistent server failures stop at the attempt limit and cap Retry-After waits', async () => {
  let requests = 0;
  const delays = [];
  await assert.rejects(downloadBytes(url, {
    ...quiet, attempts: 3,
    fetcher: async () => { requests++; return new Response('', { status: 503, headers: { 'Retry-After': '600' } }); },
    wait: async ms => { delays.push(ms); },
  }), /after 3 attempt\(s\): HTTP 503/);
  assert.equal(requests, 3);
  assert.deepEqual(delays, [30000, 30000]);
});
