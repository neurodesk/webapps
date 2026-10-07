#!/usr/bin/env node
import { parseArgs } from 'node:util';

// ONNX Runtime's Linux build otherwise writes a telemetry device ID under ~/.cache/Microsoft.
// It reads the variable when its library loads, so node.js is imported afterwards.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, extract } = await import('../src/node.js');

const HELP = `Usage: brain-extraction INPUT.nii[.gz] OUTPUT_DIR [options]
       brain-extraction download-models [--cache-dir DIR]
       brain-extraction self-check

Extracts the brain from one head NIfTI image on the CPU. Writes
INPUT_METHOD_brain.nii and INPUT_METHOD_mask.nii on the input grid, the files
the brain extraction web app downloads.

Options:
  --method NAME                synthstrip (default) or bet. mindgrab is not
                               available in the command line yet.
  --fractional-intensity F     BET threshold from 0 to 1 (default 0.5); lower
                               values give larger masks
  --threads N                  SynthStrip ONNX Runtime threads (default
                               SLURM_CPUS_PER_TASK or all cores)
  --cache-dir DIR              Model directory (default
                               NEURODESK_BRAIN_EXTRACTION_MODEL_DIR or
                               ~/.cache/neurodesk/brain-extraction/<model set>)
  --offline                    Never download; fail if the model is missing
  -h, --help                   Show this help

OUTPUT_DIR must be new or empty. The SynthStrip model downloads once and is
SHA-256 checked on every load. BET needs no model. DICOM input and mask
editing are available in the web app only.`;

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
      method: { type: 'string' },
      'fractional-intensity': { type: 'string' },
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
    const result = await extract({
      input: positionals[0],
      output: positionals[1],
      method: values.method,
      fractionalIntensity: values['fractional-intensity'],
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
