#!/usr/bin/env node
// Existing MuscleMap parity cases, independent PyTorch masks, and captures from
// the actual production browser worker. Native and browser inference are serialized.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { createNiftiFromData, createNiftiFromVolume, parseNiftiVolume, readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { gunzipSync } from 'node:zlib';
import { compareWithUpstream, UPSTREAM_GATE } from '../../../apps/musclemap/test/upstream-reference.mjs';
import { selectModel, defaultCacheDir } from '../src/node.js';
import { MuscleMapLabelCodec } from '../src/label-codec.js';
import { outputNames } from '../src/results.js';
const upstream = JSON.parse(await readFile(new URL('../../../apps/musclemap/model-sources/parity-reference.json', import.meta.url)));
const CASES = ['body-first17', 'body-first17-multichunk', 'knee-slab', 'wholebody13-first17',
  'abdomen-slab', 'leg-slab', 'pelvis-slab', 'thigh-slab'];
const { values } = parseArgs({ options: { executable: { type: 'string' }, case: { type: 'string' }, outputs: { type: 'string' } } });
const command = values.executable ? [resolve(values.executable)] : [process.execPath, fileURLToPath(new URL('../bin/musclemap.js', import.meta.url))];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const scratch = await mkdtemp(join(tmpdir(), 'musclemap-cli-check-'));
const failures = [];
function check(passed, text) {
  if (!passed) failures.push(text);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${text}`);
}
async function pinned(manifest, path) {
  const pin = manifest.files.find(file => file.path === path);
  if (!pin) throw new Error(`Missing reference pin: ${path}`);
  const destination = join(tmpdir(), 'neurodesk-musclemap-validation', manifest.revision, path);
  const cached = await readFile(destination).catch(() => null);
  if (cached && cached.length === pin.bytes && sha256(cached) === pin.sha256) return destination;
  const url = `https://huggingface.co/datasets/${manifest.repository}/resolve/${manifest.revision}/${manifest.prefix}/${path}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== pin.bytes || sha256(bytes) !== pin.sha256) throw new Error(`${path}: reference checksum mismatch`);
  await mkdir(dirname(destination), { recursive: true });
  const partial = `${destination}.${randomUUID()}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, destination);
  return destination;
}
async function compare(bytes, referencePath, description) {
  const reference = await readNifti(await readFile(referencePath), Uint16Array);
  const measured = await compareWithUpstream(bytes, { dims: reference.dims, labels: reference.data, affine: reference.header.affine });
  check(measured.affineMatches && measured.overallAgreement >= UPSTREAM_GATE.minimumOverallAgreement &&
    measured.foregroundDice >= UPSTREAM_GATE.minimumForegroundDice && !measured.labelsBelowGate.length,
  `${description}: agreement=${measured.overallAgreement}, foregroundDice=${measured.foregroundDice}, minimumLabelDice=${measured.worstLabelDice}, identicalAffine=${measured.affineMatches}`);
}
// Independently count the command's sparse labels and slices, then check the CSV
// and class-index download. This catches wrong checkpoint attribution or units.
async function checkOutputs(output, input, model) {
  const names = outputNames(basename(input));
  assert.deepEqual((await readdir(output)).sort(), Object.values(names).sort());
  const bytes = await readFile(join(output, names.segmentation));
  const parsed = parseNiftiVolume(bytes, { decompress: gunzipSync });
  const display = parseNiftiVolume(await readFile(join(output, names.display)), { decompress: gunzipSync });
  const codec = MuscleMapLabelCodec.createLabelCodec(model.labelSpace);
  const dense = codec.normalizeSegmentation(parsed.imageData, 'sparse').indices;
  assert.deepEqual(Array.from(display.imageData), Array.from(dense));
  const counts = new Map();
  const slices = new Map();
  const spacing = parsed.voxelSize;
  const axis = Math.max(...spacing) / Math.min(...spacing) < 1.01 ? 2 : spacing.indexOf(Math.max(...spacing));
  const strides = [1, parsed.dims[0], parsed.dims[0] * parsed.dims[1]];
  for (let i = 0; i < dense.length; i++) {
    const label = dense[i];
    if (!label) continue;
    counts.set(label, (counts.get(label) || 0) + 1);
    if (!slices.has(label)) slices.set(label, new Set());
    slices.get(label).add(Math.floor(i / strides[axis]) % parsed.dims[axis]);
  }
  const voxelMm3 = spacing.reduce((product, value) => product * value, 1);
  const rows = ['label_index,label_name,volume_ml,slice_count'];
  let total = 0;
  for (const label of [...counts.keys()].sort((a, b) => a - b)) {
    const volume = counts.get(label) * voxelMm3 / 1000;
    total += volume;
    const name = model.labelSpace.labels[label].name;
    const escaped = /[",\n]/.test(name) ? `"${name.replaceAll('"', '""')}"` : name;
    rows.push(`${label},${escaped},${volume.toFixed(4)},${slices.get(label).size}`);
  }
  rows.push(`,TOTAL,${total.toFixed(4)},`);
  assert.equal(await readFile(join(output, names.metrics), 'utf8'), rows.join('\n'));
  return bytes;
}
try {
  const cases = CASES.filter(id => !values.case || id === values.case);
  if (!cases.length) throw new Error(`Unknown validation case ${values.case}`);
  for (const id of cases) {
    const authority = upstream.cases.find(candidate => candidate.id === id);
    if (!authority) throw new Error(`Missing independent upstream case ${id}`);
    const input = await pinned(upstream, authority.input);
    const independent = await pinned(upstream, authority.reference);
    const captured = join(scratch, `${id}-browser.nii`);
    const output = values.outputs ? join(resolve(values.outputs), id) : join(scratch, id);
    const run = spawnSync(command[0], [...command.slice(1), input, output, '--model', `${authority.model}-v${authority.modelVersion}`,
      '--overlap', String(authority.overlap), '--source-chunk-size', String(authority.sourceChunkSize), '--threads', '4'],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`${id}: executable failed (${run.status}):\n${run.stderr}`);
    const result = JSON.parse(run.stdout);
    check(result.modelSha256 === authority.modelSha256 && result.threads === 4, `${id}: pinned checkpoint, four CPU threads, ${result.seconds.toFixed(2)} s`);
    const bytes = await checkOutputs(output, input, selectModel(`${authority.model}-v${authority.modelVersion}`).model);
    check(true, `${id}: web filenames, display labels and volume CSV agree with sparse anatomical labels`);
    await compare(bytes, independent, `${id} versus upstream PyTorch`);
    const { asset } = selectModel(`${authority.model}-v${authority.modelVersion}`);
    const modelDirectory = values.executable ? join(dirname(await realpath(values.executable)), 'models') : defaultCacheDir();
    const browserReport = join(scratch, `${id}-browser.json`);
    const browserHome = join(scratch, 'browser-home');
    await mkdir(browserHome, { recursive: true });
    const browserEnv = { ...process.env };
    for (const name of ['HOME', 'USERPROFILE', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) browserEnv[name] = browserHome;
    const capture = spawnSync(process.execPath, [fileURLToPath(new URL('../../../apps/musclemap/scripts/validate_upstream_parity.mjs', import.meta.url)),
      '--production', '--case', id, '--reference-root', dirname(dirname(input)), '--model-file', join(modelDirectory, asset.filename),
      '--output', captured, '--report', browserReport, '--port', '4392', '--python', process.platform === 'win32' ? 'python' : 'python3'],
    { encoding: 'utf8', env: browserEnv, maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000 });
    if (capture.error) throw capture.error;
    if (capture.status !== 0) throw new Error(`${id}: actual browser worker validation failed (${capture.status}):\n${capture.stdout}\n${capture.stderr}`);
    const browserRun = JSON.parse(await readFile(browserReport, 'utf8'));
    check(browserRun.status === 'passed', `${id}: actual browser worker versus upstream PyTorch`);
    console.log(`INFO ${id}: ORT-Node ${result.onnxRuntime}, ORT-Web ${browserRun.run.ortVersion}, Chromium ${browserRun.run.browserVersion}, four threads each, serialized inference`);
    await compare(bytes, captured, `${id} versus actual browser WASM`);
  }
  // The existing author references have no forearm anatomical case. Exercise
  // its real graph and label-space transport on a small synthetic volume.
  const phantom = join(scratch, 'forearm-runtime.nii');
  await writeFile(phantom, new Uint8Array(createNiftiFromVolume({ dims: [10, 10, 2],
    hdr: { affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] },
    img: Float32Array.from({ length: 200 }, (_, i) => 10 + i) })));
  const forearmOutput = join(scratch, 'forearm-runtime');
  const forearm = spawnSync(command[0], [...command.slice(1), phantom, forearmOutput,
    '--model', 'forearm-v0.0', '--batch-size', '2', '--threads', '4'],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000 });
  if (forearm.error) throw forearm.error;
  if (forearm.status !== 0) throw new Error(`Forearm checkpoint runtime smoke failed: ${forearm.stderr}`);
  await checkOutputs(forearmOutput, phantom, selectModel('forearm-v0.0').model);
  check(true, 'forearm-v0.0 real graph and checkpoint-specific labels, batch size 2 (runtime smoke; no anatomical accuracy claim)');

  const single = upstream.cases.find(item => item.id === 'body-single-slice');
  const imfInput = await pinned(upstream, single.input);
  const source = parseNiftiVolume(await readFile(imfInput), { decompress: gunzipSync });
  const fat = join(scratch, 'fat20.nii');
  const water = join(scratch, 'water80.nii');
  await writeFile(fat, new Uint8Array(createNiftiFromData(new Float32Array(source.imageData.length).fill(20), source.headerBytes, { dims: source.dims })));
  await writeFile(water, new Uint8Array(createNiftiFromData(new Float32Array(source.imageData.length).fill(80), source.headerBytes, { dims: source.dims })));
  for (const [method, components] of [['kmeans', 2], ['gmm', 3], ['dixon', 2], ['both-gmm', 3]]) {
    const destination = join(scratch, `imf-${method}`);
    const args = [...command.slice(1), imfInput, destination, '--threads', '4', '--overlap', String(single.overlap),
      '--source-chunk-size', String(single.sourceChunkSize), '--imf', method, '--imf-components', String(components)];
    if (method.includes('dixon') || method.startsWith('both')) args.push('--fat', fat, '--water', water);
    const run = spawnSync(command[0], args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 20 * 60 * 1000 });
    if (run.error) throw run.error;
    if (run.status !== 0) throw new Error(`CLI ${method} IMF failed: ${run.stderr}`);
    const names = outputNames(basename(imfInput));
    await compare(await readFile(join(destination, names.segmentation)), await pinned(upstream, single.reference), `${method} IMF keeps the independently validated segmentation`);
    const csv = (await readFile(join(destination, names.metrics), 'utf8')).split('\n').map(row => row.split(','));
    const columns = csv.shift();
    const rows = csv.map(row => Object.fromEntries(columns.map((name, i) => [name, row[i]])));
    assert.ok(rows.some(row => row.label_name !== 'TOTAL'));
    if (method !== 'dixon') {
      const threshold = rows.filter(row => row.imf_mode === 'threshold');
      assert.ok(threshold.length > 0);
      assert.ok(threshold.every(row => row.imf_method === (method.endsWith('gmm') ? 'gmm' : method) && Number(row.imf_components) === components));
    }
    if (method.includes('dixon') || method.startsWith('both')) {
      const dixon = rows.filter(row => row.imf_mode === 'dixon');
      assert.ok(dixon.length > 0);
      assert.ok(dixon.every(row => row.fat_percent === '20.00' && row.muscle_percent === '80.00'));
    }
    check(true, `${method} CLI IMF options, checkpoint labels and CSV${method.includes('dixon') || method.startsWith('both') ? '; constant Dixon truth is 20% fat / 80% muscle' : ''}`);
  }
  if (failures.length) throw new Error(`${failures.length} MuscleMap parity checks failed`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
