#!/usr/bin/env node
// Portable release validation for @neurodesk/brainchomp.
// 1. Prefetches the pinned rodent-mri example into tmpdir() BEFORE invoking the CLI.
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
  : [process.execPath, fileURLToPath(new URL('../bin/brainchomp.js', import.meta.url))];

const examples = JSON.parse(
  await readFile(new URL('../../../apps/brainchomp/examples.json', import.meta.url), 'utf8'),
);
const exampleSpec = examples.find((item) => item.id === 'rodent-mri')?.files?.[0];
assert.ok(exampleSpec, 'Pinned rodent-mri example must exist in apps/brainchomp/examples.json');

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function probeUnshareNetwork() {
  if (process.platform !== 'linux') return false;
  const check = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
  return !check.error && check.status === 0;
}

const USE_UNSHARE = probeUnshareNetwork();

async function ensureExample(spec) {
  const cacheDir = join(tmpdir(), 'neurodesk-brainchomp-validation-cache');
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

const work = await mkdtemp(join(tmpdir(), 'brainchomp-cli-check-'));
try {
  // 1. Offline self-check
  const selfCheck = runCliIsolated(['self-check']);
  assert.equal(selfCheck.status, 0, `self-check failed: ${selfCheck.stderr}`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  assert.equal(selfInfo.ok, true, 'self-check must report ok=true');
  assert.equal(selfInfo.backend, 'cpu');
  assert.equal(selfInfo.modelsEmbedded, true);
  console.log(`PASS self-check (v${selfInfo.version}, library ${selfInfo.libraryRevision.slice(0, 8)})`);

  // 2. Real rodent MRI extraction
  const outDir = join(work, 'rodent-out');
  const run = runCliIsolated([examplePath, outDir, '--threads', '4', '--offline']);
  assert.equal(run.status, 0, `brainchomp extraction failed:\n${run.stderr}`);
  const report = JSON.parse(run.stdout.trim());
  assert.equal(report.provenance.backend, 'cpu');
  assert.equal(report.provenance.openingRadius, 4);
  assert.deepEqual(report.files, [
    'MA_F_15M_20_image_brainchomp_brain.nii',
    'MA_F_15M_20_image_brainchomp_mask.nii',
  ]);

  const brainRaw = parseRawNifti(await readFile(join(outDir, report.files[0])));
  const maskRaw = parseRawNifti(await readFile(join(outDir, report.files[1])));

  assert.deepEqual(brainRaw.dims, inputRaw.dims);
  assert.deepEqual(maskRaw.dims, inputRaw.dims);
  assert.equal(brainRaw.qformCode, inputRaw.qformCode, 'brain preserves qform_code');
  assert.equal(brainRaw.sformCode, inputRaw.sformCode, 'brain preserves sform_code');
  assert.equal(maskRaw.qformCode, inputRaw.qformCode, 'mask preserves qform_code');
  assert.equal(maskRaw.sformCode, inputRaw.sformCode, 'mask preserves sform_code');
  if (inputRaw.sformCode > 0) {
    assertSformClose(brainRaw.sform, inputRaw.sform, 'brain');
    assertSformClose(maskRaw.sform, inputRaw.sform, 'mask');
  }

  let maskCount = 0;
  let outsideNonZero = 0;
  let insideNonZero = 0;
  let insideMismatch = 0;
  for (let i = 0; i < maskRaw.data.length; i += 1) {
    const m = maskRaw.data[i];
    assert.ok(m === 0 || m === 1, `non-binary mask value ${m} at voxel ${i}`);
    if (m === 1) {
      maskCount += 1;
      if (brainRaw.data[i] !== 0) insideNonZero += 1;
      if (Math.abs(brainRaw.data[i] - inputRaw.data[i]) > 1e-4) insideMismatch += 1;
    } else if (brainRaw.data[i] !== 0) {
      outsideNonZero += 1;
    }
  }
  assert.equal(maskCount, report.maskVoxels);
  assert.equal(outsideNonZero, 0, 'brain output must be zero outside the brain mask');
  assert.equal(insideMismatch, 0, 'brain output must preserve input intensities inside mask');
  assert.ok(insideNonZero > 100_000, `brain has too few non-zero voxels: ${insideNonZero}`);
  const fraction = maskCount / maskRaw.data.length;
  assert.ok(
    fraction > 0.02 && fraction < 0.75,
    `plausible rodent brain mask fraction expected (0.02..0.75), got ${fraction.toFixed(4)} (${maskCount} voxels)`,
  );
  console.log(
    `PASS rodent-mri extraction: dims ${brainRaw.dims.join('x')}, ${maskCount} mask voxels ` +
    `(${(fraction * 100).toFixed(1)}%, ${report.brainVolumeMm3.toFixed(1)} mm^3) in ${report.elapsedMs} ms`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

console.log('PASS @neurodesk/brainchomp portable CLI validation');
