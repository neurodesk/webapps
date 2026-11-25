#!/usr/bin/env node
// Portable release validation for @neurodesk/tumour-report.
// 1. Prefetches the pinned BEAMSTER_A_038 example into tmpdir() BEFORE invoking the CLI.
// 2. Runs every CLI call with --offline (and under `unshare -rn` on Linux when available).
// 3. Independently parses raw NIfTI headers & voxel bytes with DataView (never trusting
//    the package's own reader or CLI JSON summaries alone).
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { gunzipSync } from 'node:zlib';

const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/tumour-report.js', import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL('../../../apps/tumour-report/examples.json', import.meta.url), 'utf8'),
);
const reference = JSON.parse(
  await readFile(new URL('./container-reference.json', import.meta.url), 'utf8'),
);
const exampleSpec = examples.find((item) => item.id === 'beamster-a-038')?.files?.[0];
assert.ok(exampleSpec, 'Pinned beamster-a-038 example must exist in apps/tumour-report/examples.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function probeUnshareNetwork() {
  if (process.platform !== 'linux') return false;
  const check = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
  return !check.error && check.status === 0;
}

const USE_UNSHARE = probeUnshareNetwork();

async function ensureExample(spec) {
  const cacheDir = join(tmpdir(), 'neurodesk-tumour-report-validation-cache');
  const targetPath = join(cacheDir, spec.name);
  try {
    const existing = await readFile(targetPath);
    if (existing.length === spec.bytes && sha256(existing) === spec.sha256) {
      return targetPath;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const response = await fetch(spec.url);
  assert.ok(response.ok, `Download ${spec.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.length, spec.bytes, `${spec.name} byte length mismatch`);
  assert.equal(sha256(bytes), spec.sha256, `${spec.name} SHA-256 mismatch`);
  await mkdir(cacheDir, { recursive: true });
  const partial = `${targetPath}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, targetPath);
  } finally {
    await rm(partial, { force: true });
  }
  return targetPath;
}

function runCliIsolated(args) {
  const full = [...command, ...args];
  const run = USE_UNSHARE
    ? spawnSync('unshare', ['-rn', 'sh', '-c', 'ip link set lo up && exec "$@"', '--', ...full], {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      })
    : spawnSync(full[0], full.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      });
  if (run.error) throw run.error;
  return run;
}

// Independent raw DataView NIfTI-1/NIfTI-2 parser for validation receipts.
function parseRawNifti(rawBuffer) {
  let bytes = new Uint8Array(rawBuffer.buffer, rawBuffer.byteOffset, rawBuffer.byteLength);
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    bytes = new Uint8Array(gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }));
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le1 = view.getInt32(0, true) === 348;
  const be1 = !le1 && view.getInt32(0, false) === 348;
  const le2 = !le1 && !be1 && bytes.length >= 540 && view.getInt32(0, true) === 540;
  const be2 = !le1 && !be1 && !le2 && bytes.length >= 540 && view.getInt32(0, false) === 540;
  assert.ok(le1 || be1 || le2 || be2, 'Output must be a valid NIfTI-1 or NIfTI-2 file');
  const v2 = le2 || be2;
  const le = le1 || le2;
  const dims = v2
    ? [1, 2, 3].map((i) => Number(view.getBigInt64(16 + i * 8, le)))
    : [1, 2, 3].map((i) => view.getInt16(40 + i * 2, le));
  const datatype = view.getInt16(v2 ? 12 : 70, le);
  const voxOffset = v2 ? Number(view.getBigInt64(168, le)) : Math.trunc(view.getFloat32(108, le));
  const qformCode = v2 ? view.getInt32(344, le) : view.getInt16(252, le);
  const sformCode = v2 ? view.getInt32(348, le) : view.getInt16(254, le);
  const srowOffset = v2 ? 400 : 280;
  const step = v2 ? 8 : 4;
  const getF = v2 ? (o) => view.getFloat64(o, le) : (o) => view.getFloat32(o, le);
  const sform = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => getF(srowOffset + (r * 4 + c) * step)));
  const total = dims[0] * dims[1] * dims[2];
  const readers = {
    2: [1, (o) => view.getUint8(o)],
    4: [2, (o) => view.getInt16(o, le)],
    8: [4, (o) => view.getInt32(o, le)],
    16: [4, (o) => view.getFloat32(o, le)],
    64: [8, (o) => view.getFloat64(o, le)],
  };
  const [stride, readOne] = readers[datatype] ?? [];
  assert.ok(stride, `Unexpected NIfTI datatype ${datatype}`);
  assert.ok(voxOffset + total * stride <= bytes.length, 'Truncated NIfTI payload');
  const sclSlope = getF(v2 ? 176 : 112);
  const sclInter = getF(v2 ? 184 : 116);
  const slope = Number.isFinite(sclSlope) && sclSlope !== 0 ? sclSlope : 1;
  const inter = Number.isFinite(sclSlope) && sclSlope !== 0 && Number.isFinite(sclInter) ? sclInter : 0;
  let nonZero = 0;
  let binary = true;
  for (let i = 0; i < total; i += 1) {
    const val = readOne(voxOffset + i * stride) * slope + inter;
    assert.ok(Number.isFinite(val), `Non-finite voxel at ${i}`);
    if (val !== 0) {
      nonZero += 1;
      if (val !== 1) binary = false;
    }
  }
  return { dims, datatype, qformCode, sformCode, sform, total, nonZero, binary };
}

