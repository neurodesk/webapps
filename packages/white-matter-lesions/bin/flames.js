#!/usr/bin/env node
import { parseArgs } from 'node:util';

// ONNX Runtime otherwise writes telemetry state under the user's home directory.
// It reads the variable when its library loads, so node.js is imported afterwards.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, segment } = await import('../src/node.js');

const HELP = `Usage: flames INPUT.nii[.gz] OUTPUT_DIR [options]
       flames download-models [--cache-dir DIR]
       flames self-check

Segments white matter lesions on one FLAIR NIfTI image with FLAMeS, on the CPU.
Writes INPUT_lesions.nii (mask), INPUT_lesion_probability.nii and
INPUT_lesions.tsv (one row per 26-connected lesion), on the input grid.

Options:
  --folds N         1 (default, fold 0) or 5 (the published five-fold ensemble)
  --skull-stripped  Use nonzero input voxels as the brain mask instead of SynthStrip
  --threads N       ONNX Runtime threads (default SLURM_CPUS_PER_TASK or all cores)
  --cache-dir DIR   Model directory (default NEURODESK_FLAMES_MODEL_DIR or
                    ~/.cache/neurodesk/flames/<model set>)
  --offline         Never download; fail if a model file is missing
  -h, --help        Show this help

OUTPUT_DIR must be new or empty. Models download once and are SHA-256 checked
on every load. DICOM input and mask editing are available in the web app only.`;

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
      folds: { type: 'string' },
      'skull-stripped': { type: 'boolean' },
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
    const result = await segment({
      input: positionals[0],
      output: positionals[1],
      folds: values.folds,
      skullStripped: values['skull-stripped'],
      threads: values.threads,
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress: reportProgress(),
    });
    console.log(JSON.stringify(result));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
