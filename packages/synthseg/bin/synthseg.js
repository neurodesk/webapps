#!/usr/bin/env node
import { parseArgs } from 'node:util';

// ONNX Runtime's Linux build otherwise writes a telemetry device ID under ~/.cache/Microsoft.
// It reads the variable when its library loads, so node.js is imported afterwards.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, segment } = await import('../src/node.js');

const HELP = `Usage: synthseg INPUT.nii[.gz] OUTPUT_DIR [options]
       synthseg download-models [--cache-dir DIR]
       synthseg self-check

Segments one head image into FreeSurfer labels with SynthSeg 2.0 on the CPU.
Writes INPUT_synthseg.nii.gz (labels on a 1 mm grid) and INPUT_synthseg.json
(parameters, provenance and label volumes), as the web app's downloads.

Options:
  --mode MODE       default (flip averaging and topology postprocessing) or fast
  --ct, --no-ct     Treat the input as CT in Hounsfield units, or as MRI.
                    Without either, CT is assumed when any voxel is negative.
  --threads N       ONNX Runtime threads (default SLURM_CPUS_PER_TASK or all cores)
  --cache-dir DIR   Model directory (default NEURODESK_SYNTHSEG_MODEL_DIR or
                    ~/.cache/neurodesk/synthseg/<model digest>)
  --offline         Never download; fail if the model is missing
  -h, --help        Show this help

Memory: a 1 mm adult head peaks at about 6 GB in the default mode and 4.5 GB
with --mode fast; a larger field of view needs more.

OUTPUT_DIR must be new or empty. The model downloads once and is SHA-256
checked on every load. DICOM input and label editing need the web app.`;

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
    allowNegative: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      mode: { type: 'string' },
      ct: { type: 'boolean' },
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
    console.log(`${models.count} model file verified in ${models.directory}`);
  } else {
    if (positionals.length !== 2) throw new Error('Provide an input image and a new output directory. Use --help for options.');
    const result = await segment({
      input: positionals[0],
      output: positionals[1],
      mode: values.mode,
      ct: values.ct,
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
