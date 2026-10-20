// The cases both release checks run, and their comparison: validation/cli-check.mjs for the
// command line and apps/noddi/e2e/reference.spec.js for the web app. browser-reference.json holds
// the MindGrab mask the command line computes on the CPU (mask) and what the built web app
// downloaded for each case (browser).
//
// The app's pinned example has one shell, so it covers the tensor fit, the NODDI refusal and the
// MindGrab mask; the two-shell phantom (src/phantom.js) covers NODDI (AMICO) and --no-mask. The
// example's mask comes from the command line's CPU MindGrab and reaches the app through its mask
// input, since the app's own MindGrab prefers a GPU: this isolates the fit.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createNiftiFromData, readNiftiFrames } from '@neurodesk/webapp-components/file-io/nifti';
import { multiShellPhantom } from '../src/phantom.js';

export const REFERENCE = new URL('./browser-reference.json', import.meta.url);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * The cases, each with the web app's automation parameters, the command line's options and
 * whether the mask is MindGrab's (`mindgrab`), an all-ones mask (`none`: --no-mask on the
 * command line, a mask of every voxel in the app).
 */
export const CASES = Object.freeze([
  { id: 'example', input: 'example', mask: 'mindgrab', parameters: { noddi: true, tensorFit: 'wls' }, options: [] },
  { id: 'phantom', input: 'phantom', mask: 'none', parameters: { noddi: true, tensorFit: 'wls' }, options: ['--no-mask'] },
  { id: 'phantom-ols-tensor', input: 'phantom', mask: 'none', parameters: { noddi: false, tensorFit: 'ols' }, options: ['--no-mask', '--no-noddi', '--tensor-fit', 'ols'] },
]);

export async function readReference() {
  return JSON.parse(await readFile(REFERENCE, 'utf8'));
}

export async function writeReference(reference) {
  await writeFile(REFERENCE, `${JSON.stringify(reference, null, 2)}\n`);
}

const scratch = () => process.env.TMPDIR || tmpdir();

/** The app's first example, downloaded once and verified against examples.json. */
async function pinnedExample() {
  const examples = JSON.parse(await readFile(new URL('../../../apps/noddi/examples.json', import.meta.url), 'utf8'));
  const [example] = examples;
  const files = {};
  for (const file of example.files) {
    const revision = new URL(file.url).pathname.split('/')[5];
    const path = join(scratch(), 'neurodesk-noddi-validation', revision, file.name);
    files[file.role] = { name: file.name, path, sha256: file.sha256 };
    const cached = await readFile(path).catch(() => null);
    if (cached && sha256(cached) === file.sha256) continue;
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== file.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin in examples.json`);
    await mkdir(join(path, '..'), { recursive: true });
    await writeFile(`${path}.partial`, bytes);
    await rename(`${path}.partial`, path);
  }
  return { id: example.id, files };
}

/** The phantom's files, and a mask of every voxel on its grid (the app's form of --no-mask). */
async function phantomFiles() {
  const phantom = multiShellPhantom();
  const directory = join(scratch(), 'neurodesk-noddi-validation', 'phantom');
  await mkdir(directory, { recursive: true });
  const write = async (name, bytes) => {
    const path = join(directory, name);
    await writeFile(path, bytes);
    return { name, path, sha256: sha256(bytes) };
  };
  const everyVoxel = createNiftiFromData(new Uint8Array(phantom.voxels).fill(1), phantom.nifti.buffer, { dims: phantom.dims });
  return {
    id: 'phantom',
    files: {
      image: await write('sub-phantom_dwi.nii', phantom.nifti),
      bval: await write('sub-phantom_dwi.bval', Buffer.from(phantom.bval)),
      bvec: await write('sub-phantom_dwi.bvec', Buffer.from(phantom.bvec)),
    },
    everyVoxel: await write('sub-phantom_mask.nii', new Uint8Array(everyVoxel)),
  };
}

/** Every case's input files by role ({ name, path, sha256 }), the example's downloaded once. */
export async function caseInputs() {
  return { example: await pinnedExample(), phantom: await phantomFiles() };
}

/** Input checksums by input and file name, as the reference records them. */
export function inputChecksums(inputs) {
  return Object.fromEntries(Object.entries(inputs).map(([id, input]) => [
    id,
    Object.fromEntries(Object.values(input.files).map((file) => [file.name, file.sha256])),
  ]));
}

// What the checks compare about one download: its name, its decompressed NIfTI bytes (header and
// voxels) and the voxel statistics a reader of a failure needs. The browser and Node gzip with
// different zlib builds, so the compressed bytes may differ.
export function summarize(name, stored) {
  const bytes = stored[0] === 0x1f && stored[1] === 0x8b ? gunzipSync(stored) : Buffer.from(stored);
  const { data } = readNiftiFrames(bytes, Float64Array);
  let nonzero = 0;
  let sum = 0;
  let finite = 0;
  for (const value of data) {
    if (!Number.isFinite(value)) continue;
    finite += 1;
    sum += value;
    if (value !== 0) nonzero += 1;
  }
  return { name, decompressedSha256: sha256(bytes), nonFinite: data.length - finite, nonzero, mean: finite ? sum / finite : 0 };
}

/** The provenance fields the web app and the command line both report. */
export function sharedProvenance(provenance) {
  return { method: provenance.method, tensorFit: provenance.tensorFit, maskVoxels: provenance.maskVoxels };
}

// Returns [passed, line] pairs comparing one case's downloads, keyed by artifact role, with the
// recorded ones. The web app and the command line run one WebAssembly module on the same chunks,
// so every file must be identical once decompressed.
export function compareOutputs(label, actual, expected) {
  const checks = [];
  const roles = [...new Set([...Object.keys(expected), ...Object.keys(actual)])];
  for (const role of roles) {
    const [is, was] = [actual[role], expected[role]];
    if (!is || !was) {
      checks.push([false, `${label} ${role} ${is ? 'is not in the reference' : 'was not written'}`]);
      continue;
    }
    checks.push([
      is.name === was.name && is.decompressedSha256 === was.decompressedSha256,
      `${label} ${role}: ${is.name} ${is.decompressedSha256.slice(0, 12)} (mean ${is.mean.toPrecision(6)}, ${is.nonzero} non-zero) identical to the web app's ${was.name} ${was.decompressedSha256.slice(0, 12)} (mean ${was.mean.toPrecision(6)})`,
    ]);
  }
  return checks;
}
