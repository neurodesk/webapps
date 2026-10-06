#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { PARAMETERS, checkInstallation, detect, optionName } from '../src/node.js';

const settingsHelp = Object.entries(PARAMETERS).map(([key, field]) => {
  const flag = `  --${optionName(key)} N`.padEnd(28);
  const fallback = field.default === undefined ? '' : ` Default ${field.default}.`;
  return `${flag}${field.description}${fallback}`;
}).join('\n');

const HELP = `Usage: carotid-flow SERIES.nii[.gz] OUTPUT_DIR [options]
       carotid-flow AMPLITUDE.nii[.gz] PHASE.nii[.gz] OUTPUT_DIR [options]
       carotid-flow self-check

Finds both carotid arteries in one retrospectively gated phase-contrast slice
through the neck and writes their flow curves. SERIES holds the amplitude frames
followed by the same number of phase frames; otherwise give the amplitude and
phase series as two files, amplitude first.

Signed velocity gives flow in ml/min. Raw phase (±4096 or 0–4095) needs --venc.
An unsigned speed image goes through the variability method and gives
intensity curves; the geometry settings apply only to that method.

Settings:
${settingsHelp}
  -h, --help                Show this help

Writes the web app's downloads, named after SERIES or AMPLITUDE:
<name>_carotid_labels.nii (1 = left, 2 = right), <name>_phase_sd.nii and
<name>_carotid_curves.csv. OUTPUT_DIR must be new or empty. NIfTI input only:
convert DICOM with dcm2niix first, or use the Carotid Flow web app.

Carotid Flow has no model files. "download-models [--cache-dir DIR]" exists for
the portable packager and installs nothing.`;

const options = Object.fromEntries(Object.keys(PARAMETERS).map((key) => [optionName(key), { type: 'string' }]));

function summary({ method, vessels, qc }) {
  const { left, right } = vessels;
  if (method === 'velocity') {
    return `Both carotids found · left ${Math.round(left.mean)} ml/min, right ${Math.round(right.mean)} ml/min · systolic peak at frame ${right.peakFrame + 1}`;
  }
  const review = qc.flag ? ' · review the flagged pair' : '';
  return `Both carotids found · left ${left.pixelCount} px, right ${right.pixelCount} px · tilt ${qc.tiltDegrees.toFixed(1)} degrees${review}`;
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, 'cache-dir': { type: 'string' }, ...options },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log(`0 model files: Carotid Flow has nothing to install in ${resolve(values['cache-dir'] ?? '.')}`);
  } else {
    if (positionals.length < 2 || positionals.length > 3) {
      throw new Error('Give one combined series, or an amplitude and a phase series, and a new output directory. Use --help for options.');
    }
    const parameters = Object.fromEntries(Object.keys(PARAMETERS).map((key) => [key, values[optionName(key)]]));
    const result = await detect({
      inputs: positionals.slice(0, -1),
      output: positionals.at(-1),
      parameters,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    process.stderr.write(`${summary(result.measurements)}\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
