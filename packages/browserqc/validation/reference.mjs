// The pinned example, the web app's recorded downloads and the comparison both release checks
// apply: validation/cli-check.mjs for the command line and apps/browserqc/e2e/reference.spec.js
// for the web app. reference.json holds what the built web app downloaded on its CPU backend.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parseNiftiHeader, readNiftiImageData, sameNiftiGrid } from '@neurodesk/webapp-components/file-io/nifti';

export const REFERENCE = new URL('./reference.json', import.meta.url);
// examples.json pins the dataset revision but not file checksums, so the checks pin the bytes.
export const EXAMPLE_SHA256 = Object.freeze({
  't1_crop.nii.gz': '1a91502c8997981a1103cc5f2a3ada12c79dfb0498047f9e931fa358bb953886',
  't1_crop.json': '5201efd81abd53a7adc5b698517894ed8b9ca1cb5ed57b30a075ba1010bb4da8',
});
// The default model and the label model of neurodesk/webapps#166.
export const CASES = Object.freeze(['mindmap-pve', '16chan18cls']);
export const ARTIFACTS = Object.freeze({
  'mindmap-pve': ['brain-mask.nii', 'csf.nii', 'gm.nii', 'wm.nii', 'qc.json'],
  '16chan18cls': ['brain-mask.nii', 'labels.nii', 'qc.json'],
});
// Both runtimes run the same WebAssembly on the CPU, so outputs are compared exactly. These limits
// only report how far a differing value is.
export const TOLERANCES = Object.freeze({
  // Sum of every voxel value of an image, relative to the reference.
  voxelSum: 0,
  // Every numeric metric of niimath's report, relative to the reference.
  metric: 0,
});

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

// Downloads (once) and verifies the example named in apps/browserqc/examples.json.
export async function pinnedExample() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/browserqc/examples.json', import.meta.url), 'utf8'));
  const [example] = examples;
  const file = (role) => example.files.find((entry) => entry.role === role);
  const [image, sidecar] = await Promise.all([pinnedFile(file('image')), pinnedFile(file('metadata'))]);
  return { id: example.id, image, sidecar };
}

async function pinnedFile(file) {
  const revision = new URL(file.url).pathname.split('/')[5];
  const path = join(tmpdir(), 'neurodesk-browserqc-validation', revision, file.name);
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

const plain = (bytes) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes);
const floats = (bytes, offset, count) => Array.from({ length: count }, (_, i) => bytes.readFloatLE(offset + 4 * i));

