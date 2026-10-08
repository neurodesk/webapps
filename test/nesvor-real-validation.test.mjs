import { tmpdir } from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { requireScientificBackend, validateScientificOutput, cachedAsset, runScientificValidation, cleanupScientificJob } from '../scripts/verify-nesvor-real.mjs';
import { writeVolume } from '../packages/synthsr/src/volume.js';
import { presetOptions } from '../apps/nesvor/src/spec.js';

const image = `vnmd/nesvor_0.5.0@sha256:${'a'.repeat(64)}`;
const options = presetOptions('fetal-brain');
const info = { simulated: false, runner: 'docker', gpu: { available: true }, tools: [{ id: 'nesvor', version: '0.5.0', image }] };
const provenance = { registration: 'svort', svort_version: 'v2', segmentation: true, bias_field_correction: true, n_iter: 6000, output_resolution: 0.8, batch_size: 4096, log2_hashmap_size: 19, single_precision: false, weight_transformation: 0.1, weight_image: 1, n_samples: 256, n_levels_bias: 0, no_slice_scale: false, no_slice_variance: false, no_pixel_variance: false, no_transformation_optimization: false, device: 0 };
const log = 'Registration starts\nNeSVoR training starts\nResults saving starts';
const volume = data => writeVolume({ dims: [2, 2, 2], data: Float32Array.from(data), affine: [[0.8, 0, 0, 0], [0, 0.8, 0, 0], [0, 0, 0.8, 0], [0, 0, 0, 1]] });

test('real gate refuses simulator, missing GPU, native runner and wrong pin', () => {
  assert.doesNotThrow(() => requireScientificBackend(info, image));
  for (const invalid of [{ ...info, simulated: true }, { ...info, simulated: undefined }, { ...info, gpu: { available: false } }, { ...info, runner: 'native' }]) assert.throws(() => requireScientificBackend(invalid, image));
  assert.throws(() => requireScientificBackend(info, `${image}0`), /digest/);
});

test('output gate checks numerical sanity, affine spacing and actual upstream settings', () => {
  const good = volume([0, 1, 2, 3, 4, 5, 6, 7]);
  const metrics = validateScientificOutput(good, provenance, log, options);
  assert.equal(metrics.maximum, 7);
  assert.deepEqual(metrics.dims, [2, 2, 2]);
  assert.throws(() => validateScientificOutput(volume(Array(8).fill(1)), provenance, log, options), /constant/);
  assert.throws(() => validateScientificOutput(volume([NaN, 1, 2, 3, 4, 5, 6, 7]), provenance, log, options), /non-finite/);
  assert.throws(() => validateScientificOutput(good, { ...provenance, n_iter: 100 }, log, options), /n_iter/);
  assert.throws(() => validateScientificOutput(good, { ...provenance, device: -1 }, log, options), /CUDA/);
  assert.throws(() => validateScientificOutput(good, provenance, 'fake output', options), /log/);
  assert.throws(() => validateScientificOutput(good, provenance, log, { ...options, outputResolution: 1 }), /spacing/);
});

test('locked example cache rejects corruption and only returns verified bytes', async () => {
  const cache = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'nesvor-cache-test-'));
  try {
    const bytes = Buffer.from('public fixture');
    const lock = { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
    const entry = { name: 'fixture', url: 'https://example.invalid/pinned' };
    await assert.rejects(cachedAsset(entry, lock, cache, { fetch: async () => new Response('corrupt') }), /checksum/);
    let downloads = 0;
    const fetch = async () => { downloads++; return new Response(bytes); };
    assert.deepEqual(await cachedAsset(entry, lock, cache, { fetch }), bytes);
    assert.deepEqual(await cachedAsset(entry, lock, cache, { fetch }), bytes);
    assert.equal(downloads, 1);
    await writeFile(join(cache, lock.sha256), 'corrupt cached content');
    assert.deepEqual(await cachedAsset(entry, lock, cache, { fetch }), bytes);
    assert.equal(downloads, 2);
  } finally { await rm(cache, { recursive: true, force: true }); }
});

test('missing infrastructure fails and simulated info prevents any example transfer', async () => {
  await assert.rejects(runScientificValidation(), /never skips/);
  const directory = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'nesvor-gate-test-'));
  try {
    const requests = [];
    await assert.rejects(runScientificValidation({ baseUrl: 'http://127.0.0.1:9999', credential: 'owner-secret', thicknesses: [3], reportDirectory: join(directory, 'report'), cacheDirectory: join(directory, 'cache'), fetch: async (url, init) => {
      requests.push(url);
      assert.equal(init.headers.Authorization, 'Bearer owner-secret');
      assert.ok(!url.includes('owner-secret'));
      return Response.json({ simulated: true, runner: 'simulate' });
    } }), /refuses simulated/);
    assert.equal(requests.length, 1);
    assert.match(requests[0], /\/info$/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('failure cleanup waits for runner termination before deleting patient files', async () => {
  const calls = [];
  const client = {
    cancel: async () => calls.push('cancel'),
    watch: async () => { calls.push('watch'); throw Object.assign(new Error('cancelled'), { code: 'cancelled' }); },
    job: async () => { calls.push('job'); return { status: 'cancelled' }; },
    remove: async () => calls.push('remove'),
  };
  await cleanupScientificJob(client, 'job');
  assert.deepEqual(calls, ['cancel', 'watch', 'job', 'remove']);
  calls.length = 0;
  client.job = async () => ({ status: 'cancelling' });
  await assert.rejects(cleanupScientificJob(client, 'job'), /Runner has not stopped/);
  assert.ok(!calls.includes('remove'));
});
