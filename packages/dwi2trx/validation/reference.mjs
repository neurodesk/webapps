// The pinned example, the web app's recorded tensor maps and the comparison both release checks
// apply: validation/cli-check.mjs for the command line and apps/dwi2trx/e2e/reference.spec.js for
// the web app. dwi-gradients-reference.json holds the MindGrab mask the command line computes on
// the CPU (mask) and the maps the built web app downloaded when given that mask (browser).
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseNiftiHeader, readNiftiFrames } from '@neurodesk/webapp-components/file-io/nifti';
import { TENSOR_MAPS, mapFileName } from '../src/tensor.js';

export const REFERENCE = new URL('./dwi-gradients-reference.json', import.meta.url);
// examples.json pins the dataset revision but not file checksums, so the checks pin the bytes.
export const EXAMPLE_SHA256 = Object.freeze({
  'dwi.nii.gz': '9007c69e6f93b94fd57bf427415a7b4bd2c0822a6b5ee334cb561b8a6ebcd50f',
  'dwi.bval': '5b7b0b81f43794445d5b12fb227a5f4ed838c9df384d9a639d47d18fb067118b',
  'dwi.bvec': '709d68fced5a626dc8496cd0d2950efe18d29187f6aa028bd05551c69e0f6376',
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

// Downloads (once) and verifies the example named in apps/dwi2trx/examples.json.
export async function pinnedExample() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/dwi2trx/examples.json', import.meta.url), 'utf8'));
  const [example] = examples;
  const file = (role) => example.files.find((entry) => entry.role === role);
  const [image, bval, bvec] = await Promise.all(['image', 'bval', 'bvec'].map((role) => pinnedFile(file(role))));
  return { id: example.id, image, bval, bvec };
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-dwi2trx-validation', revision, file.name);
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

/** What the checks compare about one .nii.gz: its stored header, its voxels and their statistics. */
export function summarize(stored) {
  const bytes = stored[0] === 0x1f && stored[1] === 0x8b ? gunzipSync(stored) : Buffer.from(stored);
  const header = parseNiftiHeader(bytes);
  const { data } = readNiftiFrames(bytes, Float64Array);
  const offset = Math.ceil(header.voxOffset);
  let count = 0;
  let sum = 0;
  let nonzero = 0;
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of data) {
    if (!Number.isFinite(value)) continue;
    count += 1;
    sum += value;
    if (value !== 0) nonzero += 1;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  const mean = sum / count;
  let squares = 0;
  for (const value of data) if (Number.isFinite(value)) squares += (value - mean) ** 2;
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
    // niimath gzips with no timestamp, so the stored bytes are reproducible too.
    fileSha256: sha256(stored),
    headerSha256: sha256(bytes.subarray(0, offset)),
    voxelSha256: sha256(bytes.subarray(offset, offset + (data.length * header.bitpix) / 8)),
    nonFinite: data.length - count,
    nonzero,
    minimum,
    maximum,
    mean,
    std: Math.sqrt(squares / count),
  };
}

/** Summaries of every map in a directory or file map, keyed by TENSOR_MAPS name. */
export async function summarizeMaps(read, niftiName) {
  const maps = {};
  for (const map of TENSOR_MAPS) maps[map] = summarize(await read(mapFileName(niftiName, map)));
  return maps;
}

const FIELDS = ['datatype', 'fileSha256', 'headerSha256', 'voxelSha256', 'nonFinite', 'nonzero', 'minimum', 'maximum', 'mean', 'std'];

// Returns [passed, line] pairs. The web app and the command line run one WebAssembly build, so
// every map must match exactly: geometry, stored header, voxels, value range and statistics.
export function compare(label, actual, expected, source) {
  const checks = [];
  for (const map of TENSOR_MAPS) {
    const [is, was] = [actual[map], expected[map]];
    if (!is || !was) {
      checks.push([false, `${label} ${map} present in both outputs`]);
      continue;
    }
    checks.push([
      JSON.stringify(is.geometry) === JSON.stringify(was.geometry),
      `${label} ${map} header geometry (dims ${is.geometry.dims.slice(1).join('x')}) equals the ${source}'s`,
    ]);
    const differing = FIELDS.filter((field) => is[field] !== was[field]);
    checks.push([
      differing.length === 0,
      `${label} ${map} voxels ${is.voxelSha256.slice(0, 12)} and header ${is.headerSha256.slice(0, 12)} identical to the ${source}'s, mean ${is.mean.toPrecision(6)}, range ${is.minimum.toPrecision(4)} to ${is.maximum.toPrecision(4)}${differing.length ? `; differs in ${differing.join(', ')}` : ''}`,
    ]);
  }
  return checks;
}
