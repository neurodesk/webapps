#!/usr/bin/env node
import { parseArgs } from 'node:util';

// ONNX Runtime otherwise writes telemetry state under the user's home directory.
// It reads the variable when its library loads, so node.js is imported afterwards.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, segment } = await import('../src/node.js');

const HELP = `Usage: bison --t1 T1.nii[.gz] [--flair FLAIR.nii[.gz]] --output DIR [options]
       bison download-models [--asset-dir DIR] [--cache-dir DIR]
       bison self-check

Segments brain tissue with BISON on the CPU. A T1 alone gives 8 classes
(ventricles, CSF, cerebellar GM and WM, brainstem, deep GM, cortical GM, WM);
with a FLAIR, BISON-WMH adds white matter hyperintensities. Writes
T1_bison-labels.nii.gz, one T1_bison-prob-<class>.nii.gz per class and
T1_bison-mask.nii.gz, on the T1 grid, the same files as the web app.

Options:
  --t1 FILE         T1-weighted image, about 1 mm (required)
  --flair FILE      FLAIR image of the same session (adds WMH)
  --output DIR      New or empty output directory (required)
  --threads N       ONNX Runtime threads (default SLURM_CPUS_PER_TASK or all cores)
  --asset-dir DIR   Read the model files from DIR (default BISON_ASSET_DIR)
  --cache-dir DIR   Model cache (default NEURODESK_BISON_MODEL_DIR, else
                    ~/.cache/neurodesk/bison/<model set>)
  --offline         Never download; fail if a model file is missing
                    (default when NEURODESK_OFFLINE=1)
  -h, --help        Show this help

Each run takes about 15 to 20 minutes and 3 GB of memory. Model files are
SHA-256 checked on every load. DICOM input is not supported.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      t1: { type: 'string' },
      flair: { type: 'string' },
      output: { type: 'string' },
      threads: { type: 'string' },
      'asset-dir': { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  let previous;
  const onProgress = (message) => {
    if (message && message !== previous) process.stderr.write(`${message}\n`);
    previous = message;
  };
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    const models = await downloadModels({ assetDir: values['asset-dir'], cacheDir: values['cache-dir'], offline: values.offline, onProgress });
    console.log(`${models.count} model files verified in ${models.directory}`);
  } else {
    if (positionals.length) throw new Error(`Unknown command "${command}". Use --help for usage.`);
    if (!values.t1 || !values.output) throw new Error('Give --t1 and --output. Use --help for options.');
    const result = await segment({
      t1: values.t1,
      flair: values.flair ?? null,
      output: values.output,
      threads: values.threads,
      assetDir: values['asset-dir'],
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress,
    });
    console.log(JSON.stringify({ output: result.output, mode: result.mode, files: result.files, volumes: result.volumes }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
