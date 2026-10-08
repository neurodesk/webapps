// The inputs and settings that the browser reference (browser-reference.mjs) records and the
// release check (cli-check.mjs) replays. browser-reference.json pins what the browser produced.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { gunzipSync } from 'node:zlib';

export const REFERENCE_URL = new URL('./browser-reference.json', import.meta.url);

const examples = JSON.parse(await readFile(new URL('../../../apps/brain2print/examples.json', import.meta.url), 'utf8'));
const lock = JSON.parse(await readFile(new URL('../../../registry/offline-assets.lock.json', import.meta.url), 'utf8'));
const SMALL = new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url);
// The MNI152 2 mm template the app's CPU e2e test meshes (apps/brain2print/e2e/automation.spec.js).
const MNI = new URL('../../../apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url);
// The browser can only be held to the CPU backend; the command line has no other.
const DEFAULTS = { model: 'pve', backend: 'cpu', simplify: 20, smooth: 0, largestOnly: true, fillBubbles: true };

// The app's pinned example with its defaults; the template the app's CPU e2e test meshes; the
// e2e fixture as stored and mirrored, smoothed as its e2e test does; and one label model.
export const CASES = [
  { id: 'example-pve', input: 'example', settings: DEFAULTS },
  { id: 'mni152-pve', input: 'mni152', settings: DEFAULTS },
  { id: 'small-pve-smooth5', input: 'small', settings: { ...DEFAULTS, smooth: 5 } },
  { id: 'small-left-handed-pve-smooth5', input: 'small-left-handed', settings: { ...DEFAULTS, smooth: 5 } },
  { id: 'small-16chan18cls', input: 'small', settings: { ...DEFAULTS, model: '16chan18cls' } },
];

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** Downloads the app's example once into os.tmpdir() and checks it against the offline-assets lock. */
async function pinnedExample() {
  const [file] = examples.find(({ id }) => id === 't1-brain').files;
  const pin = lock.assets[file.url];
  if (!pin) throw new Error(`${file.url} is not in registry/offline-assets.lock.json`);
  const path = join(tmpdir(), 'neurodesk-brain2print-validation', pin.sha256, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === pin.sha256) return { name: file.name, bytes: cached };
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== pin.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return { name: file.name, bytes };
}

/**
 * A NIfTI-1 with its first voxel axis reversed and the sform updated to match, so the affine has
 * a negative determinant (left-handed storage) while the anatomy is unchanged.
 */
export function leftHanded(nifti) {
  const raw = Buffer.from(nifti[0] === 0x1f && nifti[1] === 0x8b ? gunzipSync(nifti) : nifti);
  const header = Buffer.from(raw.subarray(0, 352));
  const [nx, ny, nz] = [1, 2, 3].map((i) => header.readInt16LE(40 + i * 2));
  const bytes = header.readInt16LE(72) / 8;
  const offset = Math.ceil(header.readFloatLE(108));
  const data = Buffer.alloc(raw.length - offset);
  for (let k = 0; k < nz; k++) {
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const source = offset + ((k * ny + j) * nx + i) * bytes;
        raw.copy(data, ((k * ny + j) * nx + (nx - 1 - i)) * bytes, source, source + bytes);
      }
    }
  }
  // srow_x/y/z: column 0 negated, origin moved to the last voxel.
  for (const row of [280, 296, 312]) {
    header.writeFloatLE(header.readFloatLE(row + 12) + header.readFloatLE(row) * (nx - 1), row + 12);
    header.writeFloatLE(-header.readFloatLE(row), row);
  }
  // qform off, so only the sform describes the geometry.
  header.writeInt16LE(0, 252);
  return Buffer.concat([header, raw.subarray(352, offset), data]);
}

/** The bytes a case segments, with the file name they are given. */
export async function caseInput(input) {
  if (input === 'example') return pinnedExample();
  if (input === 'mni152') return { name: 'brain.nii.gz', bytes: await readFile(MNI) };
  const small = await readFile(SMALL);
  if (input === 'small-left-handed') return { name: 'small_lh.nii', bytes: leftHanded(small) };
  return { name: 'small.nii.gz', bytes: small };
}
