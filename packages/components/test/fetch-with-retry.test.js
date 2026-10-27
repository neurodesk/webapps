import assert from 'node:assert/strict';
import test from 'node:test';
import { fetchBytesWithRetry, fetchWithRetry, retryDelay } from '../src/net/fetchWithRetry.js';

const replies = (statuses) => {
  const seen = [];
  const fetch = async (url) => {
    seen.push(url);
    const status = statuses[Math.min(seen.length - 1, statuses.length - 1)];
    return new Response(status === 200 ? 'bytes' : '', { status, headers: status === 429 ? { 'Retry-After': '0' } : {} });
  };
  return { seen, fetch };
};

test('a 429 is retried until the host answers', async () => {
  const { seen, fetch } = replies([429, 429, 200]);
  const retried = [];
  const response = await fetchWithRetry('https://host/a', {}, { fetch, onRetry: (event) => retried.push(event) });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'bytes');
  assert.equal(seen.length, 3);
  assert.deepEqual(retried, [{ status: 429, attempt: 1, delay: 0 }, { status: 429, attempt: 2, delay: 0 }]);
});

test('other errors return at once', async () => {
  const { seen, fetch } = replies([503]);
  const response = await fetchWithRetry('https://host/a', {}, { fetch });
  assert.equal(response.status, 503);
  assert.equal(seen.length, 1);
});

test('retries stop after the limit and return the last 429', async () => {
  const { seen, fetch } = replies([429]);
  const response = await fetchWithRetry('https://host/a', {}, { fetch, retries: 2 });
  assert.equal(response.status, 429);
  assert.equal(seen.length, 3);
});

test('aborting during the wait rejects without another request', async () => {
  const seen = [];
  const fetch = async () => {
    seen.push(1);
    return new Response('', { status: 429, headers: { 'Retry-After': '10' } });
  };
  const controller = new AbortController();
  const pending = fetchWithRetry('https://host/a', { signal: controller.signal }, { fetch });
  setTimeout(() => controller.abort(new DOMException('stop', 'AbortError')), 10);
  await assert.rejects(pending, { name: 'AbortError' });
  assert.equal(seen.length, 1);
});

test('Retry-After is honoured in seconds and capped; without it the wait backs off', () => {
  const after = (value) => new Response('', { status: 429, headers: { 'Retry-After': value } });
  assert.equal(retryDelay(after('3'), 0), 3000);
  assert.equal(retryDelay(after('600'), 0), 30000);
  const backoff = retryDelay(new Response('', { status: 429 }), 2, { baseDelay: 1000 });
  assert.ok(backoff >= 2000 && backoff <= 4000, `backoff ${backoff}`);
});

for (const status of [502, 503, 504]) {
  test(`transient downloads recover after HTTP ${status}`, async () => {
    const { seen, fetch } = replies([status, 200]);
    const response = await fetchWithRetry('https://host/file', {}, { fetch, retryTransient: true, baseDelay: 0 });
    assert.equal(await response.text(), 'bytes');
    assert.equal(seen.length, 2);
  });
}

test('transient retries recover from DNS failure and stop at the limit', async () => {
  let calls = 0;
  const error = new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
  const fetch = async () => {
    if (++calls < 3) throw error;
    return new Response('ok');
  };
  assert.equal(await (await fetchWithRetry('https://host/file', {}, { fetch, retryTransient: true, baseDelay: 0 })).text(), 'ok');
  calls = 0;
  await assert.rejects(fetchWithRetry('https://host/file', {}, { fetch, retryTransient: true, retries: 1, baseDelay: 0 }), error);
  assert.equal(calls, 2);
});

test('404s, programming errors, aborts and POSTs are not transient retries', async () => {
  const { seen, fetch } = replies([404]);
  assert.equal((await fetchWithRetry('https://host/file', {}, { fetch, retryTransient: true })).status, 404);
  assert.equal(seen.length, 1);
  for (const error of [new TypeError('bad URL'), new DOMException('cancelled', 'AbortError')]) {
    let calls = 0;
    await assert.rejects(fetchWithRetry('https://host/file', {}, { retryTransient: true, fetch: async () => { calls++; throw error; } }), error);
    assert.equal(calls, 1);
  }
  const post = replies([503]);
  assert.equal((await fetchWithRetry('https://host/file', { method: 'POST' }, { fetch: post.fetch, retryTransient: true })).status, 503);
  assert.equal(post.seen.length, 1);
});

test('transient byte downloads retry an interrupted response body', async () => {
  let calls = 0;
  const fetch = async () => {
    if (++calls > 1) return new Response('complete');
    return new Response(new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated', { cause: { code: 'UND_ERR_SOCKET' } }));
      }
    }));
  };
  const bytes = await fetchBytesWithRetry('https://host/file', {}, { fetch, retryTransient: true, baseDelay: 0 });
  assert.equal(new TextDecoder().decode(bytes), 'complete');
  assert.equal(calls, 2);
});

test('byte downloads reject permanent HTTP errors and body errors without transient opt-in', async () => {
  const missing = replies([404]);
  await assert.rejects(fetchBytesWithRetry('https://host/file', {}, { fetch: missing.fetch, retryTransient: true }), /404/);
  assert.equal(missing.seen.length, 1);
  let calls = 0;
  await assert.rejects(fetchBytesWithRetry('https://host/file', {}, { fetch: async () => {
    calls++;
    return new Response(new ReadableStream({
      start(controller) { controller.error(Object.assign(new Error('reset'), { code: 'ECONNRESET' })); }
    }));
  } }), /reset/);
  assert.equal(calls, 1);
});
