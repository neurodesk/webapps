import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSETS,
  AV_FLAIR,
  HELD_PENDING,
  MODE_ASSETS,
  TEMPLATE_MASK,
  TEMPLATE_T1,
  assetsFor,
  fetchReader,
  findAsset,
  loadAssets,
  manifest,
  sha256Hex,
} from '../src/assets.js';
import { directoryReader, loadNodeAssets } from '../src/node-assets.js';

const PINNED = /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/bison\//;

test('the package manifest and models/bison.manifest.json are identical', async () => {
  const packageCopy = await readFile(new URL('../model.manifest.json', import.meta.url), 'utf8');
  const registryCopy = await readFile(new URL('../../../models/bison.manifest.json', import.meta.url), 'utf8');
  assert.equal(packageCopy, registryCopy);
});

test('every asset has a size, a sha256 and a unique name', () => {
  const all = [...manifest.assets, ...manifest.held_assets.assets, ...manifest.examples, ...manifest.validation];
  assert.equal(new Set(all.map((asset) => asset.filename)).size, all.length);
  for (const asset of all) {
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, asset.filename);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.filename);
    assert.ok(asset.license, asset.filename);
  }
});

test('published assets are pinned to a dataset commit', () => {
  assert.match(manifest.base_url, PINNED);
  assert.ok(manifest.base_url.includes(`/resolve/${manifest.revision}/`));
  for (const asset of ASSETS.filter((candidate) => !candidate.held)) assert.match(asset.url, PINNED, asset.filename);
});

// Placeholder: the BISON priors, average FLAIR, histograms and classifiers wait on the authors'
// permission. When they are uploaded, set held_assets.base_url to the pinned folder and remove
// this test's pending branch.
test('held assets are marked pending and have no URL', () => {
  assert.equal(HELD_PENDING, true, 'held assets were published: pin held_assets.base_url and update this test');
  assert.match(manifest.held_assets.status, /^PENDING/);
  for (const asset of ASSETS.filter((candidate) => candidate.held)) {
    assert.equal(asset.url, null, asset.filename);
    assert.ok(asset.filename.startsWith('models/'), asset.filename);
  }
});

test('a pending asset cannot be fetched without a local directory', async () => {
  const read = fetchReader({ fetch: () => assert.fail('no fetch for a pending asset') });
  await assert.rejects(read(findAsset(AV_FLAIR)), /not published yet/);
});

test('each mode lists its classifier, priors and histograms', () => {
  assert.equal(MODE_ASSETS.t1.priors.length, 8);
  assert.equal(MODE_ASSETS['t1-flair'].priors.length, 9);
  const t1 = assetsFor(['t1']).map((asset) => asset.filename);
  assert.ok(t1.includes(TEMPLATE_T1) && t1.includes(TEMPLATE_MASK));
  assert.ok(!t1.includes(AV_FLAIR));
  assert.equal(t1.length, 4 + 1 + 8 + 1);
  const both = assetsFor(['t1', 't1-flair']).map((asset) => asset.filename);
  assert.equal(both.length, 4 + 2 + 17 + 3 + 1);
  assert.throws(() => assetsFor(['t2']), /Unknown BISON mode/);
});

test('loadAssets verifies the size and sha256 of every file', async () => {
  const bytes = new TextEncoder().encode('bison');
  const asset = { filename: 'x.txt', bytes: bytes.length, sha256: await sha256Hex(bytes) };
  const files = await loadAssets([asset], { read: async () => bytes });
  assert.deepEqual(files.get('x.txt'), bytes);
  await assert.rejects(loadAssets([asset], { read: async () => new TextEncoder().encode('bisoN') }), /checksum/);
  await assert.rejects(loadAssets([asset], { read: async () => new TextEncoder().encode('bison!') }), /6 bytes, not 5/);
});

test('a local asset directory is read by manifest filename', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'bison-assets-'));
  await writeFile(join(dir, 'x.txt'), 'bison');
  const read = directoryReader(dir);
  assert.equal(new TextDecoder().decode(await read({ filename: 'x.txt' })), 'bison');
  await assert.rejects(read({ filename: 'models/missing.onnx' }), /missing from the BISON asset directory/);
  await assert.rejects(loadNodeAssets({ modes: ['t1'], assetDir: dir }), /missing from the BISON asset directory/);
});

test('BISON_ASSET_DIR holds every asset with the pinned bytes', { skip: !process.env.BISON_ASSET_DIR && 'set BISON_ASSET_DIR' }, async () => {
  const files = await loadNodeAssets({ modes: ['t1', 't1-flair'] });
  assert.equal(files.size, assetsFor(['t1', 't1-flair']).length);
});
