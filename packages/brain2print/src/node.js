import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { loadMindgrabCpu } from '@neurodesk/runtime-support/node/mindgrab';
import { runNiimath } from '@neurodesk/runtime-support/node/niimath';
import { operationParametersSchema } from '@neurodesk/webapp-components/automation/parameters';
import createNiimath from '@niivue/niimath/niimath.js';
import packageJson from '../package.json' with { type: 'json' };
import { PARAMETERS, createMesh, meshArgs, orientMesh } from './pipeline.js';

export { PARAMETERS };

const SCHEMA = operationParametersSchema(PARAMETERS);
const NIFTI = /\.nii(\.gz)?$/i;

/** `largestOnly` is `--largest-only` on the command line. */
export const optionName = (parameter) => parameter.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * Settings from command-line values, checked against the same schema as the web app's
 * create-mesh operation, with its defaults filled in. Numbers may arrive as strings.
 */
export function parseParameters(values = {}) {
  const typed = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(PARAMETERS, key)) throw new Error(`Unknown setting ${key}.`);
    const numeric = PARAMETERS[key].type === 'number' || PARAMETERS[key].type === 'integer';
    typed[key] = numeric && typeof value === 'string' && value.trim() ? Number(value) : value;
  }
  const parsed = SCHEMA.safeParse(typed);
  if (parsed.success) return parsed.data;
  const [issue] = parsed.error.issues;
  const key = String(issue.path[0]);
  const field = PARAMETERS[key];
  const allowed = field?.enum ? ` (one of ${field.enum.join(', ')})` : field?.minimum !== undefined ? ` (${field.minimum} to ${field.maximum})` : '';
  throw new Error(`--${optionName(key)}: ${issue.message}${allowed}.`);
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

/** niimath's mesh on the pinned WebAssembly build, as the app's worker runs it. */
export async function niimathMesh(segmentation, options) {
  const argv = ['segmentation.nii', ...meshArgs(options), 'brain.mz3'];
  const { outputs } = await runNiimath(createNiimath, argv, { inputs: { 'segmentation.nii': segmentation }, outputs: ['brain.mz3'] });
  return outputs['brain.mz3'];
}

const loadMindgrab = () => loadMindgrabCpu(import.meta.resolve('@brainchop/mindgrab/package.json'));

/**
 * Segment a NIfTI image with MindGrab on the CPU, mesh it with niimath and write the web app's
 * create-mesh downloads: the brain fraction or label map, brain2print.stl and brain2print.mz3.
 */
export async function createBrainMesh({ input, output, parameters = {}, onProgress = () => {} } = {}) {
  if (!input || !output) throw new Error('An input image and an output directory are required.');
  if (!NIFTI.test(input)) throw new Error(`${input} is not NIfTI (.nii or .nii.gz). Convert DICOM with dcm2niix first, or use the Brain2Print web app.`);
  const settings = parseParameters(parameters);
  const destination = resolve(output);
  await assertNewOutput(destination);
  const bytes = new Uint8Array(await readFile(input));
  const mindgrab = await loadMindgrab();
  const started = performance.now();
  const result = await createMesh({ input: bytes, settings, mindgrab, mesher: niimathMesh, onProgress });
  await mkdir(destination, { recursive: true });
  for (const file of result.files) await writeAtomically(join(destination, file.name), file.bytes);
  return {
    output: destination,
    files: result.files.map((file) => file.name),
    measurements: result.measurements,
    provenance: {
      app: `Brain2Print command line ${packageJson.version}`,
      input: basename(input),
      settings,
      ...result.provenance,
      niimath: packageJson.dependencies['@niivue/niimath'],
      seconds: Math.round((performance.now() - started) / 100) / 10,
    },
  };
}

// A 2 mm float NIfTI-1 of a ball of radius 10 mm. Its sform is RAS, or mirrored in x
// (a negative determinant) when `leftHanded`, which turns niimath's world-space normals inward.
export function ballNifti({ leftHanded = false } = {}) {
  const n = 16;
  const header = new DataView(new ArrayBuffer(352));
  header.setInt32(0, 348, true);
  for (const [offset, value] of [[40, 3], [42, n], [44, n], [46, n], [48, 1], [50, 1], [52, 1], [70, 16], [72, 32], [254, 1]]) {
    header.setInt16(offset, value, true);
  }
  for (const [offset, value] of [[76, 1], [80, 2], [84, 2], [88, 2], [108, 352], [112, 1]]) {
    header.setFloat32(offset, value, true);
  }
  const xRow = leftHanded ? [-2, 0, 0, 15] : [2, 0, 0, -15];
  for (const [row, values] of [[280, xRow], [296, [0, 2, 0, -15]], [312, [0, 0, 2, -15]]]) {
    values.forEach((value, column) => header.setFloat32(row + 4 * column, value, true));
  }
  new Uint8Array(header.buffer).set([0x6e, 0x2b, 0x31, 0], 344);
  const data = new Float32Array(n ** 3);
  for (let z = 0; z < n; z++) {
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) data[x + n * (y + n * z)] = Math.hypot(x - 7.5, y - 7.5, z - 7.5) * 2 < 10 ? 1 : 0;
    }
  }
  const bytes = new Uint8Array(352 + data.byteLength);
  bytes.set(new Uint8Array(header.buffer));
  bytes.set(new Uint8Array(data.buffer), 352);
  return bytes;
}

/**
 * Meshes a right- and a left-handed ball with this runtime's niimath and loads the MindGrab
 * package. Both must come out closed, with outward normals enclosing the ball's volume.
 */
export async function checkInstallation() {
  const mindgrab = await loadMindgrab();
  const expected = (4 / 3) * Math.PI * 10 ** 3;
  const balls = {};
  for (const leftHanded of [false, true]) {
    const mesh = await orientMesh(await niimathMesh(ballNifti({ leftHanded }), { i: 0.5, l: 1, b: 1, r: 1, s: 0 }));
    const { signedVolume, windingCorrected, triangles } = mesh.measurements;
    const name = leftHanded ? 'leftHanded' : 'rightHanded';
    if (!mesh.closed || Math.abs(signedVolume - expected) > 0.15 * expected) {
      throw new Error(`niimath failed its ${name} ball check (closed ${mesh.closed}, signed volume ${signedVolume.toFixed(0)} mm3, expected about ${expected.toFixed(0)}).`);
    }
    balls[name] = { triangles, volumeMm3: Math.round(signedVolume), windingCorrected };
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    brain2print: packageJson.version,
    mindgrab: mindgrab.version,
    models: Object.keys(mindgrab.MODELS),
    balls,
  };
}
