#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PARAMETERS, checkInstallation, createBrainMesh, optionName } from '../src/node.js';

const settingsHelp = Object.entries(PARAMETERS).map(([key, field]) => {
  const value = field.enum ? ` ${field.enum.join('|')}` : field.type === 'boolean' ? '' : ' N';
  const flag = `  --${field.type === 'boolean' ? `[no-]${optionName(key)}` : optionName(key)}${value}`.padEnd(44);
  const range = field.minimum === undefined ? '' : ` ${field.minimum} to ${field.maximum}.`;
  return `${flag}${field.description}.${range} Default ${field.default}.`;
}).join('\n');

const HELP = `Usage: brain2print IMAGE.nii[.gz] OUTPUT_DIR [options]
       brain2print self-check

Segments a T1-weighted brain MRI with MindGrab on the CPU, meshes it with niimath
and writes a printable surface. The default model, pve, is MindMap's grey plus
white matter fraction meshed at 0.5, a sub-voxel surface; the other models are
label maps whose 0/1 brain mask is meshed. The mesh is checked for a closed,
consistently wound manifold and its winding is flipped when its normals face
inward, whatever the image's handedness.

Settings:
${settingsHelp}
  -h, --help                                Show this help

Writes the web app's downloads: brain-fraction.nii (pve) or segmentation.nii,
brain2print.stl and brain2print.mz3. OUTPUT_DIR must be new or empty. Prints a
JSON report with the mesh checks and provenance. NIfTI input only: convert
DICOM with dcm2niix first, or use the Brain2Print web app.

MindGrab's weights are compiled into its WebAssembly modules, so there are no
model files. "download-models [--cache-dir DIR]" exists for the portable
packager and installs nothing.`;

const options = Object.fromEntries(Object.entries(PARAMETERS).map(([key, field]) => [optionName(key), { type: field.type === 'boolean' ? 'boolean' : 'string' }]));

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    allowNegative: true,
    options: { help: { type: 'boolean', short: 'h' }, 'cache-dir': { type: 'string' }, ...options },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  const given = Object.keys(PARAMETERS).filter((key) => values[optionName(key)] !== undefined);
  if (['self-check', 'download-models'].includes(command) && given.length) throw new Error(`--${optionName(given[0])} does not apply to ${command}.`);
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log(`0 model files: MindGrab's weights are inside its WebAssembly, so nothing is installed in ${resolve(values['cache-dir'] ?? '.')}`);
  } else {
    if (positionals.length !== 2) throw new Error('Give one NIfTI image and a new output directory. Use --help for options.');
    const parameters = Object.fromEntries(Object.keys(PARAMETERS).map((key) => [key, values[optionName(key)]]));
    const result = await createBrainMesh({
      input: positionals[0],
      output: positionals[1],
      parameters,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    const { triangles, manifold, consistent, windingCorrected } = result.measurements;
    process.stderr.write(`Mesh complete: ${triangles} triangles, ${manifold && consistent ? 'closed manifold' : 'non-manifold'}, ${windingCorrected ? 'winding corrected' : 'winding preserved'}\n`);
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
