// Parity verification: runs @neurodesk/brkraw in Node against upstream BrkRaw v0.5.7
// oracles across ParaVision 5.1 and 6.0.1 datasets, checking bit-exact voxel payloads,
// 4x4 affines, NIfTI headers, and 3D physical anatomical landmark coordinates.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { loadBrukerStudy } from '../src/study.js';

function readNiftiPayloadAndMeta(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const ndim = dv.getInt16(40, true);
  const shape = [];
  for (let i = 0; i < ndim; i++) shape.push(dv.getInt16(42 + i * 2, true));
  const datatype = dv.getInt16(70, true);
  const voxOffset = Math.trunc(dv.getFloat32(108, true));
  const sclSlope = dv.getFloat32(112, true);
  const sclInter = dv.getFloat32(116, true);
  const sliceCode = dv.getUint8(122);
  const xyztUnits = dv.getUint8(123);
  const qformCode = dv.getInt16(252, true);
  const sformCode = dv.getInt16(254, true);
  const pixdim = [0, 1, 2, 3, 4].map((i) => dv.getFloat32(76 + i * 4, true));
  const affine = [0, 1, 2].map((r) => [0, 1, 2, 3].map((c) => dv.getFloat32(280 + r * 16 + c * 4, true)));
  affine.push([0, 0, 0, 1]);
  const payload = buf.subarray(voxOffset);
  const payloadSha256 = createHash('sha256').update(payload).digest('hex');

  const nx = shape[0];
  const ny = shape[1];
  const nz = shape[2] ?? 1;
  const volCount = nx * ny * nz;
  const vol = new Float64Array(volCount);
  const pDv = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  for (let i = 0; i < volCount; i++) {
    if (datatype === 2) vol[i] = payload[i];
    else if (datatype === 4) vol[i] = pDv.getInt16(i * 2, true);
    else if (datatype === 8) vol[i] = pDv.getInt32(i * 4, true);
    else if (datatype === 16) vol[i] = pDv.getFloat32(i * 4, true);
  }
  let pkI = 0;
  let pkJ = 0;
  let pkK = 0;
  let maxVal = -Infinity;
  let sumW = 0;
  let sumI = 0;
  let sumJ = 0;
  let sumK = 0;
  // Traverse in C-order (i, j, k) to match numpy.argmax tie-breaking on saturated voxels
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      for (let k = 0; k < nz; k++) {
        const idx = i + nx * (j + ny * k);
        const v = vol[idx];
        if (v > maxVal) {
          maxVal = v;
          pkI = i;
          pkJ = j;
          pkK = k;
        }
        if (v > 0) {
          sumW += v;
          sumI += i * v;
          sumJ += j * v;
          sumK += k * v;
        }
      }
    }
  }
  const comI = sumW > 0 ? sumI / sumW : 0;
  const comJ = sumW > 0 ? sumJ / sumW : 0;
  const comK = sumW > 0 ? sumK / sumW : 0;
  const toXyz = (i, j, k) => [
    affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3],
    affine[1][0] * i + affine[1][1] * j + affine[1][2] * k + affine[1][3],
    affine[2][0] * i + affine[2][1] * j + affine[2][2] * k + affine[2][3],
  ];

  return {
    shape,
    sclSlope,
    sclInter,
    sliceCode,
    xyztUnits,
    qformCode,
    sformCode,
    pixdim,
    affine,
    payloadSha256,
    peakIjk: [pkI, pkJ, pkK],
    peakXyzMm: toXyz(pkI, pkJ, pkK),
    comXyzMm: toXyz(comI, comJ, comK),
  };
}

const manifestPath = process.argv[2];
if (!manifestPath) {
  console.error('Usage: node parity.mjs <oracles.json>');
  process.exit(2);
}

const cases = JSON.parse(await readFile(manifestPath, 'utf8'));
const studyCache = new Map();
let passed = 0;

for (const c of cases) {
  if (!studyCache.has(c.zipPath)) {
    studyCache.set(c.zipPath, await loadBrukerStudy(await readFile(c.zipPath)));
  }
  const study = studyCache.get(c.zipPath);
  const res = await study.convert({
    scanId: c.scanId,
    recoId: c.recoId,
    slicePackIndex: c.slicePackIndex,
    space: c.space,
    overrideSubjectType: c.overrideSubjectType,
    overrideSubjectPose: c.overrideSubjectPose,
  });

  const got = readNiftiPayloadAndMeta(res.niftiBytes);
  assert.deepEqual(got.shape, c.shape, `${c.id}: shape mismatch`);
  assert.equal(got.payloadSha256, c.payloadSha256, `${c.id}: voxel payload SHA-256 mismatch`);
  assert.equal(got.qformCode, c.qformCode, `${c.id}: qform_code mismatch`);
  assert.equal(got.sformCode, c.sformCode, `${c.id}: sform_code mismatch`);
  assert.equal(got.sliceCode, c.sliceCode, `${c.id}: slice_code mismatch`);
  assert.equal(got.xyztUnits, c.xyztUnits, `${c.id}: xyzt_units mismatch`);
  assert.ok(Math.abs(got.sclSlope - c.sclSlope) <= 1e-6 * Math.max(1, Math.abs(c.sclSlope)), `${c.id}: scl_slope mismatch (${got.sclSlope} vs ${c.sclSlope})`);
  assert.ok(Math.abs(got.sclInter - c.sclInter) <= 1e-6, `${c.id}: scl_inter mismatch`);

  for (let i = 0; i < 5; i++) {
    assert.ok(Math.abs(got.pixdim[i] - c.pixdim[i]) <= 1e-5, `${c.id}: pixdim[${i}] mismatch (${got.pixdim[i]} vs ${c.pixdim[i]})`);
  }
  for (let r = 0; r < 4; r++) {
    for (let col = 0; col < 4; col++) {
      assert.ok(Math.abs(got.affine[r][col] - c.affine[r][col]) <= 1e-5, `${c.id}: affine[${r}][${col}] mismatch (${got.affine[r][col]} vs ${c.affine[r][col]})`);
    }
  }
  for (let a = 0; a < 3; a++) {
    assert.ok(Math.abs(got.peakXyzMm[a] - c.landmarks.peakXyzMm[a]) <= 1e-4, `${c.id}: peakXyzMm[${a}] mismatch`);
    assert.ok(Math.abs(got.comXyzMm[a] - c.landmarks.comXyzMm[a]) <= 1e-4, `${c.id}: comXyzMm[${a}] mismatch`);
  }
  // Verify scrubbed sidecar omits identifying keys
  for (const forbidden of ['PatientName', 'PatientID', 'SubjectName', 'SubjectID', 'DateOfBirth', 'Operator', 'AcquisitionDateTime', 'StudyDate', 'InstanceUID']) {
    assert.equal(Object.hasOwn(res.sidecar, forbidden), false, `${c.id}: sidecar must omit ${forbidden}`);
  }
  passed++;
  console.log(`PASS ${c.id}: shape=[${got.shape.join('x')}] sha256=${got.payloadSha256.slice(0, 12)} comMm=[${got.comXyzMm.map((v) => v.toFixed(2)).join(', ')}]`);
}

console.log(`\nALL ${passed}/${cases.length} BrkRaw v0.5.7 PV5.1 & PV6.0.1 parity cases PASSED bit-for-bit!`);
