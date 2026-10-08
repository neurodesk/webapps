// Cases shared by the browser reference run (browser-reference.mjs) and the
// Node driver tests. reference.json pins what the browser produced for each.

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const REFERENCE_URL = new URL('./reference.json', import.meta.url);

// The brain-extraction app's T1-weighted example.
export const MINDGRAB_INPUT = {
  name: 'T1_head.nii.gz',
  url: 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/356a4adbce52cf9052d61ef90b14ba263e7c25e9/synthseg/validation/T1_head.nii.gz',
  sha256: '58220b40d179b7a93dd3ce231dd7afaa39989c75658b2b8e4c2f34abf8f16416',
};

// One call per model the apps use, with the options they pass.
export const MINDGRAB_CASES = [
  { id: 'mindgrab-mask', call: 'segment', options: { model: 'mindgrab', mask: true } },
  { id: 'mindmap-tissues', call: 'segmentTissues', options: { model: 'mindmap' } },
  { id: 'mindsnap-labels', call: 'segment', options: { model: 'mindsnap' } },
  { id: '16chan18cls-labels', call: 'segment', options: { model: '16chan18cls' } },
];

// Every NIfTI output is gzipped by niimath; the second input feeds -mas.
export const NIIMATH_CASES = [
  // Native -O3 builds round the Gaussian's float sums differently, by about 5e-5.
  { id: 'smooth', args: ['in.nii', '-s', '2', 'out.nii.gz'], nativeTolerance: 1e-4 },
  { id: 'threshold-binarize', args: ['in.nii', '-thr', '50', '-bin', 'out.nii.gz', '-odt', 'char'] },
  { id: 'dilate', args: ['in.nii', '-kernel', 'boxv', '3', '-dilM', 'out.nii.gz'] },
  { id: 'mask', args: ['in.nii', '-mas', 'mask.nii', '-mul', '2', '-add', '10', 'out.nii.gz'] },
  { id: 'otsu', args: ['in.nii', '-otsu', '3', 'out.nii.gz'] },
];

/** The flattened outputs of a mindgrab result, keyed by name. */
export function mindgrabOutputs(result) {
  const outputs = {};
  if (result.image) outputs.image = result.image;
  if (result.mask) outputs.mask = result.mask;
  if (result.tissues) Object.assign(outputs, result.tissues);
  return outputs;
}

/** A deterministic 32^3 float32 NIfTI-1 (2 mm, sform), and a binary mask of it. */
export function niimathInputs() {
  const n = 32;
  const image = new Float32Array(n * n * n);
  const mask = new Float32Array(n * n * n);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const i = x + n * (y + n * z);
        const r = Math.hypot(x - 15.5, y - 15.5, z - 15.5);
        image[i] = Math.round(120 * Math.exp(-(r * r) / 80) + 20 * Math.sin(x * 0.7) * Math.cos(y * 0.4) + (i % 13));
        mask[i] = r < 11 ? 1 : 0;
      }
    }
  }
  return { 'in.nii': nifti(image, n), 'mask.nii': nifti(mask, n) };
}

function nifti(data, n) {
  const header = new DataView(new ArrayBuffer(352));
  header.setInt32(0, 348, true);
  for (const [offset, value] of [[40, 3], [42, n], [44, n], [46, n], [48, 1], [50, 1], [52, 1], [70, 16], [72, 32], [252, 0], [254, 1]]) {
    header.setInt16(offset, value, true);
  }
  for (const [offset, value] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1]]) {
    header.setFloat32(offset, value, true);
  }
  for (const [row, values] of [[280, [2, 0, 0, -31]], [296, [0, 2, 0, -31]], [312, [0, 0, 2, -31]]]) {
    values.forEach((value, column) => header.setFloat32(row + 4 * column, value, true));
  }
  new Uint8Array(header.buffer).set([0x6e, 0x2b, 0x31, 0], 344);
  const bytes = new Uint8Array(352 + data.byteLength);
  bytes.set(new Uint8Array(header.buffer));
  bytes.set(new Uint8Array(data.buffer), 352);
  return bytes;
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes).digest('hex');
}

/** Downloads a pinned file once into os.tmpdir() and checks its digest. */
export async function pinnedFile({ name, url, sha256: expected }) {
  const path = join(tmpdir(), 'neurodesk-runtime-support-validation', expected, name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return cached;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Download failed: ${url} (${response.status})`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Checksum mismatch for ${name}`);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(`${path}.part`, bytes);
  await rename(`${path}.part`, path);
  return bytes;
}
