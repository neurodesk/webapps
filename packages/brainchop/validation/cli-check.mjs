#!/usr/bin/env node
// Portable release validation for @neurodesk/brainchop.
// 1. Prefetches the pinned t1-brain example into tmpdir() BEFORE invoking the CLI.
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
  : [process.execPath, fileURLToPath(new URL('../bin/brainchop.js', import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL('../../../apps/brainchop/examples.json', import.meta.url), 'utf8'),
);
const exampleSpec = examples.find((item) => item.id === 't1-brain')?.files?.[0];
assert.ok(exampleSpec, 'Pinned t1-brain example must exist in apps/brainchop/examples.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function probeUnshareNetwork() {
  if (process.platform !== 'linux') return false;
  const check = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
  return !check.error && check.status === 0;
}

const USE_UNSHARE = probeUnshareNetwork();

async function ensureExample(spec) {
  const cacheDir = join(tmpdir(), 'neurodesk-brainchop-validation-cache');
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
    512: [2, (o) => view.getUint16(o, le)],
  };
  const [stride, readOne] = readers[datatype] ?? [];
  assert.ok(stride, `Unexpected NIfTI datatype ${datatype}`);
  assert.ok(voxOffset + total * stride <= bytes.length, 'Truncated NIfTI payload');
  const sclSlope = getF(v2 ? 176 : 112);
  const sclInter = getF(v2 ? 184 : 116);
  const slope = Number.isFinite(sclSlope) && sclSlope !== 0 ? sclSlope : 1;
  const inter = Number.isFinite(sclSlope) && sclSlope !== 0 && Number.isFinite(sclInter) ? sclInter : 0;
  const data = new Float32Array(total);
  for (let i = 0; i < total; i += 1) {
    data[i] = readOne(voxOffset + i * stride) * slope + inter;
    assert.ok(Number.isFinite(data[i]), `Non-finite voxel at ${i}`);
  }
  return { dims, datatype, qformCode, sformCode, sform, data };
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

// Prefetch pinned fixture BEFORE invoking any CLI commands.
const examplePath = await ensureExample(exampleSpec);
const inputRaw = parseRawNifti(await readFile(examplePath));
console.log(
  `network_isolation=${USE_UNSHARE ? 'unshare-rn' : 'flag-only (unshare -rn unavailable)'}`,
);

const work = await mkdtemp(join(tmpdir(), 'brainchop-cli-check-'));
try {
  // 1. Offline self-check
  const selfCheck = runCliIsolated(['self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stderr}`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  assert.equal(selfInfo.ok, true, 'self-check must report ok=true');
  assert.equal(selfInfo.backend, 'cpu');
  assert.equal(selfInfo.corePackage, '@brainchop/core');
  assert.equal(selfInfo.modelsEmbedded, true);
  assert.deepEqual(selfInfo.models, ['mindmap', 'mindmap-fast', 'mindsnap', 'tissue-fractions']);
  console.log(`PASS self-check (v${selfInfo.version}, @brainchop/core ${selfInfo.coreVersion})`);

  // 2. Real T1 brain MRI: mindmap-fast label segmentation
  const labelOutDir = join(work, 'mindmap-fast');
  const labelRun = runCliIsolated([examplePath, labelOutDir, '--model', 'mindmap-fast', '--threads', '4', '--offline']);
  assert.equal(labelRun.status, 0, `mindmap-fast failed:\n${labelRun.stderr}`);
  const labelReport = JSON.parse(labelRun.stdout.trim());
  assert.equal(labelReport.kind, 'labels');
  assert.equal(labelReport.model, 'mindmap-fast');
  assert.equal(labelReport.provenance.backend, 'cpu');
  assert.deepEqual(labelReport.files, ['t1_crop_mindmap-fast.nii']);

  // Independently inspect raw label NIfTI bytes (do not rely on CLI JSON summary alone).
  const labelRaw = parseRawNifti(await readFile(join(labelOutDir, labelReport.files[0])));
  assert.deepEqual(labelRaw.dims, inputRaw.dims);
  assert.equal(labelRaw.qformCode, inputRaw.qformCode, 'label output preserves qform_code');
  assert.equal(labelRaw.sformCode, inputRaw.sformCode, 'label output preserves sform_code');
  if (inputRaw.sformCode > 0) {
    assertSformClose(labelRaw.sform, inputRaw.sform, 'label');
  }
  const distinctLabels = new Set();
  let labelNonZero = 0;
  for (let i = 0; i < labelRaw.data.length; i += 1) {
    const v = labelRaw.data[i];
    assert.ok(Number.isInteger(v) && v >= 0 && v <= 17, `invalid label value ${v} at voxel ${i}`);
    if (v !== 0) {
      labelNonZero += 1;
      distinctLabels.add(v);
    }
  }
  assert.equal(labelNonZero, labelReport.nonZeroVoxels);
  assert.equal(distinctLabels.size, labelReport.uniqueLabels);
  assert.ok(
    distinctLabels.size >= 10 && distinctLabels.size <= 17,
    `expected 10..17 non-zero labels, got ${distinctLabels.size}`,
  );
  const brainFrac = labelNonZero / labelRaw.data.length;
  assert.ok(brainFrac > 0.05 && brainFrac < 0.8, `plausible brain fraction expected (0.05..0.80), got ${brainFrac.toFixed(4)}`);
  console.log(
    `PASS mindmap-fast: dims ${labelRaw.dims.join('x')}, ${distinctLabels.size} classes, ` +
    `${labelNonZero} voxels (${(brainFrac * 100).toFixed(1)}%) in ${labelReport.elapsedMs} ms`,
  );

  // 3. Real T1 brain MRI: GM/WM/CSF tissue fraction maps
  const tissueOutDir = join(work, 'tissue-fractions');
  const tissueRun = runCliIsolated([examplePath, tissueOutDir, '--model', 'tissue-fractions', '--threads', '4', '--offline']);
  assert.equal(tissueRun.status, 0, `tissue-fractions failed:\n${tissueRun.stderr}`);
  const tissueReport = JSON.parse(tissueRun.stdout.trim());
  assert.equal(tissueReport.kind, 'tissues');
  assert.equal(tissueReport.model, 'tissue-fractions');
  assert.deepEqual(tissueReport.files, ['t1_crop_gm.nii', 't1_crop_wm.nii', 't1_crop_csf.nii', 't1_crop_brain.nii']);

  const verifiedCounts = {};
  for (const stage of ['gm', 'wm', 'csf', 'brain']) {
    const file = tissueReport.maps[stage].file;
    const raw = parseRawNifti(await readFile(join(tissueOutDir, file)));
    assert.deepEqual(raw.dims, inputRaw.dims);
    assert.equal(raw.qformCode, inputRaw.qformCode, `${stage} preserves qform_code`);
    assert.equal(raw.sformCode, inputRaw.sformCode, `${stage} preserves sform_code`);
    if (inputRaw.sformCode > 0) {
      assertSformClose(raw.sform, inputRaw.sform, stage);
    }
    let nonZero = 0;
    let min = Infinity;
    let max = -Infinity;
    for (let i = 0; i < raw.data.length; i += 1) {
      const v = raw.data[i];
      if (v < min) min = v;
      if (v > max) max = v;
      if (v > 0) nonZero += 1;
    }
    assert.ok(min >= -1e-4 && max <= 1.001, `${stage} raw values out of [0, 1] range: [${min}, ${max}]`);
    assert.ok(max > 0.5, `${stage} raw max fraction too low: ${max}`);
    assert.ok(nonZero > 10_000, `${stage} raw non-zero voxels too low: ${nonZero}`);
    assert.equal(nonZero, tissueReport.maps[stage].nonZeroVoxels);
    verifiedCounts[stage] = nonZero;
  }
  console.log(
    `PASS tissue-fractions: GM ${verifiedCounts.gm}, WM ${verifiedCounts.wm}, ` +
    `CSF ${verifiedCounts.csf}, brain ${verifiedCounts.brain} voxels in ${tissueReport.elapsedMs} ms`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('PASS @neurodesk/brainchop portable CLI validation');
