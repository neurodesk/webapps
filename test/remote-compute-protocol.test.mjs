// Conformance suite for the remote compute protocol v1. Runs against the Node
// reference server by default; set COMPUTE_SERVER_URL and COMPUTE_SERVER_TOKEN
// to run the same checks against a running `neurodesk-compute --runner simulate`.
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { startReferenceServer } from '../test-utils/compute-reference-server.mjs';
import { syntheticNifti, readVolume } from '../test-utils/nifti-fixture.mjs';
import { createComputeClient, ComputeError } from '../packages/components/src/compute/index.js';

const external = process.env.COMPUTE_SERVER_URL;
let server = null;
let baseUrl = external;
let token = process.env.COMPUTE_SERVER_TOKEN || 'test-token';

before(async () => {
  if (external) return;
  server = await startReferenceServer({ token, stageDelayMs: 10 });
  baseUrl = server.origin;
});

after(async () => {
  await server?.close();
});

const stackA = () => new Blob([syntheticNifti({ value: () => 2 })], { type: 'application/gzip' });
const stackB = () => new Blob([syntheticNifti({ value: () => 4 })], { type: 'application/gzip' });
const spec = (extra = {}) => ({
  tool: 'nesvor',
  command: 'reconstruct',
  stacks: [{ file: 'stack-0', thickness: 3 }, { file: 'stack-1', thickness: 3 }],
  options: { registration: 'stack', iterations: 400 },
  ...extra,
});

test('info answers without a token and adds tools with one', async () => {
  const anonymous = await createComputeClient({ baseUrl }).info();
  assert.equal(anonymous.service, 'neurodesk-compute');
  assert.equal(anonymous.protocol, 1);
  assert.equal(anonymous.auth, 'bearer');
  assert.equal(anonymous.tools, undefined);
  const full = await createComputeClient({ baseUrl, token }).info();
  assert.equal(full.tools[0].id, 'nesvor');
  assert.equal(full.tools[0].version, '0.5.0');
  assert.ok(full.tools[0].commands.includes('reconstruct'));
  assert.equal(typeof full.simulated, 'boolean');
  assert.equal(typeof full.gpu.available, 'boolean');
  assert.ok(full.limits.maxUploadBytes > 0);
});

test('a wrong token is rejected with the protocol error shape', async () => {
  const client = createComputeClient({ baseUrl, token: 'wrong' });
  await assert.rejects(client.job('missing'), error => error instanceof ComputeError && error.status === 401 && error.code === 'unauthorized');
});

test('CORS preflights admit the hosted site with private network access and refuse others', async () => {
  const preflight = await fetch(`${baseUrl}/api/v1/jobs`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://webapps.neurodesk.org', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization' },
  });
  assert.equal(preflight.headers.get('access-control-allow-origin'), 'https://webapps.neurodesk.org');
  assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
  assert.match(preflight.headers.get('access-control-allow-headers'), /authorization/i);
  assert.match(preflight.headers.get('vary'), /origin/i);
  const refused = await fetch(`${baseUrl}/api/v1/info`, { headers: { Origin: 'https://evil.example' } });
  assert.equal(refused.headers.get('access-control-allow-origin'), null);
});

