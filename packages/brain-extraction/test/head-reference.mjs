// Independent reference for brain extraction: FreeSurfer 8.1.0 `mri_synthseg --i T1_head.nii.gz --o
// T1_head_default.nii.gz`, the golden label map exes/synthseg already validates against, pinned on
// Hugging Face. The reference brain mask is every labelled voxel (brain tissue, ventricles and the
// CSF label 24), which is what BET, MindGrab and SynthStrip aim to keep. None of the code under
// test produced it. Files are cached under TMPDIR and re-verified by SHA-256 on every use.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readVolume } from '@neurodesk/synthsr';

const BASE_URL = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/356a4adbce52cf9052d61ef90b14ba263e7c25e9/synthseg/validation/';
const IMAGE = { name: 'T1_head.nii.gz', sha256: '58220b40d179b7a93dd3ce231dd7afaa39989c75658b2b8e4c2f34abf8f16416' };
const LABELS = { name: 'T1_head_default.nii.gz', sha256: '8fea403662eb3f422ff9b942b667ef5cce454cb79c8177e55e14aa9427f4c81a' };

// Measured 2026-10-03 with QSMbly BET 0.9.2 at fractional intensity 0.5: Dice 0.9454
// (1 474 433 BET voxels, 1 598 909 reference voxels). The gate leaves a 0.015 margin.
export const BET_MIN_DICE = 0.93;

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const arrayBuffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function pinned({ name, sha256: expected }, directory) {
  const path = join(directory, name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === expected) return { path, bytes: cached };
  const response = await fetch(BASE_URL + name);
  if (!response.ok) throw new Error(`Brain extraction reference ${name} is unavailable: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== expected) throw new Error(`Brain extraction reference ${name} failed SHA-256 verification`);
  const partial = `${path}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, path);
  return { path, bytes };
}

export async function loadHeadReference() {
  const directory = join(process.env.TMPDIR || process.env.RUNNER_TEMP || tmpdir(), 'neurodesk-brain-extraction-reference');
  await mkdir(directory, { recursive: true });
  const image = await pinned(IMAGE, directory);
  const labels = readVolume(arrayBuffer((await pinned(LABELS, directory)).bytes));
  const volume = readVolume(arrayBuffer(image.bytes));
  if (labels.dims.join() !== volume.dims.join()) throw new Error('Reference labels are not on the image grid');
  const mask = Uint8Array.from(labels.data, value => value ? 1 : 0);
  return { imagePath: image.path, imageName: IMAGE.name, imageSha256: IMAGE.sha256, volume, mask };
}
