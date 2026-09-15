import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { createModelResolver } from '../src/models.js';
import { loadBundle, verifyBundle } from '../src/bundle.js';
import { withoutModels } from '../../../scripts/desktop/without-models.mjs';

const hash = data => createHash('sha256').update(data).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'desktop-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const full = join(root, 'full');
  await mkdir(join(full, 'site/demo'), { recursive: true });
  await mkdir(join(full, 'assets'));
  const data = Buffer.from('a pinned model with weights');
  const url = 'https://models.example/model.onnx';
  const record = { sha256: hash(data), bytes: data.length, kind: 'model', path: `assets/${hash(data)}` };
  await writeFile(join(full, record.path), data);
  await writeFile(join(full, 'site/demo/index.html'), '<html>Demo</html>');
  await writeFile(join(full, 'site/demo/model.onnx'), data);
  await writeFile(join(full, 'manifest.json'), JSON.stringify({ schemaVersion: 1, apps: [{ id: 'demo', path: 'demo' }], assets: { [url]: record }, files: { 'site/demo/model.onnx': { sha256: record.sha256, bytes: data.length } } }));
  return { root, full, data, url, record };
}

test('the smaller package omits models and verifies their first download and cached reuse', async t => {
  const { root, full, data, url, record } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  await assert.rejects(readFile(join(light, record.path)), /ENOENT/);
  await assert.rejects(readFile(join(light, 'site/demo/model.onnx')), /ENOENT/);
  await verifyBundle(light);
  const bundle = await loadBundle(light);
  let requests = 0;
  const resolver = createModelResolver(light, bundle, join(root, 'cache'), async requested => {
    assert.equal(requested, url);
    requests++;
    return new Response(data);
  });
  const paths = await Promise.all([resolver.asset(url), resolver.asset(url)]);
  assert.deepEqual(await readFile(paths[0]), data);
  assert.equal(requests, 1);
  const offline = createModelResolver(light, bundle, join(root, 'cache'), () => { throw new Error('No network'); });
  assert.deepEqual(await readFile(await offline.file('site/demo/model.onnx')), data);
  await assert.rejects(offline.asset('https://unlisted.example/'), /not listed/);
});

test('corrupt downloaded models are rejected and can be retried', async t => {
  const { root, full, data, url } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  let bad = true;
  const resolver = createModelResolver(light, await loadBundle(light), join(root, 'cache'), async () => new Response(bad ? 'bad bytes' : data));
  await assert.rejects(resolver.asset(url), /integrity verification/);
  bad = false;
  assert.deepEqual(await readFile(await resolver.asset(url)), data);
});

test('the offline edition never downloads a missing model', async t => {
  const { root, full, url, record } = await fixture(t);
  await rm(join(full, record.path));
  const resolver = createModelResolver(full, await loadBundle(full), join(root, 'cache'), () => { throw new Error('Must not fetch'); });
  await assert.rejects(readFile(await resolver.asset(url)), /ENOENT/);
  await assert.rejects(verifyBundle(full), /ENOENT/);
});

test('local model pieces are reconstructed from the pinned complete model', async t => {
  const { root, full, data, url } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  const bundle = await loadBundle(light);
  const piece = data.subarray(3, 14);
  bundle.files['site/demo/model.part-00'] = { sha256: hash(piece), bytes: piece.length, remote: { url, offset: 3 } };
  const resolver = createModelResolver(light, bundle, join(root, 'cache'), async () => new Response(data));
  assert.deepEqual(await readFile(await resolver.file('site/demo/model.part-00')), piece);
});

test('remote file metadata cannot choose a cache path outside the model cache', async t => {
  const { root, full } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  const bundle = await loadBundle(light);
  bundle.files['site/demo/model.onnx'].sha256 = '../../outside';
  await writeFile(join(light, 'manifest.json'), JSON.stringify(bundle));
  await assert.rejects(loadBundle(light), /Unverified file/);
});
