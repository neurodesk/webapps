#!/usr/bin/env node
import { parseArgs } from 'node:util';

// ONNX Runtime otherwise writes telemetry state under the user's home directory.
// It reads the variable when its library loads, so node.js is imported afterwards.
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, segment } = await import('../src/node.js');

const HELP = `Usage: totalsegmentator INPUT.nii[.gz] OUTPUT_DIR [options]
       totalsegmentator download-models [--task NAME] [--resolution MODE] [--subset GROUP] [--cache-dir DIR] [--offline]
       totalsegmentator self-check [--cache-dir DIR]

Segments anatomical structures in 3D CT and MRI NIfTI scans using openly licensed
Apache-2.0 TotalSegmentator v2 (nnU-Net v2) models on the CPU.
Writes INPUT_totalseg_<task>.nii.gz (uint8 multilabel mask in input geometry) and
INPUT_totalseg_<task>_stats.tsv (per-structure volumes and intensities).

Options:
  --task NAME        total (CT, 117 classes, default), total_mr (MRI, 50 classes),
                     vertebrae_mr (MRI, 25 classes), or abdominal_muscles (CT, 22 classes)
  --resolution MODE  fast (3 mm single model, default for total/total_mr) or full (1.5 mm)
  --subset GROUP     all (default), organs, vertebrae, cardiac, muscles, or ribs
                     (full resolution on total; all, organs, or muscles on total_mr)
  --threads N        ONNX Runtime threads (default SLURM_CPUS_PER_TASK or all cores)
  --cache-dir DIR    Model directory (default NEURODESK_TOTALSEGMENTATOR_MODEL_DIR or
                     ~/.cache/neurodesk/totalsegmentator/<model set>)
  --offline          Never download; fail if a model file is missing
  -h, --help         Show this help

OUTPUT_DIR must be new or empty. Models download once and are SHA-256 checked
on every load. DICOM import and mask editing are available in the web app.`;

const reportProgress = () => {
  let previous;
  return (fraction, message) => {
    if (!message || message === previous) return;
    previous = message;
    const percent = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}%`.padStart(4) : '    ';
    process.stderr.write(`${percent} ${message}\n`);
  };
};

function rejectDisallowedOptions(subcommand, values, allowed) {
  const disallowed = Object.keys(values).filter((key) => values[key] !== undefined && !allowed.includes(key));
  if (disallowed.length) {
    const flags = disallowed.map((key) => `--${key}`).join(', ');
    throw new Error(`${subcommand} does not accept option${disallowed.length > 1 ? 's' : ''}: ${flags}.`);
  }
}

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      task: { type: 'string' },
      resolution: { type: 'string' },
      subset: { type: 'string' },
      threads: { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept positional arguments.');
    rejectDisallowedOptions('self-check', values, ['cache-dir']);
    console.log(JSON.stringify(await checkInstallation({ cacheDir: values['cache-dir'] })));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    rejectDisallowedOptions('download-models', values, ['task', 'resolution', 'subset', 'cache-dir', 'offline']);
    const onProgress = reportProgress();
    const models = await downloadModels({
      task: values.task ?? null,
      resolution: values.resolution,
      subset: values.subset,
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
      task: values.task,
      resolution: values.resolution,
      subset: values.subset,
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
