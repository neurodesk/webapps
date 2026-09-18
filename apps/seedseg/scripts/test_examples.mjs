import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { gunzipSync } from 'node:zlib';
import test from 'node:test';
import { createProstateSignalVoidPhantom, SYNTHETIC_MARKERS } from '../web/js/prostate-example.js';
import { createNiftiFromVolume, parseNiftiVolume } from '../../../packages/components/src/file-io/NiftiUtils.js';

const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));
const source = await readFile(new URL('../web/js/seedseg-app.js', import.meta.url), 'utf8');
const body = source.split('  async setupExamples() {')[1].split('\n  setupEventListeners() {')[0];
const makeSetup = new Function('createExampleSelector', 'fetch', 'document', `return async function() {${body}`);

test('synthetic example uses reproducible physical coordinates and three dark inclusions', () => {
  const volume = createProstateSignalVoidPhantom();
  assert.deepEqual(volume.dims, [96, 96, 64]);
  assert.deepEqual(volume.img, createProstateSignalVoidPhantom().img);
  const at = point => {
    const voxel = point.map((value, axis) => Math.round((value - volume.hdr.affine[axis][3]) / 0.75));
    return volume.img[voxel[0] + 96 * (voxel[1] + 96 * voxel[2])];
  };
  for (const { center } of SYNTHETIC_MARKERS) assert.ok(at(center) < at([0, 0, 0]) * 0.2);
  const nifti = parseNiftiVolume(createNiftiFromVolume(volume));
  assert.deepEqual(nifti.dims, [96, 96, 64]);
  assert.deepEqual(nifti.voxelSize, [0.75, 0.75, 0.75]);
  assert.ok(nifti.imageData.every(Number.isFinite));
});

test('selecting the hosted synthetic example imports its file without starting processing', async () => {
  let options;
  const loaded = [];
  const app = {
    updateOutput() {},
    inputReady: Promise.resolve(),
    async _handleUnifiedFiles(files, options) {
      assert.equal(options.assumeT1w, true);
      loaded.push(...files);
    },
  };
  const selector = {};
  const scope = {};
  const setup = makeSetup(value => { options = value; assert.equal(value.scope, scope); return selector; },
    async () => ({ ok: true, json: async () => examples }),
    { baseURI: 'https://example.org/seedseg/', getElementById: () => ({ closest: () => ({ prepend(element) { assert.equal(element, selector); } }) }), querySelector: selector => { assert.equal(selector, '.app-container'); return scope; } });
  await setup.call(app);
  const file = new File([createNiftiFromVolume(createProstateSignalVoidPhantom())], 'synthetic_prostate_signal_voids.nii');
  await options.onLoad(examples[0], { fetchFiles: async () => [file], assertCurrent() {} });
  assert.deepEqual(loaded, [file]);
  assert.deepEqual(parseNiftiVolume(await loaded[0].arrayBuffer()).dims, [96, 96, 64]);
  loaded.length = 0;
  await assert.rejects(options.onLoad(examples[0], {
    fetchFiles: async () => [file],
    assertCurrent() { throw new DOMException('Cancelled', 'AbortError'); },
  }), { name: 'AbortError' });
  assert.deepEqual(loaded, []);
});

test('declared T1 examples are assigned correctly even without T1 in the filename', () => {
  const ingest = source.slice(source.indexOf('  _handleUnifiedFiles('), source.indexOf('  _onDicomConversionComplete('));
  const categorize = source.slice(source.indexOf('  _addFilesToBuckets('), source.indexOf('  _moveToBucket('));
  const input = new Function(`return {${ingest}, ${categorize}}`)();
  input._buckets = { t1w: [], other: [] };
  input._onBucketsChanged = () => {};
  const file = new File(['volume'], 'synthetic_prostate_signal_voids.nii');
  input._handleUnifiedFiles([file], { assumeT1w: true });
  assert.deepEqual(input._buckets.t1w, [file]);
  assert.deepEqual(input._buckets.other, []);
});

test('the exporter writes repeatable NIfTI and gzip files with provenance', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'seedseg-example-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const script = new URL('./export_example.mjs', import.meta.url);
  for (const extension of ['nii', 'nii.gz']) {
    const output = join(directory, `example.${extension}`);
    execFileSync(process.execPath, [script.pathname, output]);
    const bytes = await readFile(output);
    const raw = extension === 'nii' ? bytes : gunzipSync(bytes);
    const nifti = parseNiftiVolume(raw);
    assert.deepEqual(nifti.dims, [96, 96, 64]);
    assert.deepEqual(nifti.voxelSize, [0.75, 0.75, 0.75]);
    const metadata = JSON.parse(await readFile(`${output}.json`));
    assert.equal(metadata.generator, 'prostate-signal-voids-v1');
    assert.equal(metadata.bytes, bytes.length);
    assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  }
});
