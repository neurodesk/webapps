import assert from 'node:assert/strict';
import test from 'node:test';
import { createComputeClient, ComputeError, describeConnectionError, normalizeBaseUrl } from '../src/compute/index.js';

function response(status, body, headers = {}) {
  const init = { status, headers: { 'content-type': 'application/json', ...headers } };
  return new Response(body === undefined ? null : JSON.stringify(body), init);
}

test('normalizeBaseUrl accepts what a clinician types', () => {
  assert.equal(normalizeBaseUrl('192.168.1.20:8765'), 'https://192.168.1.20:8765');
  assert.equal(normalizeBaseUrl('192.168.1.20'), 'https://192.168.1.20:8765');
  assert.equal(normalizeBaseUrl('https://compute.clinic.local:9000/'), 'https://compute.clinic.local:9000');
  assert.equal(normalizeBaseUrl('http://localhost:8765/api/v1/'), 'http://localhost:8765');
  assert.equal(normalizeBaseUrl('localhost'), 'http://localhost:8765');
  assert.equal(normalizeBaseUrl('https://example.org/compute/'), 'https://example.org/compute');
  assert.throws(() => normalizeBaseUrl(''), /Enter the address/);
  assert.throws(() => normalizeBaseUrl('ftp://x'), /http/);
});

test('explicit reverse proxy URLs keep their standard port through repeated normalization', async () => {
  for (const address of ['https://example.org/compute/', 'https://example.org:443/compute/api/v1/', 'http://example.org:80/compute/']) {
    const expected = `${new URL(address).protocol}//example.org/compute`;
    const normalized = normalizeBaseUrl(address);
    assert.equal(normalized, expected);
    const client = createComputeClient({
      baseUrl: normalized,
      fetch: async url => {
        assert.equal(url, `${expected}/api/v1/info`);
        return response(200, { service: 'neurodesk-compute', tools: [] });
      },
    });
    await client.info();
  }
});

test('the client sends the bearer token and multipart job submissions', async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    if (url.endsWith('/api/v1/info')) return response(200, { service: 'neurodesk-compute', tools: [] });
    if (url.endsWith('/api/v1/jobs')) {
      const form = init.body;
      assert.ok(form instanceof FormData);
      assert.equal(JSON.parse(await form.get('spec').text()).tool, 'nesvor');
      assert.equal((await form.get('stack-0').text()), 'bytes');
      return response(202, { id: 'abc', status: 'queued', position: 0 });
    }
    return response(404, { error: { code: 'not-found', message: 'nope' } });
  };
  const client = createComputeClient({ baseUrl: 'https://server:8765/', token: 'secret', fetch });
  assert.equal(client.baseUrl, 'https://server:8765');
  const info = await client.info();
  assert.equal(info.service, 'neurodesk-compute');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
  assert.equal(calls[0].init.cache, 'no-store');
  const submitted = await client.submit({ tool: 'nesvor' }, { 'stack-0': new Blob(['bytes']) });
  assert.equal(submitted.id, 'abc');
  await assert.rejects(client.job('zzz'), error => error instanceof ComputeError && error.code === 'not-found' && error.status === 404);
});