function summarizeImage(file, input) {
  const bytes = Buffer.from(plain(file));
  const header = parseNiftiHeader(bytes);
  const { data } = readNiftiImageData(bytes, Float64Array);
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let nonzero = 0;
  let integer = true;
  const counts = new Map();
  for (const value of data) {
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    if (value !== 0) nonzero += 1;
    if (!Number.isInteger(value)) integer = false;
    else if (counts.size <= 256) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return {
    sha256: sha256(bytes),
    geometry: {
      dims: header.dims.slice(0, header.dims[0] + 1),
      pixdim: header.pixDims.slice(1, 4),
      qformCode: bytes.readInt16LE(252),
      sformCode: bytes.readInt16LE(254),
      srow: floats(bytes, 280, 12),
    },
    datatype: header.datatype,
    onInputGrid: sameNiftiGrid(bytes, input),
    min,
    max,
    integer,
    nonzero,
    sum,
    labels: integer && counts.size <= 256 ? Object.fromEntries([...counts].sort(([a], [b]) => a - b)) : null,
  };
}

// What the checks compare about one model's downloads. `files` maps each download name to its
// bytes; `input` is the example image as given.
export function summarize(files, input) {
  const raw = Buffer.from(plain(input));
  const summary = {};
  for (const [name, bytes] of Object.entries(files)) {
    summary[name] = name.endsWith('.json') ? JSON.parse(Buffer.from(bytes).toString('utf8')) : summarizeImage(bytes, raw);
  }
  return summary;
}

// MindGrab stores fractions as uint8 with a float32 scl_slope of 1/255, so 255 reads as 1 + 6e-8.
const FRACTION_MAX = 1 + 1e-6;

// The values each download may hold, whatever the reference says.
function inDomain(name, image) {
  if (name === 'brain-mask.nii') return image.integer && image.min === 0 && image.max === 1;
  if (name === 'labels.nii') return image.integer && image.min === 0 && image.max < 256;
  return image.min >= 0 && image.max <= FRACTION_MAX && !image.integer;
}

const relative = (actual, expected) => (actual === expected ? 0 : Math.abs(actual - expected) / Math.abs(expected));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function compareReport(label, actual, expected, source, sidecar) {
  const checks = [];
  const numeric = (report) => Object.keys(report).filter((key) => typeof report[key] === 'number').sort();
  const keys = numeric(expected);
  checks.push([same(numeric(actual), keys), `${label} qc.json has the reference's ${keys.length} metrics`]);
  let worst = { key: '', difference: 0 };
  const outside = [];
  for (const key of keys) {
    const difference = typeof actual[key] === 'number' ? relative(actual[key], expected[key]) : Infinity;
    if (!(difference <= TOLERANCES.metric)) outside.push(key);
    if (!(difference <= worst.difference)) worst = { key, difference };
  }
  checks.push([
    outside.length === 0,
    `${label} qc.json metrics equal the ${source} reference's within ${TOLERANCES.metric} relative${outside.length ? `; differ: ${outside.join(', ')}` : ''} (largest ${worst.key ? `${worst.key} ` : ''}${worst.difference.toExponential(1)})`,
  ]);
  for (const key of ['cjv', 'cnr', 'snr_total', 'efc_brain', 'vol_gm_mm3', 'vol_wm_mm3']) {
    checks.push([
      Number.isFinite(actual[key]) && actual[key] > 0,
      `${label} qc.json ${key} ${actual[key]} is finite and positive (${source} ${expected[key]})`,
    ]);
  }
  checks.push([same(actual.provenance, expected.provenance), `${label} qc.json provenance equals the ${source} reference's (${actual.provenance?.segmentation})`]);
  checks.push([same(actual.bids_meta, sidecar), `${label} qc.json bids_meta is the example's sidecar`]);
  return checks;
}

// Returns [passed, line] pairs for one model. `expected` is the reference case's downloads.
export function compare(label, actual, expected, source, sidecar) {
  const checks = [];
  for (const [name, was] of Object.entries(expected)) {
    const is = actual[name];
    if (name.endsWith('.json')) {
      checks.push(...compareReport(label, is ?? {}, was, source, sidecar));
      continue;
    }
    if (!is) {
      checks.push([false, `${label} ${name} was written`]);
      continue;
    }
    checks.push([is.onInputGrid, `${label} ${name} lies on the input image's grid within 0.001 mm (dims ${is.geometry.dims.slice(1).join('x')})`]);
    checks.push([
      same(is.geometry, was.geometry) && is.datatype === was.datatype,
      `${label} ${name} header geometry and datatype ${is.datatype} equal the ${source} reference's`,
    ]);
    checks.push([inDomain(name, is), `${label} ${name} values ${is.min}..${is.max}${is.integer ? ' (integers)' : ''} are in its domain`]);
    checks.push([
      same(is.labels, was.labels) && is.nonzero === was.nonzero,
      `${label} ${name} ${is.nonzero} non-zero voxels${is.labels ? ` in ${Object.keys(is.labels).length} values` : ''} match the ${source} reference's ${was.nonzero}`,
    ]);
    const difference = relative(is.sum, was.sum);
    checks.push([
      difference <= TOLERANCES.voxelSum,
      `${label} ${name} voxel sum ${is.sum.toPrecision(8)} vs ${source} ${was.sum.toPrecision(8)}, relative diff ${difference.toExponential(1)} <= ${TOLERANCES.voxelSum}`,
    ]);
    checks.push([is.sha256 === was.sha256, `${label} ${name} bytes ${is.sha256.slice(0, 12)} identical to the ${source} reference's ${was.sha256.slice(0, 12)}`]);
  }
  return checks;
}
