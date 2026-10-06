import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { operationParametersSchema } from '@neurodesk/webapp-components/automation/parameters';
import packageJson from '../package.json' with { type: 'json' };
import { detectCarotids, rawPhaseRange } from './carotid.js';
import { curvesTable, labelImages, measurements, variabilityImage } from './outputs.js';
import PARAMETERS from './parameters.json' with { type: 'json' };
import { tiltedPhantom } from './phantom.js';
import { readSeries } from './series.js';

export { PARAMETERS };

const SCHEMA = operationParametersSchema(PARAMETERS);

/** `minSeparation` is `--min-separation` on the command line. */
export const optionName = (parameter) => parameter.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * Detection settings from command-line strings or numbers, checked against the same schema as
 * the web app's automation operations, with their defaults filled in.
 */
export function parseParameters(values = {}) {
  const numbers = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(PARAMETERS, key)) throw new Error(`Unknown setting ${key}.`);
    const number = typeof value === 'string' && value.trim() ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) throw new Error(`--${optionName(key)} must be a number, not "${value}".`);
    numbers[key] = number;
  }
  const parsed = SCHEMA.safeParse(numbers);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const field = PARAMETERS[issue.path[0]];
  const range = field ? ` (${field.minimum} to ${field.maximum}${field.multipleOf ? `, in steps of ${field.multipleOf}` : ''})` : '';
  throw new Error(`--${optionName(String(issue.path[0]))}: ${issue.message}${range}.`);
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    throw error;
  }
  if (entries.length) throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
}

async function writeAtomically(path, bytes) {
  const partial = `${path}.${randomUUID()}.partial`;
  try {
    await writeFile(partial, bytes, { flag: 'wx' });
    await rename(partial, path);
  } catch (error) {
    await rm(partial, { force: true });
    throw error;
  }
}

const inputFile = async (path) => new File([await readFile(path)], basename(path));

/**
 * Detect both carotids and write the web app's downloads: the label map, the temporal SD and
 * the curves CSV. `inputs` is one combined series (amplitude frames then phase frames) or an
 * amplitude and a phase file, in that order.
 */
export async function detect({ inputs, output, parameters = {}, onProgress = () => {} } = {}) {
  if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 2 || !output) {
    throw new Error('Give one combined series, or an amplitude and a phase series, and a new output directory.');
  }
  const settings = parseParameters(parameters);
  const destination = resolve(output);
  await assertNewOutput(destination);
  onProgress('Reading the phase-contrast series');
  const files = await Promise.all(inputs.map(inputFile));
  const series = await readSeries(files.length === 1 ? { combined: files[0] } : { amplitude: files[0], phase: files[1] });
  const rawRange = rawPhaseRange(series.phase);
  if (rawRange && settings.venc === undefined) {
    throw new Error(`This phase series is stored as raw phase (${rawRange}). Give its velocity encoding in cm/s with --venc.`);
  }
  onProgress('Detecting carotids');
  const found = detectCarotids(series, settings);
  const images = labelImages(found.mask, series);
  const variability = variabilityImage(found, series);
  const curves = curvesTable(found, series);
  const written = [
    { name: images.mask.name, bytes: new Uint8Array(images.mask.bytes) },
    { name: variability.name, bytes: new Uint8Array(variability.bytes) },
    { name: curves.name, bytes: Buffer.from(curves.text, 'utf8') },
  ];
  await mkdir(destination, { recursive: true });
  for (const file of written) await writeAtomically(join(destination, file.name), file.bytes);
  return { output: destination, files: written.map((file) => file.name), measurements: measurements(found) };
}

/** Runs the whole detection on the built-in tilted phantom inside this runtime. */
export function checkInstallation() {
  const found = detectCarotids(tiltedPhantom(), { candidatePercentile: 97 });
  const tilt = found.qc.tiltDegrees;
  if (found.qc.flag || Math.abs(tilt - 20) > 2 || found.left.centroid[1] >= 32 || found.right.centroid[1] <= 32) {
    throw new Error(`Carotid detection failed its phantom check (tilt ${tilt} degrees).`);
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    carotidFlow: packageJson.version,
    phantom: { method: found.method, tiltDegrees: tilt },
  };
}
