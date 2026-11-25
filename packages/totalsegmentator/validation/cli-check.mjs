#!/usr/bin/env node
// Verifies a totalsegmentator command line on pinned CT (RAS) and MRI (LPS) examples:
// single-model fast CT & MRI, multi-part full-resolution MRI merging, and 2-stage body-cropped CT abdominal muscles.
// Prefetches fixtures first, runs every CLI invocation offline against bundled models (with isolated HOME untouched),
// and checks NIfTI headers directly via DataView independently of the package reader.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { fetchBytesWithRetry } from '@neurodesk/webapp-components/fetch';
import { modelById } from '../src/models.js';

const examples = JSON.parse(await readFile(new URL('../../../apps/totalsegmentator/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const { values } = parseArgs({ options: { executable: { type: 'string' } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL('../bin/totalsegmentator.js', import.meta.url))];

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? 'PASS' : 'FAIL'} ${line}`);
}

async function pinnedExample(exampleId) {
  const example = examples.find((item) => item.id === exampleId);
  if (!example) throw new Error(`Missing example ${exampleId} in apps/totalsegmentator/examples.json`);
  const [file] = example.files;
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(tmpdir(), 'neurodesk-totalsegmentator-validation', pin.sha256, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === pin.sha256) return path;
  const bytes = Buffer.from(await fetchBytesWithRetry(file.url, { signal: AbortSignal.timeout(600_000) }, { retryTransient: true, retries: 3 }));
  if (sha256(bytes) !== pin.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

// Independent raw NIfTI-1 DataView parser (does not import packages/totalsegmentator/src/nifti.js or synthsr).
function inspectRawNifti1(buf) {
  const raw = buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf) : buf;
  const v = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const le = v.getInt32(0, true) === 348;
  if (!le && v.getInt32(0, false) !== 348) throw new Error('Expected NIfTI-1 header (sizeof_hdr=348)');
  const dims = [1, 2, 3].map((i) => v.getInt16(40 + i * 2, le));
  const datatype = v.getInt16(70, le);
  const pixdim = [0, 1, 2, 3].map((i) => v.getFloat32(76 + i * 4, le));
  const voxOffset = Math.max(352, Math.trunc(v.getFloat32(108, le)));
  const sclSlope = v.getFloat32(112, le);
  const sclInter = v.getFloat32(116, le);
  const xyztUnits = v.getUint8(123);
  const qformCode = v.getInt16(252, le);
  const sformCode = v.getInt16(254, le);
  const quatern = [0, 1, 2].map((i) => v.getFloat32(256 + i * 4, le));
  const qoffset = [0, 1, 2].map((i) => v.getFloat32(268 + i * 4, le));
  const srow = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => v.getFloat32(280 + (r * 4 + c) * 4, le)));
  return { raw, dims, datatype, pixdim, voxOffset, sclSlope, sclInter, xyztUnits, qformCode, sformCode, quatern, qoffset, srow };
}

function arrayClose(a, b, tol = 1e-4) {
  return a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) <= tol);
}

function canUseNetworkNamespace() {
  if (process.platform !== 'linux') return false;
  const probe = spawnSync('unshare', ['-rn', 'true'], { stdio: 'ignore' });
  return !probe.error && probe.status === 0;
}

const isolateNetwork = canUseNetworkNamespace();

async function runCase({
  label,
  input,
  output,
  args,
  expectedModelIds,
  expectedFiles,
  minStructures,
  meanColumn,
  checkStructure,
  requiredGroups = [],
}) {
  const cliArgs = [...command.slice(1), input, output, ...args, '--offline'];
  const runner = isolateNetwork ? ['unshare', '-rn', command[0], ...cliArgs] : [command[0], ...cliArgs];
  const run = spawnSync(
    runner[0],
    runner.slice(1),
    { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
  );
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${runner.join(' ')} exited with ${run.status}:\n${run.stderr}`);
  const report = JSON.parse(run.stdout);
  console.log(`INFO ${label} (${args.join(' ')}, offline${isolateNetwork ? ', network-isolated' : ', unshare unavailable'})`);
  check(
    report.provenance.executionProvider === 'cpu',
    `${label}: executionProvider ${report.provenance.executionProvider}, ${report.provenance.threads} threads, ONNX Runtime ${report.provenance.onnxruntime}, ${report.provenance.seconds} s`,
  );
  const expectedShas = expectedModelIds.map((id) => modelById(id).sha256);
  const actualShas = report.provenance.models.map((m) => m.sha256);
  check(
    JSON.stringify(actualShas) === JSON.stringify(expectedShas),
    `${label}: models ${report.provenance.models.map(({ file }) => file).join(', ')} match pins`,
  );
  const outFiles = (await readdir(output)).sort();
  check(JSON.stringify(outFiles) === JSON.stringify([...expectedFiles].sort()), `${label}: outputs ${outFiles.join(', ')}`);

  const src = inspectRawNifti1(await readFile(input));
  const seg = inspectRawNifti1(await readFile(join(output, expectedFiles[0])));
  check(seg.datatype === 2, `${label}: segmentation NIfTI datatype is uint8 (2)`);
  check(JSON.stringify(seg.dims) === JSON.stringify(src.dims), `${label}: dims ${seg.dims.join('x')} match input`);
  const transformsMatch = seg.qformCode === src.qformCode
    && seg.sformCode === src.sformCode
    && seg.xyztUnits === src.xyztUnits
    && arrayClose(seg.pixdim, src.pixdim)
    && arrayClose(seg.quatern, src.quatern)
    && arrayClose(seg.qoffset, src.qoffset)
    && arrayClose(seg.srow.flat(), src.srow.flat());
  check(transformsMatch, `${label}: qform (code ${seg.qformCode}) and sform (code ${seg.sformCode}) match source scan`);

  const uniqueLabels = new Set(seg.raw.subarray(seg.voxOffset));
  const detected = uniqueLabels.size - (uniqueLabels.has(0) ? 1 : 0);
  check(detected >= minStructures, `${label}: detected ${detected} structures >= ${minStructures}`);

  const tsv = await readFile(join(output, expectedFiles[1]), 'utf8');
  const rows = tsv.trim().split('\n').map((line) => line.split('\t'));
  const headers = rows[0] || [];
  const volumeIdx = headers.indexOf('volume_ml');
  const groupIdx = headers.indexOf('group');
  check(headers.includes(meanColumn) && volumeIdx >= 0, `${label}: TSV includes ${meanColumn} and volume_ml columns`);
  if (checkStructure) {
    const row = rows.find((cols) => cols[1] === checkStructure.slug);
    const ml = row && volumeIdx >= 0 ? Number(row[volumeIdx]) : 0;
    check(
      Number.isFinite(ml) && ml >= checkStructure.minMl && ml <= checkStructure.maxMl,
      `${label}: ${checkStructure.slug} detected (${ml.toFixed(1)} mL, expected ${checkStructure.minMl}-${checkStructure.maxMl} mL)`,
    );
  }
  for (const group of requiredGroups) {
    const count = rows.slice(1).filter((cols) => cols[groupIdx] === group && Number(cols[volumeIdx]) > 0).length;
    check(count > 0, `${label}: model group "${group}" contributed ${count} structure(s)`);
  }
}

