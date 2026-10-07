// A SynthSeg label map and its report against a FreeSurfer 8.1.0 golden, with the gates of
// exes/synthseg/tests/parity.rs (./gates.json). Each check is [passed, line].
import { gunzipSync } from 'node:zlib';
import gates from './gates.json' with { type: 'json' };

export { gates };

const QUATERNION_OFFSETS = [76, 256, 260, 264, 268, 272, 276];

/** A NIfTI-1 label map: its 352-byte header, grid and int32 labels. */
export function readLabels(bytes) {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const datatype = view.getInt16(70, true);
  const dims = [1, 2, 3].map((axis) => view.getInt16(40 + 2 * axis, true));
  const affine = [0, 1, 2].map((row) => [0, 1, 2, 3].map((column) => view.getFloat32(280 + 16 * row + 4 * column, true)));
  const offset = view.getFloat32(108, true);
  const data = new Int32Array(dims[0] * dims[1] * dims[2]);
  if (datatype === 8) {
    for (let index = 0; index < data.length; index++) data[index] = view.getInt32(offset + 4 * index, true);
  }
  return { header: raw.subarray(0, 352), view, datatype, dims, affine, data };
}

function counts(data) {
  const result = new Map();
  for (const value of data) result.set(value, (result.get(value) ?? 0) + 1);
  return result;
}

const sameList = (a, b) => a.length === b.length && a.every((value, index) => value === b[index]);

/** The label map against the golden: header, grid, value domain and the mismatched-voxel gate. */
export function compareLabels(name, actualBytes, referenceBytes, maxMismatchFraction, against = 'FreeSurfer') {
  const actual = readLabels(actualBytes);
  const reference = readLabels(referenceBytes);
  const checks = [];
  checks.push([actual.datatype === 8, `${name} labels are int32 (datatype ${actual.datatype})`]);
  checks.push([sameList(actual.dims, reference.dims), `${name} shape ${actual.dims.join('x')} (${against} ${reference.dims.join('x')})`]);
  const affineError = Math.max(...actual.affine.flat().map((value, index) => Math.abs(value - reference.affine.flat()[index])));
  checks.push([affineError <= gates.maxAffineErrorMm, `${name} sform differs by ${affineError} mm <= ${gates.maxAffineErrorMm}`]);
  const codes = sameList([...actual.header.subarray(252, 256)], [...reference.header.subarray(252, 256)]);
  checks.push([codes && actual.header[123] === reference.header[123], `${name} qform/sform codes and xyzt_units match ${against}`]);
  const quaternionError = Math.max(...QUATERNION_OFFSETS.map((offset) => Math.abs(actual.view.getFloat32(offset, true) - reference.view.getFloat32(offset, true))));
  checks.push([quaternionError < gates.maxQuaternionError, `${name} quaternion and qfac differ by ${quaternionError} < ${gates.maxQuaternionError}`]);
  const actualLabels = [...counts(actual.data).keys()].sort((a, b) => a - b);
  const referenceLabels = [...counts(reference.data).keys()].sort((a, b) => a - b);
  checks.push([sameList(actualLabels, referenceLabels), `${name} has ${against}'s ${referenceLabels.length} labels (got ${actualLabels.length}: ${actualLabels.join(' ')})`]);
  let mismatched = 0;
  const total = Math.min(actual.data.length, reference.data.length);
  for (let index = 0; index < total; index++) if (actual.data[index] !== reference.data[index]) mismatched++;
  const fraction = actual.data.length === reference.data.length ? mismatched / total : 1;
  checks.push([fraction <= maxMismatchFraction, `${name} ${mismatched} of ${total} voxels differ from ${against} (${fraction.toExponential(2)}) <= ${maxMismatchFraction}`]);
  return { checks, mismatched, reference };
}

/** The report's label volumes against the golden's, which differ by no more than the mismatched voxels. */
export function compareVolumes(name, report, { reference, mismatched }) {
  const [a, b, c] = reference.affine;
  const determinant = Math.abs(a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]));
  const voxelVolumeMl = determinant / 1000;
  const measured = report.measurements;
  const checks = [];
  const unitError = Math.abs(measured.voxelVolumeMl - voxelVolumeMl) / voxelVolumeMl;
  checks.push([unitError <= 1e-6, `${name} report voxel volume ${measured.voxelVolumeMl} ml (FreeSurfer grid ${voxelVolumeMl} ml)`]);
  const golden = counts(reference.data);
  checks.push([measured.labels.length === golden.size, `${name} report lists ${measured.labels.length} labels (FreeSurfer ${golden.size})`]);
  let largestError = 0;
  let brainMl = 0;
  let goldenBrainMl = 0;
  for (const [id, voxels] of golden) {
    const row = measured.labels.find((label) => label.id === id) ?? { voxels: 0, volumeMl: 0 };
    largestError = Math.max(largestError, Math.abs(row.volumeMl - voxels * voxelVolumeMl));
    if (id !== 0) {
      brainMl += row.volumeMl;
      goldenBrainMl += voxels * voxelVolumeMl;
    }
  }
  const allowedMl = (mismatched + 1e-6) * voxelVolumeMl;
  checks.push([largestError <= allowedMl, `${name} report label volumes differ from FreeSurfer's by at most ${largestError.toFixed(4)} ml <= ${mismatched} voxels`]);
  checks.push([Math.abs(brainMl - goldenBrainMl) <= allowedMl, `${name} labelled volume ${brainMl.toFixed(3)} ml (FreeSurfer ${goldenBrainMl.toFixed(3)} ml)`]);
  return checks;
}
