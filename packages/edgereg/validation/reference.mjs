// The pinned example, the web app's recorded download and the comparisons both release checks
// apply: validation/cli-check.mjs for the command line and apps/edgereg/e2e/reference.spec.js for
// the web app. t1-mni-reference.json holds what the built web app downloaded (browser).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseNiftiHeader, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';

export const REFERENCE = new URL('./t1-mni-reference.json', import.meta.url);
// examples.json pins the dataset revision but not file checksums, so the checks pin the bytes.
export const EXAMPLE_SHA256 = Object.freeze({
  't1_crop.nii.gz': '534a240d1d41881bd33ae5b48ac22051836968775275f1261c4115dca0099649',
  'MNI152_T1_1mm.nii.gz': 'd1f03e160c2548592a01d98d44d7e0ffa8a8ef58bc9b07d26369e214ba170edb',
});
// The web app and the command line run one WebAssembly build, so the header and voxel hashes are
// the gates against the browser reference. Native niimath rounds differently and lands on a
// slightly different affine, so it is held to these limits instead. Measured on the pinned
// example with rordenlab/niimath 95645c24 on Linux x64: 29 % of voxels differ, by up to 78 of 255;
// the correlation with the WebAssembly output is 0.99953, and the mean differs by 5.4e-4 relative.
// Shifting the WebAssembly output by one voxel lowers its self-correlation to 0.960; blending in a
// tenth of the neighbouring voxel lowers it to 0.99961, so native niimath sits about a tenth of a
// voxel away.
export const NATIVE_TOLERANCES = Object.freeze({
  // 1 - Pearson correlation with the command line's output: a tenth of a one-voxel shift's, about
  // a third of a voxel.
  decorrelation: 0.004,
  // Voxel mean and standard deviation, relative to the command line's.
  intensity: 0.002,
  // Correlation with the fixed image, absolute.
  fixedCorrelation: 0.001,
  // 99.9th percentile of the absolute voxel difference: twice the measured 12. A one-voxel shift
  // of the WebAssembly output gives 80.
  p999: 24,
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

// Downloads (once) and verifies the example named in apps/edgereg/examples.json.
export async function pinnedExample() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/edgereg/examples.json', import.meta.url), 'utf8'));
  const [example] = examples;
  const file = (role) => example.files.find((entry) => entry.role === role);
  const [moving, fixed] = await Promise.all([pinnedFile(file('moving')), pinnedFile(file('stationary'))]);
  return { id: example.id, moving, fixed };
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-edgereg-validation', revision, file.name);
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

export function readVolume(stored) {
  const bytes = stored[0] === 0x1f && stored[1] === 0x8b ? gunzipSync(stored) : Buffer.from(stored);
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
    headerSha256: sha256(bytes.subarray(0, offset)),
    voxelSha256: sha256(bytes.subarray(offset, offset + (data.length * header.bitpix) / 8)),
    data,
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

export function correlation(a, b) {
  const { mean: meanA } = moments(a);
  const { mean: meanB } = moments(b);
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i += 1) {
    covariance += (a[i] - meanA) * (b[i] - meanB);
    varianceA += (a[i] - meanA) ** 2;
    varianceB += (b[i] - meanB) ** 2;
  }
  return covariance / Math.sqrt(varianceA * varianceB);
}

// What the checks compare about the registered image: its stored header, voxels, value range and
// how well it matches the fixed image.
export function summarize(registered, fixed) {
  const fixedVolume = readVolume(fixed);
  const { data, bytes, ...volume } = readVolume(registered);
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of data) {
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return {
    ...volume,
    onFixedGrid: sameNiftiGrid(bytes, fixedVolume.bytes),
    minimum,
    maximum,
    ...moments(data),
    fixedCorrelation: correlation(data, fixedVolume.data),
  };
}

// Returns [passed, line] pairs comparing a summary with the browser reference's.
export function compareWithBrowser(label, is, was) {
  return [
    [is.onFixedGrid, `${label} output lies on the fixed image's grid within 0.001 mm (dims ${is.geometry.dims.slice(1).join('x')})`],
    [
      JSON.stringify(is.geometry) === JSON.stringify(was.geometry) && is.datatype === was.datatype,
      `${label} header geometry and datatype ${is.datatype} equal the browser reference's`,
    ],
    [is.headerSha256 === was.headerSha256, `${label} header bytes ${is.headerSha256.slice(0, 12)} identical to the browser reference's ${was.headerSha256.slice(0, 12)}`],
    [is.voxelSha256 === was.voxelSha256, `${label} voxels ${is.voxelSha256.slice(0, 12)} identical to the browser reference's ${was.voxelSha256.slice(0, 12)}`],
    [
      is.minimum === was.minimum && is.maximum === was.maximum,
      `${label} value range ${is.minimum} to ${is.maximum} equals the browser reference's ${was.minimum} to ${was.maximum}`,
    ],
    [
      is.mean === was.mean && is.std === was.std,
      `${label} voxel mean ${is.mean.toPrecision(6)} and std ${is.std.toPrecision(6)} equal the browser reference's ${was.mean.toPrecision(6)} and ${was.std.toPrecision(6)}`,
    ],
    [
      is.fixedCorrelation === was.fixedCorrelation,
      `${label} correlation with the fixed image ${is.fixedCorrelation.toFixed(6)} equals the browser reference's ${was.fixedCorrelation.toFixed(6)}`,
    ],
  ];
}

function percentile(a, b, q) {
  const differences = Float64Array.from(a, (value, i) => Math.abs(value - b[i])).sort();
  return differences[Math.floor(q * (differences.length - 1))];
}

const relative = (actual, expected) => Math.abs(actual - expected) / Math.abs(expected);

// Returns [passed, line] pairs comparing native niimath's output with the command line's.
export function compareWithNative(native, cli, fixed) {
  const is = summarize(native, fixed);
  const was = summarize(cli, fixed);
  const checks = [
    [
      JSON.stringify(is.geometry) === JSON.stringify(was.geometry) && is.datatype === was.datatype,
      `native niimath header geometry and datatype ${is.datatype} equal the command line's`,
    ],
  ];
  const [nativeData, cliData] = [readVolume(native).data, readVolume(cli).data];
  const r = correlation(nativeData, cliData);
  checks.push([1 - r <= NATIVE_TOLERANCES.decorrelation, `native niimath voxels correlate ${r.toFixed(6)} with the command line's, 1 - r <= ${NATIVE_TOLERANCES.decorrelation}`]);
  const p999 = percentile(nativeData, cliData, 0.999);
  checks.push([p999 <= NATIVE_TOLERANCES.p999, `native niimath 99.9th percentile |voxel difference| ${p999} <= ${NATIVE_TOLERANCES.p999}`]);
  for (const name of ['mean', 'std']) {
    const difference = relative(is[name], was[name]);
    checks.push([
      difference <= NATIVE_TOLERANCES.intensity,
      `native niimath voxel ${name} ${is[name].toPrecision(6)} vs command line ${was[name].toPrecision(6)}, relative diff ${difference.toExponential(1)} <= ${NATIVE_TOLERANCES.intensity}`,
    ]);
  }
  const difference = Math.abs(is.fixedCorrelation - was.fixedCorrelation);
  checks.push([
    difference <= NATIVE_TOLERANCES.fixedCorrelation,
    `native niimath correlation with the fixed image ${is.fixedCorrelation.toFixed(6)} vs command line ${was.fixedCorrelation.toFixed(6)}, |diff| ${difference.toExponential(1)} <= ${NATIVE_TOLERANCES.fixedCorrelation}`,
  ]);
  return checks;
}