// Crops a central trunk subvolume from the pinned CT scan and stamps distinct qform_code=2
// and sform_code=1 transforms so the cropped body-model run finishes quickly on CI runners
// while also proving end-to-end NiBabel sform-over-qform selection and dual-transform preservation.
function buildCroppedDualTransformCt(srcBuf) {
  const src = inspectRawNifti1(srcBuf);
  const [nx, ny, nz] = src.dims;
  const cx = Math.min(56, nx);
  const cy = Math.min(56, ny);
  const cz = Math.min(20, nz);
  const ox = Math.floor((nx - cx) / 2);
  const oy = Math.floor((ny - cy) / 2);
  const oz = Math.floor((nz - cz) / 2);
  const srcView = new DataView(src.raw.buffer, src.raw.byteOffset + src.voxOffset);
  const outBuf = Buffer.alloc(352 + cx * cy * cz * 4);
  const v = new DataView(outBuf.buffer, outBuf.byteOffset, outBuf.byteLength);
  v.setInt32(0, 348, true);
  v.setInt16(40, 3, true);
  v.setInt16(42, cx, true);
  v.setInt16(44, cy, true);
  v.setInt16(46, cz, true);
  for (let i = 3; i < 7; i++) v.setInt16(42 + i * 2, 1, true);
  v.setInt16(70, 16, true);
  v.setInt16(72, 32, true);
  for (let i = 0; i < 4; i++) v.setFloat32(76 + i * 4, src.pixdim[i], true);
  v.setFloat32(108, 352, true);
  v.setFloat32(112, 1, true);
  v.setUint8(123, src.xyztUnits);
  // Stamp qform_code=2 with a conflicting 180-deg Y flip (quatern_c=1) alongside sform_code=1
  // (true shifted CT srow) so inference must pick sform over qform to segment upright trunk anatomy.
  v.setInt16(252, 2, true);
  v.setInt16(254, 1, true);
  v.setFloat32(256, 0, true);
  v.setFloat32(260, 1, true);
  v.setFloat32(264, 0, true);
  v.setFloat32(268, 11, true);
  v.setFloat32(272, 22, true);
  v.setFloat32(276, 33, true);
  for (let r = 0; r < 3; r++) {
    const shifted = src.srow[r][3] + src.srow[r][0] * ox + src.srow[r][1] * oy + src.srow[r][2] * oz;
    for (let c = 0; c < 3; c++) v.setFloat32(280 + (r * 4 + c) * 4, src.srow[r][c], true);
    v.setFloat32(280 + (r * 4 + 3) * 4, shifted, true);
  }
  outBuf.set([110, 43, 49, 0], 344);
  const le = new DataView(src.raw.buffer, src.raw.byteOffset).getInt32(0, true) === 348;
  const slope = Number.isFinite(src.sclSlope) && src.sclSlope !== 0 ? src.sclSlope : 1;
  const inter = Number.isFinite(src.sclSlope) && src.sclSlope !== 0 && Number.isFinite(src.sclInter) ? src.sclInter : 0;
  const readVoxel = (idx) => {
    let rawVal;
    if (src.datatype === 4) rawVal = srcView.getInt16(idx * 2, le);
    else if (src.datatype === 16) rawVal = srcView.getFloat32(idx * 4, le);
    else if (src.datatype === 2) rawVal = srcView.getUint8(idx);
    else throw new Error(`Unexpected fixture datatype ${src.datatype}`);
    return rawVal * slope + inter;
  };
  let dst = 0;
  for (let z = 0; z < cz; z++) {
    for (let y = 0; y < cy; y++) {
      for (let x = 0; x < cx; x++) {
        const srcIdx = (ox + x) + nx * ((oy + y) + ny * (oz + z));
        v.setFloat32(352 + dst * 4, readVoxel(srcIdx), true);
        dst++;
      }
    }
  }
  return outBuf;
}

