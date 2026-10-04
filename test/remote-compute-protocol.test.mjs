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
const pairingCode = process.env.COMPUTE_SERVER_TOKEN || 'test-token';
let token;

before(async () => {
  if (!external) {
    server = await startReferenceServer({ token: pairingCode, stageDelayMs: 10 });
    baseUrl = server.origin;
  }
  const session = await createComputeClient({ baseUrl }).pair(pairingCode);
  token = session.token;
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
  assert.equal(anonymous.auth, 'pairing');
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
  await client.remove(submitted.id);
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
  await assert.rejects(watching, error => error instanceof ComputeError && error.code === 'cancelled');
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
  await client.remove(submitted.id);
});

test('gunzipped output is a NIfTI-1 volume', async () => {
  const client = createComputeClient({ baseUrl, token });
  const submitted = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() });
  await client.watch(submitted.id);
  const bytes = Buffer.from(await (await client.output(submitted.id, 'volume.nii.gz')).arrayBuffer());
  const raw = gunzipSync(bytes);
  assert.equal(raw.readInt32LE(0), 348);
  assert.equal(raw.toString('latin1', 344, 347), 'n+1');
  await client.remove(submitted.id);
});

test('pairing code and URL credentials never authorize patient operations', async () => {
  const installation = createComputeClient({ baseUrl, token: pairingCode });
  await assert.rejects(installation.jobs(), error => error.status === 401);
  const response = await fetch(`${baseUrl}/api/v1/jobs?token=${encodeURIComponent(token)}`);
  assert.equal(response.status, 401);
});

test('paired clients own separate jobs and revocation invalidates the credential', async () => {
  const other = createComputeClient({ baseUrl });
  const credential = await other.pair(pairingCode);
  const client = createComputeClient({ baseUrl, token });
  const submitted = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() });
  assert.ok((await client.jobs()).jobs.some(job => job.id === submitted.id));
  assert.ok(!(await other.jobs()).jobs.some(job => job.id === submitted.id));
  for (const action of [() => other.job(submitted.id), () => other.cancel(submitted.id), () => other.output(submitted.id, 'volume.nii.gz')]) {
    await assert.rejects(action(), error => error.status === 404);
  }
  const deletion = await fetch(`${baseUrl}/api/v1/jobs/${submitted.id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${credential.token}` } });
  assert.equal(deletion.status, 404);
  const events = await fetch(`${baseUrl}/api/v1/jobs/${submitted.id}/events`, { headers: { Authorization: `Bearer ${credential.token}` } });
  assert.equal(events.status, 404);
  await other.disconnect();
  await assert.rejects(createComputeClient({ baseUrl, token: credential.token }).jobs(), error => error.status === 401);
  await client.watch(submitted.id);
  await client.remove(submitted.id);
});

test('concurrent retries with the same key produce one owned job', async () => {
  const client = createComputeClient({ baseUrl, token });
  const idempotencyKey = crypto.randomUUID();
  const receipts = await Promise.all(Array.from({ length: 3 }, () => client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() }, { idempotencyKey })));
  assert.equal(new Set(receipts.map(receipt => receipt.id)).size, 1);
  assert.equal((await client.jobs()).jobs.filter(job => job.id === receipts[0].id).length, 1);
  await client.watch(receipts[0].id);
  const retry = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() }, { idempotencyKey });
  assert.equal(retry.id, receipts[0].id);
  await client.remove(receipts[0].id);
});

test('submission requires an idempotency key and live jobs cannot be deleted', async () => {
  const client = createComputeClient({ baseUrl, token });
  const missing = await fetch(`${baseUrl}/api/v1/jobs`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
  assert.equal(missing.status, 400);
  const job = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() });
  await assert.rejects(client.remove(job.id), error => error.status === 409);
  const cancelling = await client.cancel(job.id);
  assert.ok(['cancelling', 'cancelled'].includes(cancelling.status));
  await assert.rejects(client.watch(job.id), error => error.code === 'cancelled');
  assert.equal((await client.job(job.id)).status, 'cancelled');
  await client.remove(job.id);
});

test('disallowed origins cannot pair or mutate state', async () => {
  const response = await fetch(`${baseUrl}/api/v1/pair`, { method: 'POST', headers: { Origin: 'https://evil.example', 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairingCode }) });
  assert.equal(response.status, 403);
});