function assertSformClose(a, b, label) {
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      assert.ok(
        Math.abs(a[r][c] - b[r][c]) <= 1e-4,
        `${label} sform[${r}][${c}] mismatch: ${a[r][c]} vs ${b[r][c]}`,
      );
    }
  }
}

// Prefetch pinned fixture BEFORE running any CLI commands.
const examplePath = await ensureExample(exampleSpec);
const inputRaw = parseRawNifti(await readFile(examplePath));
console.log(
  `network_isolation=${USE_UNSHARE ? 'unshare-rn' : 'flag-only (unshare -rn unavailable)'}`,
);

const work = await mkdtemp(join(tmpdir(), 'tumour-report-cli-check-'));
try {
  // 1. Offline self-check (verifies ORT, Greedy WASM, and bundled models)
  const selfCheck = runCliIsolated(['self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stderr}`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  assert.equal(selfInfo.ok, true, 'self-check must report ok=true');
  assert.equal(selfInfo.executionProvider, 'cpu', 'self-check must report cpu provider');
  assert.equal(selfInfo.greedy, 'wasm-single', 'self-check must report greedy wasm-single');
  console.log(
    `PASS self-check (v${selfInfo.version}, ORT ${selfInfo.onnxRuntime}, ${selfInfo.assets} assets, modelsVerified=${selfInfo.modelsVerified})`,
  );

  // 2. Full offline segmentation + native morphometry + MNI Greedy RADS on BEAMSTER_A_038
  const outDir = join(work, 'beamster-full');
  const fullRun = runCliIsolated([
    examplePath,
    outDir,
    '--tumour-type',
    'metastasis',
    '--threads',
    '4',
    '--offline',
  ]);
  assert.equal(fullRun.status, 0, `full segmentation failed:\n${fullRun.stderr}`);
  const fullSummary = JSON.parse(fullRun.stdout.trim());
  assert.equal(fullSummary.provenance.executionProvider, 'cpu');
  assert.equal(fullSummary.provenance.mode, 'raidionics-v1.3');
  assert.equal(fullSummary.lesionCount, reference.results.nativeTumour.lesionCount);
  assert.ok(
    Math.abs(fullSummary.totalVolumeMl - reference.results.nativeTumour.totalVolumeMl) <= 0.5,
    `totalVolumeMl ${fullSummary.totalVolumeMl} drifted from reference ${reference.results.nativeTumour.totalVolumeMl}`,
  );

  const brainRaw = parseRawNifti(await readFile(join(outDir, 'BEAMSTER_A_038_T1c_brain_mask.nii')));
  const tumourRaw = parseRawNifti(await readFile(join(outDir, 'BEAMSTER_A_038_T1c_tumour_mask.nii')));
  const mniRaw = parseRawNifti(await readFile(join(outDir, 'BEAMSTER_A_038_T1c_tumour_mask_mni.nii')));

  assert.deepEqual(brainRaw.dims, inputRaw.dims);
  assert.deepEqual(tumourRaw.dims, inputRaw.dims);
  assert.equal(brainRaw.binary, true, 'brain mask must be binary {0, 1}');
  assert.equal(tumourRaw.binary, true, 'tumour mask must be binary {0, 1}');
  assert.equal(mniRaw.binary, true, 'MNI mask must be binary {0, 1}');
  assert.equal(brainRaw.qformCode, inputRaw.qformCode, 'brain mask preserves qform_code');
  assert.equal(brainRaw.sformCode, inputRaw.sformCode, 'brain mask preserves sform_code');
  assert.equal(tumourRaw.qformCode, inputRaw.qformCode, 'tumour mask preserves qform_code');
  assert.equal(tumourRaw.sformCode, inputRaw.sformCode, 'tumour mask preserves sform_code');
  if (inputRaw.sformCode > 0) {
    assertSformClose(brainRaw.sform, inputRaw.sform, 'brain mask');
    assertSformClose(tumourRaw.sform, inputRaw.sform, 'tumour mask');
  }
  assert.deepEqual(mniRaw.dims, [197, 233, 189]);

  assert.ok(
    Math.abs(brainRaw.nonZero - reference.results.nativeBrain.nodeVoxels) <= reference.results.nativeBrain.nodeVoxels * 0.02,
    `brainVoxels ${brainRaw.nonZero} drifted from reference ${reference.results.nativeBrain.nodeVoxels}`,
  );
  assert.ok(
    Math.abs(tumourRaw.nonZero - reference.results.nativeTumour.nodeVoxels) <= reference.results.nativeTumour.nodeVoxels * 0.02,
    `tumourVoxels ${tumourRaw.nonZero} drifted from reference ${reference.results.nativeTumour.nodeVoxels}`,
  );
  assert.ok(mniRaw.nonZero > 10000 && mniRaw.nonZero < 30000, `unexpected MNI tumour voxels: ${mniRaw.nonZero}`);

  const reportJson = JSON.parse(await readFile(join(outDir, 'BEAMSTER_A_038_T1c_report.json'), 'utf8'));
  assert.equal(reportJson.schemaVersion, 1);
  assert.equal(reportJson.tumourType, 'metastasis');
  assert.equal(reportJson.rads.laterality.leftPct, 100);
  const lobeNames = reportJson.rads.cortical.mniLobes.involved.map((item) => item.name);
  assert.ok(lobeNames.includes('frontal_left'), `expected frontal_left in ${lobeNames.join(', ')}`);
  assert.ok(lobeNames.includes('parietal_left'), `expected parietal_left in ${lobeNames.join(', ')}`);
  const lesionsLines = (await readFile(join(outDir, 'BEAMSTER_A_038_T1c_lesions.tsv'), 'utf8')).trim().split('\n');
  assert.equal(lesionsLines.length, 4, 'lesions.tsv must have header + 3 lesion rows');
  const summaryLines = (await readFile(join(outDir, 'BEAMSTER_A_038_T1c_rads_summary.tsv'), 'utf8')).trim().split('\n');
  assert.ok(summaryLines.length >= 10, 'rads_summary.tsv must include summary and MNI rows');
  console.log(
    `PASS beamster-a-038 full pipeline: ${fullSummary.lesionCount} lesions, ${fullSummary.totalVolumeMl.toFixed(3)} mL, ` +
    `brain ${brainRaw.nonZero} vox, tumour ${tumourRaw.nonZero} vox, MNI ${mniRaw.nonZero} vox (left ${reportJson.rads.laterality.leftPct}%)`,
  );

  // 3. Supplied-mask native-only mode (--mask --no-mni --skull-stripped)
  const maskOutDir = join(work, 'beamster-supplied-mask');
  const maskRun = runCliIsolated([
    examplePath,
    maskOutDir,
    '--mask',
    join(outDir, 'BEAMSTER_A_038_T1c_tumour_mask.nii'),
    '--no-mni',
    '--skull-stripped',
    '--tumour-type',
    'metastasis',
    '--offline',
  ]);
  assert.equal(maskRun.status, 0, `supplied-mask run failed:\n${maskRun.stderr}`);
  const maskSummary = JSON.parse(maskRun.stdout.trim());
  assert.equal(maskSummary.provenance.mode, 'supplied-mask');
  assert.equal(maskSummary.lesionCount, fullSummary.lesionCount);
  assert.equal(maskSummary.totalVolumeMl, fullSummary.totalVolumeMl);
  console.log(`PASS supplied-mask mode matches full morphometry (${maskSummary.lesionCount} lesions, ${maskSummary.totalVolumeMl.toFixed(3)} mL)`);
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('PASS @neurodesk/tumour-report portable CLI validation');
