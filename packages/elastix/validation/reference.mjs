// The pinned example, the web app's recorded downloads and the comparison both
// release checks apply: validation/cli-check.mjs for the command line and
// apps/elastix/e2e/reference.spec.js for the web app. t1-mni-reference.json
// holds what the built web app downloaded for each preset (browser).
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import ZipFileStore from '@zarrita/storage/zip';
import * as zarr from 'zarrita';
import { readTransformNode } from '@itk-wasm/transform-io';
import { parseNiftiHeader, readNiftiFrames, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';
import { fetchPinnedExample } from '../../../test-utils/registration-similarity.mjs';
import { outputNames } from '../src/outputs.js';
import { parameterFileNames, PRESETS as PRESET_STAGES } from '../src/parameter-maps.js';

export const REFERENCE = new URL('./t1-mni-reference.json', import.meta.url);
export const PRESETS = Object.freeze(Object.keys(PRESET_STAGES));
const ELASTIX_WASM = new URL('pipelines/elastix.wasm.zst', import.meta.resolve('@itk-wasm/elastix'));
// The registered image is held to the web app's within these limits, a tenth
// of the smallest shift the smallest legitimate change to a run caused on the
// pinned example: elastix's sampler seed (RandomSeed 121213 instead of the
// default 121212) moved the rigid preset's mean by 1.7e-6 and its std by
// 7.5e-6 (relative), and the B-spline preset's fixed-image correlation by
// 1.1e-3. Parameter files, HDF5 transforms and OME-Zarr transforms must be
// identical.
export const TOLERANCES = Object.freeze({
  // Mean and standard deviation of every voxel value, relative to the reference.
  intensity: 1e-7,
  // Pearson correlation of the registered and fixed images over the fixed brain, absolute.
  fixedCorrelation: 1e-4,
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function elastixWasmSha256() {
  return sha256(await readFile(ELASTIX_WASM));
}

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

function scratch() {
  const base = process.env.TMPDIR || process.env.RUNNER_TEMP;
  if (!base) throw new Error('Set TMPDIR (or RUNNER_TEMP) to a scratch directory.');
  return base;
}

/** The example named in apps/elastix/examples.json, checked against the offline lock and saved under TMPDIR. */
export async function pinnedExample() {
  const [example] = JSON.parse(await readFile(new URL('../../../apps/elastix/examples.json', import.meta.url), 'utf8'));
  const directory = join(scratch(), 'neurodesk-elastix-validation');
  await mkdir(directory, { recursive: true });
  const file = async (role) => {
    const entry = example.files.find((candidate) => candidate.role === role);
    const bytes = await fetchPinnedExample(entry.url);
    const path = join(directory, entry.name);
    await writeFile(path, bytes);
    return { name: entry.name, path, sha256: sha256(bytes) };
  };
  return { id: example.id, moving: await file('moving'), fixed: await file('stationary') };
}

/**
 * The downloads a preset gives for this moving image, as in the web app. A
 * B-spline run has no HDF5 transform (see hdf5Writable in src/outputs.js).
 */
export function expectedNames(movingName, method) {
  const names = outputNames(movingName);
  return [
    names.nifti,
    ...(method === 'bspline' ? [] : [names.transform]),
    names.transformOmeZarr,
    ...parameterFileNames(names.stem, PRESET_STAGES[method].length),
  ];
}

const floats = (bytes, offset, count) => Array.from({ length: count }, (_, i) => bytes.readFloatLE(offset + 4 * i));

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
  const [meanA, meanB] = [sumA / count, sumB / count];
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

const typedSha256 = (values) => sha256(Buffer.from(Float64Array.from(values).buffer));

// The HDF5 file's transforms as read back by ITK-Wasm. HDF5 stamps object
// modification times, so its bytes differ between any two writes.
async function readHdf5(bytes) {
  const directory = await mkdtemp(join(scratch(), 'elastix-h5-'));
  try {
    const path = join(directory, 'transform.h5');
    await writeFile(path, bytes);
    const transforms = await readTransformNode(path);
    return transforms.map((transform) => ({
      type: transform.transformType.transformParameterization,
      parametersSha256: typedSha256(transform.parameters ?? []),
      fixedParametersSha256: typedSha256(transform.fixedParameters ?? []),
    }));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

// Every zarr.json of an OME-Zarr transform archive, parsed, and each array's
// decoded values. The archive's own bytes carry the time it was zipped.
async function readTransformArchive(bytes) {
  const store = ZipFileStore.fromBlob(new Blob([bytes]));
  const document = async (key) => JSON.parse(new TextDecoder().decode(await store.get(`/${key}`)));
  const root = await document('zarr.json');
  const documents = { 'zarr.json': root };
  const arrays = {};
  for (const [path, metadata] of Object.entries(root.consolidated_metadata?.metadata ?? {})) {
    documents[`${path}/zarr.json`] = await document(`${path}/zarr.json`);
    if (metadata.node_type !== 'array') continue;
    const { data, shape } = await zarr.get(await zarr.open(zarr.root(store).resolve(path), { kind: 'array' }));
    let maxAbs = 0;
    for (const value of data) maxAbs = Math.max(maxAbs, Math.abs(value));
    arrays[path] = { shape, valuesSha256: sha256(Buffer.from(data.buffer, data.byteOffset, data.byteLength)), maxAbs };
  }
  return { documents, arrays };
}

/** The registered NIfTI's stored geometry, voxel hash and statistics. */
export function registeredSummary(compressed, fixed) {
  const fixedVolume = readVolume(fixed);
  const { data, bytes, ...registered } = readVolume(compressed);
  return {
    ...registered,
    onFixedGrid: sameNiftiGrid(bytes, fixedVolume.bytes),
    ...moments(data),
    fixedCorrelation: correlation(data, fixedVolume.data),
  };
}

/**
 * What the checks compare about one preset's downloads: `files` maps each
 * download's name to its bytes, `fixed` is the fixed image as given.
 */
export async function summarize(files, fixed, movingName, method) {
  const names = outputNames(movingName);
  return {
    files: Object.keys(files).sort(),
    registered: registeredSummary(files[names.nifti], fixed),
    parameters: parameterFileNames(names.stem, PRESET_STAGES[method].length).map((name) => ({ name, sha256: files[name] ? sha256(files[name]) : null })),
    transform: files[names.transform] ? await readHdf5(files[names.transform]) : null,
    transformOmeZarr: await readTransformArchive(files[names.transformOmeZarr]),
  };
}

const relative = (actual, expected) => Math.abs(actual - expected) / Math.abs(expected);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Returns [passed, line] pairs for one preset. `expected` is the reference's summary.
export function compare(label, actual, expected, source) {
  const checks = [];
  checks.push([same(actual.files, expected.files), `${label} writes the ${source} downloads ${expected.files.join(', ')}`]);
  const [is, was] = [actual.registered, expected.registered];
  checks.push([is.onFixedGrid, `${label} registered image lies on the fixed grid within 0.001 mm (dims ${is.geometry.dims.slice(1).join('x')})`]);
  checks.push([same(is.geometry, was.geometry) && is.datatype === was.datatype, `${label} registered header geometry and datatype ${is.datatype} equal the ${source} reference's`]);
  for (const name of ['mean', 'std']) {
    const difference = relative(is[name], was[name]);
    checks.push([difference <= TOLERANCES.intensity, `${label} registered voxel ${name} ${is[name].toPrecision(8)} vs ${source} ${was[name].toPrecision(8)}, relative diff ${difference.toExponential(1)} <= ${TOLERANCES.intensity}`]);
  }
  const difference = Math.abs(is.fixedCorrelation - was.fixedCorrelation);
  checks.push([difference <= TOLERANCES.fixedCorrelation, `${label} registered correlation with the fixed brain ${is.fixedCorrelation.toFixed(6)} vs ${source} ${was.fixedCorrelation.toFixed(6)}, |diff| ${difference.toExponential(1)} <= ${TOLERANCES.fixedCorrelation}`]);
  // Reported, not gated: the voxels are the tolerance-checked quantity above.
  console.log(`INFO ${label} registered voxels ${is.voxelSha256.slice(0, 12)} ${is.voxelSha256 === was.voxelSha256 ? 'identical to' : 'differ from'} the ${source} reference's ${was.voxelSha256.slice(0, 12)}`);
  actual.parameters.forEach((file, index) => {
    checks.push([file.sha256 === expected.parameters[index]?.sha256, `${label} ${file.name} bytes ${file.sha256?.slice(0, 12)} identical to the ${source} reference's ${expected.parameters[index]?.sha256?.slice(0, 12)}`]);
  });
  checks.push([same(actual.transform, expected.transform), expected.transform
    ? `${label} HDF5 transform reads back as the ${source} reference's ${expected.transform.map((transform) => transform.type).join(' + ')} parameters`
    : `${label} writes no HDF5 transform, as the ${source} does for a B-spline stage`]);
  const archive = [actual.transformOmeZarr, expected.transformOmeZarr];
  checks.push([same(archive[0].documents, archive[1].documents), `${label} OME-Zarr transform metadata (${Object.keys(archive[1].documents).join(', ')}) equals the ${source} reference's`]);
  for (const [path, array] of Object.entries(archive[1].arrays)) {
    const mine = archive[0].arrays[path];
    checks.push([same(mine, array), `${label} OME-Zarr ${path} values ${mine?.valuesSha256?.slice(0, 12)} identical to the ${source} reference's ${array.valuesSha256.slice(0, 12)} (max |d| ${array.maxAbs.toFixed(3)})`]);
  }
  return checks;
}
