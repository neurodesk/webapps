// Node runtime entrypoint for @neurodesk/vesselcharter and the portable CLI.
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import packageJson from '../package.json' with { type: 'json' };
import { PARAMETERS, characterizeVesselMask, characterizeVesselNifti, parseParameters } from './index.js';
import { yBifurcationPhantom } from './phantom.js';

export { PARAMETERS, parseParameters };

/** `minSpurLengthMm` -> `--min-spur-length-mm` on the command line. */
export const optionName = (parameter) =>
  parameter.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);

/**
 * Coerces CLI string/boolean flags into typed parameter values and validates via Zod.
 */
export function parseCliParameters(values = {}) {
  const coerced = {};
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      continue;
    }
    const spec = PARAMETERS[key];
    if (!spec) {
      throw new Error(`Unknown setting ${key}.`);
    }
    if (spec.type === 'boolean') {
      if (typeof value === 'boolean') {
        coerced[key] = value;
      } else if (value === 'true' || value === '1') {
        coerced[key] = true;
      } else if (value === 'false' || value === '0') {
        coerced[key] = false;
      } else {
        throw new Error(`--${optionName(key)} must be true or false, not "${value}".`);
      }
    } else {
      const num = typeof value === 'string' && value.trim() ? Number(value) : value;
      if (typeof num !== 'number' || !Number.isFinite(num)) {
        throw new Error(`--${optionName(key)} must be a number, not "${value}".`);
      }
      coerced[key] = num;
    }
  }
  return parseParameters(coerced);
}

async function assertNewOutput(directory) {
  let entries;
  try {
    entries = await readdir(directory);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }
  if (entries.length > 0) {
    throw new Error(`Output directory ${directory} is not empty. Choose a new or empty directory.`);
  }
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

/**
 * Runs full VesselCharter characterisation on a NIfTI vessel mask (and optional
 * same-grid brain/ROI mask) and writes all web app artifacts byte-for-byte.
 */
export async function characterize({
  input,
  brainMask = null,
  output,
  parameters = {},
  onProgress = () => {},
} = {}) {
  if (!input || !output) {
    throw new Error('Give a 3D binary NIfTI vessel mask and a new or empty output directory.');
  }
  const settings = parseCliParameters(parameters);
  const destination = resolve(output);
  await assertNewOutput(destination);

  const vesselBytes = await readFile(resolve(input));
  const brainMaskBytes = brainMask ? await readFile(resolve(brainMask)) : null;

  const { result, artifacts } = await characterizeVesselNifti({
    vesselBytes,
    brainMaskBytes,
    parameters: settings,
    baseName: basename(input),
    onProgress: (_fraction, message) => onProgress(message),
  });

  await mkdir(destination, { recursive: true });
  const written = [];
  for (const artifact of Object.values(artifacts)) {
    await writeAtomically(join(destination, artifact.name), artifact.bytes);
    written.push(artifact.name);
  }

  return {
    output: destination,
    files: written,
    summary: result.summary,
  };
}

/**
 * Self-check executing the full pipeline on the built-in analytical Y-bifurcation phantom.
 */
export function checkInstallation() {
  const phantom = yBifurcationPhantom({ daughterAngleDeg: 90 });
  const out = characterizeVesselMask({
    mask: phantom.mask,
    dims: phantom.dims,
    spatial: phantom.spatial,
    parameters: { minSpurLengthMm: 1.0, smoothIterations: 6 },
  });
  const net = out.summary.network;
  if (net.segmentCount !== 3 || net.bifurcationCount !== 1 || net.endpointCount !== 3) {
    throw new Error(
      `VesselCharter self-check failed topology: got ${net.segmentCount} segments, ${net.bifurcationCount} bifurcations, ${net.endpointCount} endpoints.`,
    );
  }
  const angle = out.junctions[0]?.daughterAngleDeg;
  if (angle === null || Math.abs(angle - 90) > 8) {
    throw new Error(`VesselCharter self-check failed angle recovery: expected ~90 deg, got ${angle}.`);
  }
  return {
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    executable: process.execPath,
    vesselcharter: packageJson.version,
    phantom: {
      segmentCount: net.segmentCount,
      bifurcationCount: net.bifurcationCount,
      daughterAngleDeg: Number(angle.toFixed(2)),
      medianDiameterMm: Number(net.medianDiameterMm.toFixed(3)),
    },
  };
}