test('a job streams status, progress, log and done, then serves its outputs', async () => {
  const client = createComputeClient({ baseUrl, token });
  const submitted = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() });
  assert.match(submitted.id, /^[a-f0-9]{32}$/);
  assert.equal(submitted.status, 'queued');
  assert.equal(typeof submitted.position, 'number');
  const seen = { status: [], progress: [], log: [] };
  const done = await client.watch(submitted.id, {
    onStatus: event => seen.status.push(event.status),
    onProgress: event => seen.progress.push(event.fraction),
    onLog: event => seen.log.push(event.line),
  });
  assert.equal(done.status, 'succeeded');
  assert.equal(done.id, submitted.id);
  assert.ok(seen.status.includes('running'));
  assert.ok(seen.progress.length >= 3);
  assert.ok(seen.progress.every((value, index) => index === 0 || value >= seen.progress[index - 1]), 'progress never decreases');
  assert.equal(seen.progress.at(-1), 1);
  assert.ok(seen.log.some(line => /\[INFO\] Registration starts/.test(line)));
  assert.deepEqual(done.outputs.map(output => output.name), ['volume.nii.gz', 'result.json', 'log.txt']);
  const detail = await client.job(submitted.id);
  assert.equal(detail.status, 'succeeded');
  assert.equal(detail.tool, 'nesvor');
  assert.equal(detail.progress, 1);
  assert.ok(detail.startedAt && detail.finishedAt && detail.createdAt);
  const volume = await client.output(submitted.id, 'volume.nii.gz');
  const bytes = Buffer.from(await volume.arrayBuffer());
  const parsed = readVolume(bytes);
  assert.deepEqual(parsed.dims, [4, 4, 4]);
  if (detail.simulated) assert.ok(parsed.data.every(value => Math.abs(value - 3) < 1e-6), 'simulated output is the mean of the stacks');
  const result = JSON.parse(await (await client.output(submitted.id, 'result.json')).text());
  assert.equal(result.simulated, detail.simulated);
  const log = await (await client.output(submitted.id, 'log.txt')).text();
  assert.match(log, /nesvor/);
  await client.cancel(submitted.id);
  await assert.rejects(client.job(submitted.id), error => error.status === 404 && error.code === 'not-found');
});

test('cancelling a running job ends the watch with a cancelled error', async () => {
  const client = createComputeClient({ baseUrl, token });
  const submitted = await client.submit(spec({ options: { registration: 'stack', iterations: 20000 } }), { 'stack-0': stackA(), 'stack-1': stackB() });
  const watching = client.watch(submitted.id, {
    onStatus: event => {
      if (event.status === 'running') void client.cancel(submitted.id);
    },
  });
  await assert.rejects(watching, error => error instanceof ComputeError && ['cancelled', 'not-found'].includes(error.code));
});

test('invalid specs and non-NIfTI uploads are refused as invalid-spec', async () => {
  const client = createComputeClient({ baseUrl, token });
  await assert.rejects(client.submit(spec({ options: { bogus: 1 } }), { 'stack-0': stackA(), 'stack-1': stackB() }), error => error.status === 400 && error.code === 'invalid-spec');
  await assert.rejects(client.submit(spec({ stacks: [{ file: 'stack-9', thickness: 3 }] }), { 'stack-0': stackA() }), error => error.code === 'invalid-spec');
  await assert.rejects(client.submit(spec({ options: { outputResolution: 9 } }), { 'stack-0': stackA(), 'stack-1': stackB() }), error => error.code === 'invalid-spec');
  await assert.rejects(client.submit(spec(), { 'stack-0': new Blob(['not a nifti']), 'stack-1': stackB() }), error => error.code === 'invalid-spec');
});

test('outputs of unknown jobs and unknown names are not found', async () => {
  const client = createComputeClient({ baseUrl, token });
  await assert.rejects(client.output('0'.repeat(32), 'volume.nii.gz'), error => error.status === 404);
  const submitted = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() });
  await client.watch(submitted.id);
  await assert.rejects(client.output(submitted.id, 'secret.txt'), error => error.status === 404);
  await client.cancel(submitted.id);
});

test('gunzipped output is a NIfTI-1 volume', async () => {
  const client = createComputeClient({ baseUrl, token });
  const submitted = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() });
  await client.watch(submitted.id);
  const bytes = Buffer.from(await (await client.output(submitted.id, 'volume.nii.gz')).arrayBuffer());
  const raw = gunzipSync(bytes);
  assert.equal(raw.readInt32LE(0), 348);
  assert.equal(raw.toString('latin1', 344, 347), 'n+1');
  await client.cancel(submitted.id);
});
