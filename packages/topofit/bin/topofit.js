#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { checkInstallation, downloadModels, reconstruct } from '../src/node.js';

const HELP = `Usage: topofit INPUT.nii[.gz] OUTPUT_DIR [options]
       topofit download-models [--cache-dir DIR]
       topofit self-check

Reconstructs white, mid, pial and registration surfaces for both hemispheres
from one T1-weighted NIfTI image, on the CPU.

Options:
  --model NAME      Model preset (default t1w-1mm, the only validated preset)
  --no-conform      Refuse inputs that are not already on a 1 mm RAS grid
                    instead of resampling them with the cubic conformer
  --threads N       ONNX Runtime threads (default SLURM_CPUS_PER_TASK or all cores)
  --cache-dir DIR   Model directory (default NEURODESK_TOPOFIT_MODEL_DIR or
                    ~/.cache/neurodesk/topofit/<release>)
  --offline         Never download; fail if a model file is missing
  -h, --help        Show this help

OUTPUT_DIR must be new or empty. Models download once and are SHA-256 checked
on every load. Surface normals, patch analysis, ROI masks and DICOM input are
available in the TopoFit web app only.`;

const reportProgress = () => {
  let previous;
  return (fraction, message) => {
    if (!message || message === previous) return;
    previous = message;
    const percent = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%`.padStart(4) : '    ';
    process.stderr.write(`${percent} ${message}\n`);
  };
};

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      model: { type: 'string' },
      'no-conform': { type: 'boolean' },
      threads: { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    const onProgress = reportProgress();
    const models = await downloadModels({
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress: (message) => onProgress(undefined, message),
    });
    console.log(`${models.count} model files verified in ${models.directory}`);
  } else {
    if (positionals.length !== 2) throw new Error('Provide an input image and a new output directory. Use --help for options.');
    const result = await reconstruct({
      input: positionals[0],
      output: positionals[1],
      model: values.model,
      conform: !values['no-conform'],
      threads: values.threads,
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress: reportProgress(),
    });
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
