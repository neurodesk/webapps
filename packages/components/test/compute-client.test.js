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
  assert.equal(normalizeBaseUrl('https://example.org/compute/'), 'https://example.org:8765/compute');
  assert.throws(() => normalizeBaseUrl(''), /Enter the address/);
  assert.throws(() => normalizeBaseUrl('ftp://x'), /http/);
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
