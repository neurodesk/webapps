import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, writeFile, readFile, rm } from 'node:fs/promises';
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
  const resolver = createModelResolver(light, bundle, join(root, 'cache'), { fetchModel: async requested => {
    assert.equal(requested, url);
    requests++;
    return new Response(data);
  } });
  const paths = await Promise.all([resolver.asset(url), resolver.asset(url)]);
  assert.deepEqual(await readFile(paths[0]), data);
  assert.equal(requests, 1);
  const offline = createModelResolver(light, bundle, join(root, 'cache'), { fetchModel: () => { throw new Error('No network'); } });
  assert.deepEqual(await readFile(await offline.file('site/demo/model.onnx')), data);
  await assert.rejects(offline.asset('https://unlisted.example/'), /not listed/);
});

test('corrupt downloaded models are rejected and can be retried', async t => {
  const { root, full, data, url } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  let bad = true;
  const resolver = createModelResolver(light, await loadBundle(light), join(root, 'cache'), { fetchModel: async () => new Response(bad ? 'bad bytes' : data) });
  await assert.rejects(resolver.asset(url), /integrity verification/);
  bad = false;
  assert.deepEqual(await readFile(await resolver.asset(url)), data);
});

test('the offline edition never downloads a missing model', async t => {
  const { root, full, url, record } = await fixture(t);
  await rm(join(full, record.path));
  const resolver = createModelResolver(full, await loadBundle(full), join(root, 'cache'), { fetchModel: () => { throw new Error('Must not fetch'); } });
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
  const resolver = createModelResolver(light, bundle, join(root, 'cache'), { fetchModel: async () => new Response(data) });
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

test('verification rejects model files accidentally copied into the smaller edition', async t => {
  const { root, full, data, record } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  await writeFile(join(light, record.path), data);
  await assert.rejects(verifyBundle(light), /unexpectedly included/);
});

test('an extracted model pack serves models in place, without the network and without touching the cache', async t => {
  const { root, full, data, url, record } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  const pack = join(root, 'pack');
  await mkdir(pack);
  await writeFile(join(pack, record.sha256), data);
  const cache = join(root, 'cache');
  const resolver = createModelResolver(light, await loadBundle(light), cache, { pack, fetchModel: () => { throw new Error('Must not fetch'); } });
  assert.equal(await resolver.asset(url), join(pack, record.sha256));
  assert.equal(await resolver.file('site/demo/model.onnx'), join(pack, record.sha256));
  assert.deepEqual(await readFile(await resolver.asset(url)), data);
  await assert.rejects(readdir(cache), /ENOENT/);
  assert.deepEqual(await readdir(pack), [record.sha256]);
});

test('a model pack still supplies the pinned source for a split model piece', async t => {
  const { root, full, data, url, record } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  const pack = join(root, 'pack');
  await mkdir(pack);
  await writeFile(join(pack, record.sha256), data);
  const bundle = await loadBundle(light);
  const piece = data.subarray(3, 14);
  bundle.files['site/demo/model.part-00'] = { sha256: hash(piece), bytes: piece.length, remote: { url, offset: 3 } };
  const cache = join(root, 'cache');
  const resolver = createModelResolver(light, bundle, cache, { pack, fetchModel: () => { throw new Error('Must not fetch'); } });
  assert.deepEqual(await readFile(await resolver.file('site/demo/model.part-00')), piece);
  assert.deepEqual(await readdir(cache), [hash(piece)]);
  assert.deepEqual(await readdir(pack), [record.sha256]);
});

test('an incomplete or corrupt model pack falls back to the cache and the network', async t => {
  const { root, full, data, url, record } = await fixture(t);
  const light = join(root, 'light');
  await withoutModels(full, light);
  const empty = join(root, 'empty-pack');
  await mkdir(empty);
  const cache = join(root, 'cache');
  let requests = 0;
  const bundle = await loadBundle(light);
  const fetchModel = async () => { requests++; return new Response(data); };
  const missing = createModelResolver(light, bundle, cache, { pack: empty, fetchModel });
  assert.equal(await missing.asset(url), join(cache, record.sha256));
  assert.equal(requests, 1);
  const corrupt = join(root, 'corrupt-pack');
  await mkdir(corrupt);
  await writeFile(join(corrupt, record.sha256), 'truncated');
  const rejected = createModelResolver(light, bundle, join(root, 'other-cache'), { pack: corrupt, fetchModel });
  assert.deepEqual(await readFile(await rejected.asset(url)), data);
  assert.equal(requests, 2);
  assert.deepEqual(await readFile(join(corrupt, record.sha256), 'utf8'), 'truncated');
});
