// The validation cases shared by the browser recorder (browser-reference.mjs) and the
// command line's release check (cli-check.mjs). Each runs the app's pinned example through
// the `encode-volume` automation parameters, which the command line accepts as options.
// Recorded videos live in the pinned Hugging Face dataset, outside the source repository.
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const CASES = [
  {
    id: 'sagittal-webm',
    example: 't1-brain',
    parameters: { orientation: 'sagittal', format: 'webm', fps: 20, start: 40, end: 120, step: 5 },
  },
  {
    // 160 x 210 upscaled 1.5x is 240 x 315: the odd height is padded to 316 by the encoder.
    id: 'axial-flipped-upscale-webm',
    example: 't1-brain',
    parameters: { orientation: 'axial_flipped', format: 'webm', fps: 10, start: 60, end: 110, step: 5, upscale: 1.5, interpolation: 'bilinear' },
  },
  {
    id: 'coronal-annotate-webm',
    example: 't1-brain',
    parameters: { orientation: 'coronal', format: 'webm', fps: 12, start: 80, end: 140, step: 6, annotate: true },
  },
  {
    // Chromium writes H.264 here; the command line writes VP9 in MP4, the app's own MP4
    // fallback. Only the container and the frames against the source are compared.
    id: 'sagittal-mp4',
    example: 't1-brain',
    parameters: { orientation: 'sagittal', format: 'mp4', fps: 20, start: 40, end: 120, step: 5 },
  },
];

export const EXAMPLES_URL = new URL('../../../apps/mri2vid/examples.json', import.meta.url);

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** A recorded video downloaded into the temporary cache and verified on every use. */
export async function referenceVideo(entry) {
  if (!/^https:\/\/huggingface\.co\/datasets\/neurodeskorg\/webapps\/resolve\/[a-f0-9]{40}\//.test(entry.url ?? '')) {
    throw new Error('Every browser reference video needs an immutable Hugging Face URL.');
  }
  const path = join(tmpdir(), 'neurodesk-mri2vid-reference', entry.sha256);
  const verified = bytes => bytes.length === entry.bytes && sha256(bytes) === entry.sha256;
  const cached = await readFile(path).catch(() => null);
  if (cached && verified(cached)) return cached;
  const response = await fetch(entry.url);
  if (!response.ok) throw new Error(`${entry.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verified(bytes)) throw new Error(`${entry.url}: reference video failed checksum verification`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, bytes);
  return bytes;
}

/** The example's files, downloaded once into the temporary directory and checked against their pins. */
export async function exampleFile(exampleId) {
  const examples = JSON.parse(await readFile(EXAMPLES_URL, 'utf8'));
  const example = examples.find(({ id }) => id === exampleId);
  if (!example) throw new Error(`apps/mri2vid/examples.json has no example ${exampleId}`);
  const [file] = example.files;
  if (!file.sha256) throw new Error(`${file.name} has no sha256 pin in apps/mri2vid/examples.json`);
  const path = join(tmpdir(), 'neurodesk-mri2vid-validation', file.sha256, file.name);
  const cached = await readFile(path).catch(() => null);
  if (cached && sha256(cached) === file.sha256) return path;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.url}: SHA-256 differs from its pin`);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(`${path}.partial`, bytes);
  await rename(`${path}.partial`, path);
  return path;
}

/** `upscale` is `--upscale`; `colorNormalize` is `--color-normalize`. */
export const optionName = (parameter) => parameter.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/** Command-line arguments for a case's parameters. */
export function caseArguments(parameters) {
  return Object.entries(parameters).flatMap(([key, value]) => {
    if (value === true) return [`--${optionName(key)}`];
    if (value === false) return [];
    return [`--${optionName(key)}`, String(value)];
  });
}
