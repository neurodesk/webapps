import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ASSETS,
  AV_FLAIR,
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
import { defaultCacheDir, directoryReader, loadNodeAssets } from '../src/node-assets.js';

const PINNED = /^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[0-9a-f]{40}\/bison\//;

test('the package manifest and models/bison.manifest.json are identical', async () => {
  const packageCopy = await readFile(new URL('../model.manifest.json', import.meta.url), 'utf8');
  const registryCopy = await readFile(new URL('../../../models/bison.manifest.json', import.meta.url), 'utf8');
  assert.equal(packageCopy, registryCopy);
});

test('every asset has a size, a sha256 and a unique name', () => {
  const all = [...manifest.assets, ...manifest.examples, ...manifest.validation];
  assert.equal(new Set(all.map((asset) => asset.filename)).size, all.length);
  for (const asset of all) {
    assert.ok(Number.isSafeInteger(asset.bytes) && asset.bytes > 0, asset.filename);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/, asset.filename);
    assert.ok(asset.license, asset.filename);
  }
});

test('every asset is pinned to a dataset commit, at its own path', () => {
  assert.match(manifest.base_url, PINNED);
  assert.ok(manifest.base_url.includes(`/resolve/${manifest.revision}/`));
  for (const asset of ASSETS) {
    assert.match(asset.url, PINNED, asset.filename);
    assert.ok(asset.url.endsWith(`/bison/${asset.filename}`), asset.filename);
  }
  assert.equal(ASSETS.filter((asset) => asset.filename.startsWith('models/')).length, 24);
});

test('an asset is fetched from its pinned URL', async () => {
  const urls = [];
  const read = fetchReader({ fetch: async (url) => (urls.push(url), new Response(new Uint8Array([1, 2]))) });
  assert.deepEqual([...new Uint8Array(await read(findAsset(AV_FLAIR)))], [1, 2]);
  assert.deepEqual(urls, [findAsset(AV_FLAIR).url]);
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

test('the portable release reads its bundled models offline from NEURODESK_BISON_MODEL_DIR', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'bison-models-'));
  const saved = Object.fromEntries(['BISON_ASSET_DIR', 'NEURODESK_BISON_MODEL_DIR', 'NEURODESK_OFFLINE'].map((name) => [name, process.env[name]]));
  t.after(() => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
  delete process.env.BISON_ASSET_DIR;
  process.env.NEURODESK_BISON_MODEL_DIR = dir;
  process.env.NEURODESK_OFFLINE = '1';
  assert.equal(defaultCacheDir(), dir);
  const fetch = () => assert.fail('an offline run must not download');
  await assert.rejects(loadNodeAssets({ modes: ['t1'], fetch }), (error) => error.message.includes(`missing from the offline asset cache ${dir}`));
});

test('BISON_ASSET_DIR holds every asset with the pinned bytes', { skip: !process.env.BISON_ASSET_DIR && 'set BISON_ASSET_DIR' }, async () => {
  const files = await loadNodeAssets({ modes: ['t1', 't1-flair'] });
  assert.equal(files.size, assetsFor(['t1', 't1-flair']).length);
});