test('reusing an idempotency key with changed content is a conflict', async () => {
  const client = createComputeClient({ baseUrl, token });
  const idempotencyKey = crypto.randomUUID();
  const submitted = await client.submit(spec(), { 'stack-0': stackA(), 'stack-1': stackB() }, { idempotencyKey });
  await assert.rejects(client.submit(spec({ options: { registration: 'none', iterations: 400 } }), { 'stack-0': stackA(), 'stack-1': stackB() }, { idempotencyKey }), error => error.status === 409 && error.code === 'conflict');
  await assert.rejects(client.submit(spec(), { 'stack-0': stackB(), 'stack-1': stackB() }, { idempotencyKey }), error => error.status === 409 && error.code === 'conflict');
  await client.watch(submitted.id);
  await client.remove(submitted.id);
});

test('SCT advertises a pinned CPU tool and preserves simulator artifact bytes', async () => {
  const client = createComputeClient({ baseUrl, token });
  const info = await client.info();
  const sct = info.tools.find(tool => tool.id === 'sct');
  assert.equal(sct.version, '7.3');
  assert.equal(sct.gpuRequired, false);
  assert.match(sct.image, /spinalcordtoolbox_7\.3\.3@sha256:974f6019/);
  assert.deepEqual(sct.commands, ['process_segmentation', 'analyze_lesion']);
  const cases = [
    [{ tool: 'sct', command: 'process_segmentation', cord: 'cord', options: { perSlice: true, angleCorrection: false, slices: '1:3,5' } }, { cord: stackA() }, ['morphometry.csv', 'log.txt']],
    [{ tool: 'sct', command: 'analyze_lesion', lesion: 'lesion', options: {} }, { lesion: stackA() }, ['lesion_analysis.xlsx', 'lesion_analysis.pkl', 'lesion_label.nii.gz', 'log.txt']],
    [{ tool: 'sct', command: 'analyze_lesion', lesion: 'lesion', cord: 'cord' }, { lesion: new Blob([gunzipSync(Buffer.from(await stackA().arrayBuffer()))]), cord: stackB() }, ['lesion_analysis.xlsx', 'lesion_analysis.pkl', 'lesion_label.nii', 'log.txt']],
  ];
  for (const [specification, files, names] of cases) {
    const receipt = await client.submit(specification, files);
    const done = await client.watch(receipt.id);
    assert.equal(done.status, 'succeeded');
    assert.deepEqual(done.outputs.map(output => output.name), names);
    const log = await (await client.output(done.id, 'log.txt')).text();
    assert.match(log, new RegExp(`sct_${specification.command}`));
    assert.doesNotMatch(log, /--device|--input-stacks/);
    if (specification.command === 'process_segmentation') {
      assert.match(log, /-perslice 1 -angle-corr 0 -z 1:3,5/);
      assert.equal(await (await client.output(done.id, 'morphometry.csv')).text(), 'Simulated,MEAN(area)\ntrue,0\n');
    } else {
      const label = names.find(name => name.includes('_label'));
      assert.deepEqual(Buffer.from(await (await client.output(done.id, label)).arrayBuffer()), Buffer.from(await files.lesion.arrayBuffer()));
    }
  }
});

test('SCT rejects unsupported command shapes and options before running', async () => {
  const client = createComputeClient({ baseUrl, token });
  const valid = { tool: 'sct', command: 'process_segmentation', cord: 'cord' };
  for (const [specification, files] of [
    [{ ...valid, options: { slices: '5:1' } }, { cord: stackA() }],
    [{ ...valid, options: { angleCorrection: 1 } }, { cord: stackA() }],
    [{ ...valid, options: { command: 'anything' } }, { cord: stackA() }],
    [{ ...valid, stacks: [] }, { cord: stackA() }],
    [{ ...valid, cord: 'other' }, { other: stackA() }],
    [valid, { cord: stackA(), lesion: stackB() }],
    [{ tool: 'sct', command: 'analyze_lesion', lesion: 'lesion', options: { perSlice: true } }, { lesion: stackA() }],
  ]) {
    await assert.rejects(client.submit(specification, files), error => error.code === 'invalid-spec');
  }
});

test('SCT cancellation reaches a terminal state without exposing artifacts', async () => {
  const client = createComputeClient({ baseUrl, token });
  const receipt = await client.submit({ tool: 'sct', command: 'analyze_lesion', lesion: 'lesion' }, { lesion: stackA() });
  await client.cancel(receipt.id);
  await assert.rejects(client.watch(receipt.id), error => error.code === 'cancelled');
  assert.deepEqual((await client.job(receipt.id)).outputs, []);
});
