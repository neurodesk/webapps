// The pinned example, its recorded outputs and the comparison both release checks apply:
// validation/cli-check.mjs for the command line and apps/fireants/e2e/reference.spec.js for the
// web app. t1-mni-reference.json holds, per preset, the web app's own output (browser) and the
// engine's in-process output (inProcess).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const REFERENCE = new URL('./t1-mni-reference.json', import.meta.url);
export const TRANSFORMS = Object.freeze(['greedy', 'syn']);
// Every recorded and checked run uses this many threads. The threaded engine splits its sums by
// thread, so another count changes the float rounding and the voxels.
export const THREADS = 4;
// examples.json pins the dataset revision but not file checksums (the app's browser tests serve a
// fixture in their place), so the checks pin the bytes they validate on.
export const EXAMPLE_SHA256 = Object.freeze({
  't1_brain.nii.gz': '553e242f330381aa7a5bdac5db27e971d9ee8001e63375d3b01fb00ec0e31bff',
  'MNI152_T1_1mm_brain.nii.gz': '32d5be33460f995a5d305507053c8862c823d9ca6bfb543381308df14590f212',
});
// Every gate above the voxel hash reports how far a differing output is from the reference. On
// Linux x64, 8 threads instead of 4 moved the Greedy output's mean by 1.5e-6 (relative), its std
// by 7.6e-7 and its correlation with the fixed brain by 1.6e-6, and left the NCC at -0.8586.
// The limits are about 60 times those shifts; scaling every voxel by 1.01 exceeds them 100-fold.
export const TOLERANCES = Object.freeze({
  // Final NCC the engine reports, absolute; it is printed to 4 decimals.
  finalNcc: 0.001,
  // Mean and standard deviation of every output voxel, relative to the reference.
  intensity: 0.0001,
  // Pearson correlation of the output and fixed images over the fixed brain, absolute.
  fixedCorrelation: 0.0001,
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

// Downloads (once) and verifies the example named in apps/fireants/examples.json.
export async function pinnedExample() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/fireants/examples.json', import.meta.url), 'utf8'));
  const [example] = examples;
  const [moving, fixed] = await Promise.all(example.files.map(pinnedFile));
  return { id: example.id, moving, fixed };
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-fireants-validation', revision, file.name);
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

const READERS = {
  2: [1, (bytes, offset) => bytes.readUInt8(offset)],
  4: [2, (bytes, offset) => bytes.readInt16LE(offset)],
  16: [4, (bytes, offset) => bytes.readFloatLE(offset)],
};

const floats = (bytes, offset, count) => Array.from({ length: count }, (_, i) => bytes.readFloatLE(offset + 4 * i));

// The NIfTI-1 fields that place voxels in space, exactly as stored.
function geometry(bytes) {
  return {
    dims: [42, 44, 46].map((offset) => bytes.readInt16LE(offset)),
    pixdim: floats(bytes, 76, 4),
    qformCode: bytes.readInt16LE(252),
    sformCode: bytes.readInt16LE(254),
    quatern: floats(bytes, 256, 6),
    srow: floats(bytes, 280, 12),
  };
}

function readVolume(compressed) {
  const bytes = gunzipSync(compressed);
  if (bytes.readInt32LE(0) !== 348) throw new Error('expected a little-endian NIfTI-1 image');
  const header = geometry(bytes);
  const datatype = bytes.readInt16LE(70);
  if (!READERS[datatype]) throw new Error(`unsupported NIfTI datatype ${datatype}`);
  const [size, read] = READERS[datatype];
  const offset = Math.trunc(bytes.readFloatLE(108));
  const slope = bytes.readFloatLE(112) || 1;
  const intercept = bytes.readFloatLE(116);
  const count = header.dims[0] * header.dims[1] * header.dims[2];
  const data = new Float64Array(count);
  for (let i = 0; i < count; i += 1) data[i] = read(bytes, offset + i * size) * slope + intercept;
  return { geometry: header, datatype, data, voxelSha256: sha256(bytes.subarray(offset, offset + count * size)) };
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

// What the checks compare about one registered image: its header geometry, a hash of its voxels
// and statistics that move with the voxels' scale (mean, std) or alignment (fixedCorrelation).
export function summarize(registered, fixed) {
  const output = readVolume(registered);
  const fixedVolume = readVolume(fixed);
  return {
    geometry: output.geometry,
    fixedGeometry: fixedVolume.geometry,
    datatype: output.datatype,
    voxelSha256: output.voxelSha256,
    ...moments(output.data),
    fixedCorrelation: correlation(output.data, fixedVolume.data),
  };
}

// The fields a reference entry records, without the fixed image's geometry.
export function recorded({ fixedGeometry, ...summary }) {
  return summary;
}

const relative = (actual, expected) => Math.abs(actual - expected) / Math.abs(expected);

// Returns [passed, line] pairs. `expected` is one reference entry (browser or inProcess).
export function compare(label, actual, expected, source) {
  const checks = [
    [
      JSON.stringify(actual.geometry) === JSON.stringify(actual.fixedGeometry),
      `${label} header geometry equals the fixed image's (dims ${actual.geometry.dims.join('x')}, qform ${actual.geometry.qformCode}, sform ${actual.geometry.sformCode})`,
    ],
    [
      JSON.stringify(actual.geometry) === JSON.stringify(expected.geometry) && actual.datatype === expected.datatype,
      `${label} header geometry and datatype ${actual.datatype} equal the ${source} reference's`,
    ],
    [
      actual.voxelSha256 === expected.voxelSha256,
      `${label} voxels ${actual.voxelSha256.slice(0, 12)} identical to the ${source} reference's ${expected.voxelSha256.slice(0, 12)}`,
    ],
  ];
  for (const name of ['mean', 'std']) {
    const difference = relative(actual[name], expected[name]);
    checks.push([
      difference <= TOLERANCES.intensity,
      `${label} voxel ${name} ${actual[name].toFixed(4)} vs ${source} ${expected[name].toFixed(4)}, relative diff ${difference.toExponential(1)} <= ${TOLERANCES.intensity}`,
    ]);
  }
  const difference = Math.abs(actual.fixedCorrelation - expected.fixedCorrelation);
  checks.push([
    difference <= TOLERANCES.fixedCorrelation,
    `${label} correlation with the fixed brain ${actual.fixedCorrelation.toFixed(6)} vs ${source} ${expected.fixedCorrelation.toFixed(6)}, |diff| ${difference.toExponential(1)} <= ${TOLERANCES.fixedCorrelation}`,
  ]);
  return checks;
}