test('watch parses the event stream and resolves with the done payload', async () => {
  const stream = [
    'event: status\ndata: {"status":"running","position":0}\n\n',
    ': keepalive\n\n',
    'event: progress\ndata: {"fraction":0.4,"stage":"Reconstruction"}\n\n',
    'event: log\ndata: {"line":"hello","level":"info"}\n\n',
    'event: done\ndata: {"id":"abc","status":"succeeded","outputs":[{"name":"volume.nii.gz"}]}\n\n',
  ];
  const fetch = async url => {
    assert.match(url, /\/api\/v1\/jobs\/abc\/events$/);
    const body = new ReadableStream({
      start(controller) {
        for (const chunk of stream) controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  };
  const client = createComputeClient({ baseUrl: 'https://server:8765', token: 't', fetch });
  const seen = [];
  const done = await client.watch('abc', {
    onStatus: event => seen.push(['status', event.status]),
    onProgress: event => seen.push(['progress', event.fraction]),
    onLog: event => seen.push(['log', event.line]),
  });
  assert.deepEqual(seen, [['status', 'running'], ['progress', 0.4], ['log', 'hello']]);
  assert.equal(done.status, 'succeeded');
  assert.equal(done.outputs[0].name, 'volume.nii.gz');
});

test('watch falls back to polling when the stream is unavailable and reports failures', async () => {
  let polls = 0;
  const fetch = async url => {
    if (url.endsWith('/events')) throw new TypeError('stream broke');
    polls += 1;
    const status = polls < 2 ? 'running' : 'failed';
    return response(200, { id: 'abc', status, position: 0, progress: 0.5, stage: 'x', error: status === 'failed' ? { code: 'tool-failed', message: 'exit 1' } : null });
  };
  const client = createComputeClient({ baseUrl: 'https://server:8765', token: 't', fetch });
  const logs = [];
  await assert.rejects(client.watch('abc', { onLog: event => logs.push(event.level) }), error => error.code === 'tool-failed' && error.message === 'exit 1' && error.job.status === 'failed');
  assert.ok(polls >= 2);
  assert.deepEqual(logs, ['warning']);
});

test('describeConnectionError explains mixed content, certificates, tokens and unreachable hosts', () => {
  const failed = new TypeError('Failed to fetch');
  const mixed = describeConnectionError(failed, { pageOrigin: 'https://webapps.neurodesk.org', baseUrl: 'http://192.168.1.20:8765' });
  assert.equal(mixed.code, 'mixed-content');
  assert.match(mixed.message, /HTTPS/);
  const loopback = describeConnectionError(failed, { pageOrigin: 'https://webapps.neurodesk.org', baseUrl: 'http://localhost:8765' });
  assert.equal(loopback.code, 'unreachable');
  const tls = describeConnectionError(failed, { pageOrigin: 'https://webapps.neurodesk.org', baseUrl: 'https://192.168.1.20:8765' });
  assert.equal(tls.code, 'unreachable');
  assert.match(tls.message, /accept the certificate/);
  assert.match(tls.message, /192\.168\.1\.20:8765\/api\/v1\/info/);
  const token = describeConnectionError(new ComputeError('unauthorized', 'nope', { status: 401 }), {});
  assert.equal(token.code, 'unauthorized');
  const invalid = describeConnectionError(new ComputeError('invalid-address', 'bad'), {});
  assert.equal(invalid.message, 'bad');
  const aborted = describeConnectionError(Object.assign(new Error('x'), { name: 'AbortError' }), {});
  assert.equal(aborted.code, 'cancelled');
});

test('a lost submission receipt retries with the same key and does not send cookies or follow redirects', async () => {
  const keys = [];
  const client = createComputeClient({ baseUrl: 'https://compute:8765', token: 'client-secret', fetch: async (_url, init) => {
    keys.push(init.headers['Idempotency-Key']);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.redirect, 'error');
    if (keys.length === 1) throw new TypeError('Receipt lost');
    return response(202, { id: 'one-job' });
  } });
  const result = await client.submit({}, {}, { idempotencyKey: 'same-attempt' });
  assert.equal(result.id, 'one-job');
  assert.deepEqual(keys, ['same-attempt', 'same-attempt']);
});

test('pairing replaces the installation code with a client credential and disconnect clears it', async () => {
  const client = createComputeClient({ baseUrl: 'https://compute:8765', fetch: async (url, init) => {
    if (url.endsWith('/pair')) {
      assert.deepEqual(JSON.parse(init.body), { code: 'installation-code' });
      assert.equal(init.headers.Authorization, undefined);
      return response(200, { token: 'owned-client', clientId: 'owner' });
    }
    assert.equal(init.headers.Authorization, 'Bearer owned-client');
    return new Response(null, { status: 204 });
  } });
  await client.pair('installation-code');
  assert.equal(client.token, 'owned-client');
  await client.disconnect();
  assert.equal(client.token, '');
});
