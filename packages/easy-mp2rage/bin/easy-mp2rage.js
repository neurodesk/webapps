#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { MP2RAGE_PARAMETERS, SA2RAGE_PARAMETERS, checkInstallation, correct, denoise, parseAcquisition } from '../src/node.js';

const HELP = `Usage: easy-mp2rage correct --uni UNI --mp2rage LIST (--b1 B1 --b1-type TYPE | --sa2rage SA2RAGE --sa2rage-params LIST) [options] OUTPUT_DIR
       easy-mp2rage denoise --uni UNI --inv1 INV1 --inv2 INV2 [--regularization N] OUTPUT_DIR
       easy-mp2rage self-check
       easy-mp2rage download-models [--cache-dir DIR]

correct writes a B1-corrected T1 map (T1map.nii.gz, ms), the B1 map, the
uncorrected T1 map, the B1-corrected UNI and parameters.json.
denoise writes UNI_denoised.nii.gz (O'Brien robust combination) and parameters.json.
Both run the same WebAssembly core as the Easy MP2RAGE web app, on the CPU.

correct options:
  --uni FILE                MP2RAGE UNI image (required)
  --inv2 FILE               Second inversion image for the brain mask (default: mask from UNI)
  --b1 FILE                 Measured B1 map; supply this or --sa2rage
  --b1-type TYPE            B1 map units: tfl, percent or relative (required with --b1)
  --reference-angle DEG     Reference flip angle of a tfl B1 map (default 80)
  --extend-fov              Extend B1 coverage beyond the measured field of view
  --sa2rage FILE            Two-volume SA2RAGE image; supply this or --b1
  --sa2rage-params LIST     ${SA2RAGE_PARAMETERS.join(',')}
                            (seconds and degrees; required with --sa2rage)
  --mp2rage LIST            ${MP2RAGE_PARAMETERS.join(',')}
                            (seconds and degrees; required)
  --fallback-uncorrected    Fill non-converged voxels with uncorrected values

denoise options:
  --uni, --inv1, --inv2 FILE  UNI and both inversion images (required, same grid)
  --regularization N          Robust-combination strength, at least 1 (default 6)

Inputs are NIfTI (.nii or .nii.gz). Convert DICOM with dcm2niix first, or use the
web app, which also reads parameters from DICOM headers and BIDS sidecars.
OUTPUT_DIR must be new or empty. download-models does nothing: the WebAssembly
core is part of the installation and no model files are needed.

Example (the web app's 7 T example with a relative B1 map):
  easy-mp2rage correct --uni MP2RAGE_UNI.nii.gz --inv2 MP2RAGE_INV2.nii.gz \\
    --b1 B1map_relative.nii.gz --b1-type relative \\
    --mp2rage 6,0.8,2.7,4,5,35,72,0.0067,0.96 results`;

const OPTIONS = {
  help: { type: 'boolean', short: 'h' },
  uni: { type: 'string' },
  inv1: { type: 'string' },
  inv2: { type: 'string' },
  b1: { type: 'string' },
  'b1-type': { type: 'string' },
  'reference-angle': { type: 'string' },
  'extend-fov': { type: 'boolean' },
  sa2rage: { type: 'string' },
  'sa2rage-params': { type: 'string' },
  mp2rage: { type: 'string' },
  'fallback-uncorrected': { type: 'boolean' },
  regularization: { type: 'string' },
  'cache-dir': { type: 'string' },
};

const ALLOWED = {
  correct: ['uni', 'inv2', 'b1', 'b1-type', 'reference-angle', 'extend-fov', 'sa2rage', 'sa2rage-params', 'mp2rage', 'fallback-uncorrected'],
  denoise: ['uni', 'inv1', 'inv2', 'regularization'],
  'self-check': [],
  'download-models': ['cache-dir'],
};

function number(text, option) {
  const value = Number(text);
  if (text === undefined || text.trim() === '' || !Number.isFinite(value)) throw new Error(`${option} must be a number, not "${text}".`);
  return value;
}

try {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: OPTIONS });
  const [command, ...rest] = positionals;
  if (values.help || !command) {
    console.log(HELP);
  } else {
    if (!Object.hasOwn(ALLOWED, command)) throw new Error(`Unknown command "${command}". Use --help for usage.`);
    const unexpected = Object.keys(values).filter((option) => !ALLOWED[command].includes(option));
    if (unexpected.length) throw new Error(`${command} does not accept --${unexpected.join(', --')}.`);
    if (command === 'self-check') {
      if (rest.length) throw new Error('self-check does not accept arguments.');
      console.log(JSON.stringify(checkInstallation()));
    } else if (command === 'download-models') {
      if (rest.length) throw new Error('download-models does not accept positional arguments.');
      console.log('easy-mp2rage needs no model files; nothing to download.');
    } else {
      if (rest.length !== 1) throw new Error(`Provide one output directory after the ${command} options. Use --help for usage.`);
      const [output] = rest;
      const result = command === 'correct'
        ? await correct({
          uni: values.uni,
          inv2: values.inv2,
          b1: values.b1,
          sa2rage: values.sa2rage,
          mp2rage: values.mp2rage === undefined ? undefined : parseAcquisition(values.mp2rage, MP2RAGE_PARAMETERS, '--mp2rage'),
          sa2rageParameters: values['sa2rage-params'] === undefined ? undefined : parseAcquisition(values['sa2rage-params'], SA2RAGE_PARAMETERS, '--sa2rage-params'),
          b1Type: values['b1-type'],
          referenceAngle: values['reference-angle'] === undefined ? undefined : number(values['reference-angle'], '--reference-angle'),
          extendFov: values['extend-fov'] ?? false,
          fallbackUncorrected: values['fallback-uncorrected'] ?? false,
          output,
        })
        : await denoise({
          uni: values.uni,
          inv1: values.inv1,
          inv2: values.inv2,
          regularization: values.regularization === undefined ? undefined : number(values.regularization, '--regularization'),
          output,
        });
      for (const file of result.files) process.stderr.write(`wrote ${file}\n`);
      console.log(result.output);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
