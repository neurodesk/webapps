// The pinned example, the web app's recorded downloads and the comparison both release checks
// apply: validation/cli-check.mjs for the command line and apps/ants/e2e/reference.spec.js for
// the web app. t1-mni-reference.json holds what the built web app downloaded (browser).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseNiftiHeader, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';
import { ARTIFACTS } from '../src/outputs.js';

export const REFERENCE = new URL('./t1-mni-reference.json', import.meta.url);
// examples.json pins the dataset revision but not file checksums, so the checks pin the bytes.
export const EXAMPLE_SHA256 = Object.freeze({
  't1_brain.nii.gz': '553e242f330381aa7a5bdac5db27e971d9ee8001e63375d3b01fb00ec0e31bff',
  'MNI152_T1_1mm_brain.nii.gz': '32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212',
});
export const ROLES = Object.freeze(Object.keys(ARTIFACTS));
// The voxel and byte hashes are the gates: the kernel is single-threaded WebAssembly with a fixed
// seed, so the web app and the command line write identical bytes. These limits report how far a
// differing output is. Each is about a tenth of the smallest shift a different seed (43 instead of
// 42) caused in that statistic on the pinned example: registered std 1.1e-5 relative, correlation
// 1.2e-3, largest affine parameter 7.9e-2. A 1.01 voxel scale exceeds the intensity limit 10^4-fold.
export const TOLERANCES = Object.freeze({
  // Mean and standard deviation of every voxel value, relative to the reference.
  intensity: 0.000001,
  // Pearson correlation of the registered and fixed images over the fixed brain, absolute.
  fixedCorrelation: 0.0001,
  // Every affine parameter and centre coordinate, absolute.
  affine: 0.001,
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

// Downloads (once) and verifies the example named in apps/ants/examples.json.
export async function pinnedExample() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/ants/examples.json', import.meta.url), 'utf8'));
  const [example] = examples;
  const [moving, fixed] = await Promise.all(example.files.map(pinnedFile));
  return { id: example.id, moving, fixed };
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-ants-validation', revision, file.name);
  const expected = EXAMPLE_SHA256[file.name];
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return { name: file.name, path };
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return { name: file.name, path };
}

const floats = (bytes, offset, count) => Array.from({ length: count }, (_, i) => bytes.readFloatLE(offset + 4 * i));

// The header fields that place voxels in space, exactly as stored.
function readVolume(compressed) {
  const bytes = gunzipSync(compressed);
  const header = parseNiftiHeader(bytes);
  const { data } = readNiftiFrames(bytes, Float64Array);
  const offset = Math.ceil(header.voxOffset);
  return {
    geometry: {
      dims: header.dims.slice(0, header.dims[0] + 1),
      pixdim: header.pixDims.slice(1, 4),
      qformCode: bytes.readInt16LE(252),
      sformCode: bytes.readInt16LE(254),
      quatern: floats(bytes, 256, 6),
      srow: floats(bytes, 280, 12),
    },
    datatype: header.datatype,
    data,
    voxelSha256: sha256(bytes.subarray(offset, offset + (data.length * header.bitpix) / 8)),
    bytes,
  };
}

function moments(data) {
  let sum = 0;
  for (const value of data) sum += value;
  const mean = sum / data.length;
  let squares = 0;
  for (const value of data) squares += (value - mean) ** 2;
  return { mean, std: Math.sqrt(squares / data.length) };
}

function correlation(a, b) {
  let count = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (b[i] <= 0) continue;
    count += 1;
    sumA += a[i];
    sumB += b[i];
  }
  const meanA = sumA / count;
  const meanB = sumB / count;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (b[i] <= 0) continue;
    covariance += (a[i] - meanA) * (b[i] - meanB);
    varianceA += (a[i] - meanA) ** 2;
    varianceB += (b[i] - meanB) ** 2;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

// ITK writes a .mat transform as MATLAB level 4 matrices: the parameters, then the fixed centre.
export function readAffine(bytes) {
  const matrices = {};
  let offset = 0;
  while (offset < bytes.length) {
    const [type, rows, columns, imaginary, nameLength] = [0, 1, 2, 3, 4].map((i) => bytes.readInt32LE(offset + 4 * i));
    if (type > 99 || imaginary !== 0) throw new Error(`unsupported MATLAB matrix type ${type}`);
    const precision = Math.floor(type / 10) % 10;
    const size = { 0: 8, 1: 4 }[precision];
    if (!size) throw new Error(`unsupported MATLAB precision ${precision}`);
    const name = bytes.toString('latin1', offset + 20, offset + 20 + nameLength - 1);
    const start = offset + 20 + nameLength;
    const count = rows * columns;
    matrices[name] = Array.from({ length: count }, (_, i) => (size === 8 ? bytes.readDoubleLE(start + 8 * i) : bytes.readFloatLE(start + 4 * i)));
    offset = start + count * size;
  }
  const parameters = Object.entries(matrices).find(([name]) => name.startsWith('AffineTransform_'));
  if (!parameters || !matrices.fixed) throw new Error('not an ITK affine transform');
  return { transform: parameters[0], parameters: parameters[1], fixed: matrices.fixed };
}

// What the checks compare about the four downloads, keyed by artifact role. `files` maps each
// role to its bytes; `fixed` is the fixed image as given. ITK rewrites the qform and sform codes,
// so whether an output lies on the fixed grid is decided by where its corner voxels fall
// (onFixedGrid), and its stored header is compared with the reference's.
export function summarize(files, fixed) {
  const fixedVolume = readVolume(fixed);
  const summary = {};
  for (const role of ['registered', 'warp', 'inverse-warp']) {
    const { data, bytes, ...volume } = readVolume(files[role]);
    summary[role] = { geometry: volume.geometry, onFixedGrid: sameNiftiGrid(bytes, fixedVolume.bytes), datatype: volume.datatype, voxelSha256: volume.voxelSha256, ...moments(data) };
    if (role === 'registered') summary[role].fixedCorrelation = correlation(data, fixedVolume.data);
  }
  summary.affine = { sha256: sha256(files.affine), ...readAffine(files.affine) };
  return summary;
}

const relative = (actual, expected) => Math.abs(actual - expected) / Math.abs(expected);

// Returns [passed, line] pairs. `expected` is the reference entry's artifacts.
export function compare(label, actual, expected, source) {
  const checks = [];
  for (const role of ['registered', 'warp', 'inverse-warp']) {
    const [is, was] = [actual[role], expected[role]];
    checks.push([
      is.onFixedGrid,
      `${label} ${role} lies on the fixed image's grid within 0.001 mm (dims ${is.geometry.dims.slice(1).join('x')})`,
    ]);
    checks.push([
      JSON.stringify(is.geometry) === JSON.stringify(was.geometry) && is.datatype === was.datatype,
      `${label} ${role} header geometry and datatype ${is.datatype} equal the ${source} reference's`,
    ]);
    checks.push([
      is.voxelSha256 === was.voxelSha256,
      `${label} ${role} voxels ${is.voxelSha256.slice(0, 12)} identical to the ${source} reference's ${was.voxelSha256.slice(0, 12)}`,
    ]);
    for (const name of ['mean', 'std']) {
      const difference = relative(is[name], was[name]);
      checks.push([
        difference <= TOLERANCES.intensity,
        `${label} ${role} voxel ${name} ${is[name].toPrecision(6)} vs ${source} ${was[name].toPrecision(6)}, relative diff ${difference.toExponential(1)} <= ${TOLERANCES.intensity}`,
      ]);
    }
  }
  const difference = Math.abs(actual.registered.fixedCorrelation - expected.registered.fixedCorrelation);
  checks.push([
    difference <= TOLERANCES.fixedCorrelation,
    `${label} registered correlation with the fixed brain ${actual.registered.fixedCorrelation.toFixed(6)} vs ${source} ${expected.registered.fixedCorrelation.toFixed(6)}, |diff| ${difference.toExponential(1)} <= ${TOLERANCES.fixedCorrelation}`,
  ]);
  const [is, was] = [actual.affine, expected.affine];
  checks.push([
    is.sha256 === was.sha256,
    `${label} affine bytes ${is.sha256.slice(0, 12)} identical to the ${source} reference's ${was.sha256.slice(0, 12)} (${is.transform})`,
  ]);
  const values = [...is.parameters, ...is.fixed];
  const reference = [...was.parameters, ...was.fixed];
  const largest = values.length === reference.length ? Math.max(...values.map((value, i) => Math.abs(value - reference[i]))) : Infinity;
  checks.push([
    largest <= TOLERANCES.affine,
    `${label} affine parameters and centre within ${TOLERANCES.affine} of the ${source} reference's, largest |diff| ${largest.toExponential(1)}`,
  ]);
  return checks;
}