// Prefetch all pinned fixtures before running any offline CLI check.
const ctInput = await pinnedExample('ct-abdomen');
const mrInput = await pinnedExample('mr-abdomen');

const work = await mkdtemp(join(tmpdir(), 'totalseg-cli-check-'));
try {
  const croppedCt = join(work, 'ct_trunk_crop.nii');
  await writeFile(croppedCt, buildCroppedDualTransformCt(await readFile(ctInput)));

  await runCase({
    label: 'CT fast 3mm',
    input: ctInput,
    output: join(work, 'ct-fast'),
    args: ['--task', 'total', '--resolution', 'fast'],
    expectedModelIds: ['total-ct-3mm'],
    expectedFiles: ['example_ct_sm_totalseg_total.nii.gz', 'example_ct_sm_totalseg_total_stats.tsv'],
    minStructures: 35,
    meanColumn: 'mean_hu',
    checkStructure: { slug: 'liver', minMl: 400, maxMl: 4000 },
  });

  await runCase({
    label: 'MRI fast 3mm (LPS)',
    input: mrInput,
    output: join(work, 'mr-fast'),
    args: ['--task', 'total_mr', '--resolution', 'fast'],
    expectedModelIds: ['total-mr-3mm'],
    expectedFiles: ['example_mr_sm_totalseg_total_mr.nii.gz', 'example_mr_sm_totalseg_total_mr_stats.tsv'],
    minStructures: 20,
    meanColumn: 'mean_intensity',
    checkStructure: { slug: 'liver', minMl: 400, maxMl: 4000 },
  });

  await runCase({
    label: 'MRI full 1.5mm multi-part (LPS)',
    input: mrInput,
    output: join(work, 'mr-full'),
    args: ['--task', 'total_mr', '--resolution', 'full'],
    expectedModelIds: ['total-mr-organs', 'total-mr-muscles'],
    expectedFiles: ['example_mr_sm_totalseg_total_mr.nii.gz', 'example_mr_sm_totalseg_total_mr_stats.tsv'],
    minStructures: 20,
    meanColumn: 'mean_intensity',
    checkStructure: { slug: 'liver', minMl: 400, maxMl: 4000 },
    requiredGroups: ['organs', 'muscles'],
  });

  await runCase({
    label: 'CT abdominal muscles (body-cropped, dual qform/sform)',
    input: croppedCt,
    output: join(work, 'ct-abdo'),
    args: ['--task', 'abdominal_muscles'],
    expectedModelIds: ['body-ct-6mm', 'abdominal-muscles-ct'],
    expectedFiles: ['ct_trunk_crop_totalseg_abdominal_muscles.nii.gz', 'ct_trunk_crop_totalseg_abdominal_muscles_stats.tsv'],
    minStructures: 8,
    meanColumn: 'mean_hu',
  });
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL ${failures.length} check(s) failed`);
  process.exit(1);
}
console.log('PASS TotalSegmentator command line verified on CT, MRI, multi-part, and cropped tasks');
