#!/usr/bin/env node
import { parseArgs } from 'node:util';
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, segment, MODEL_KEYS } = await import('../src/node.js');
const HELP = `Usage: musclemap INPUT.nii[.gz] OUTPUT_DIR [options]
       musclemap download-models [--cache-dir DIR] [--offline]
       musclemap self-check

Segments a single 3D image on the CPU. Writes INPUT_segmentation.nii (sparse
labels), INPUT_segmentation_display.nii and musclemap_metrics.csv on the input grid.

Options:
  --model KEY          Checkpoint (default wholebody-v1.4):
                       ${MODEL_KEYS.join(', ')}
  --overlap FRACTION   Sliding-window overlap in [0, 1), default per checkpoint
  --source-chunk-size N Number of source slices, or full (default 17)
  --batch-size N       Inference slice batch: 1 (default), 2, 4 or 8
  --imf METHOD         none (default), kmeans, gmm, dixon, both-kmeans, both-gmm
  --imf-components N   2 (default) or 3, for threshold IMF
  --fat FILE           Dixon fat image, on the input grid
  --water FILE         Dixon water image, on the input grid
  --threads N          CPU threads (default SLURM_CPUS_PER_TASK or up to 4 cores)
  --cache-dir DIR      Model directory (default NEURODESK_MUSCLEMAP_MODEL_DIR or
                       ~/.cache/neurodesk/musclemap/<model set>)
  --offline            Never download; verify models locally
  -h, --help           Show this help

OUTPUT_DIR must be new or empty. All models are SHA-256 checked on every load.
DICOM import, manual editing and segmentation consolidation use the web app.`;
function progressReporter() {
  let previous;
  return (fraction, message) => {
    if (!message || previous === message) return;
    previous = message;
    const percent = Number.isFinite(fraction) ? `${Math.round(100 * fraction)}% ` : '';
    process.stderr.write(`${percent}${message}\n`);
  };
}
try {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    help: { type: 'boolean', short: 'h' },
    model: { type: 'string' }, overlap: { type: 'string' },
    'source-chunk-size': { type: 'string' }, 'batch-size': { type: 'string' },
    imf: { type: 'string' }, 'imf-components': { type: 'string' },
    fat: { type: 'string' }, water: { type: 'string' },
    threads: { type: 'string' }, 'cache-dir': { type: 'string' }, offline: { type: 'boolean' }
  } });
  const seen = new Set();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Repeated option --${token.name}`);
    seen.add(token.name);
  }
  if (values.help) {
    console.log(HELP);
  } else if (positionals[0] === 'self-check') {
    if (positionals.length !== 1 || seen.size) throw new Error('self-check accepts no arguments or options');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (positionals[0] === 'download-models') {
    if (positionals.length !== 1 || [...seen].some(key => !['cache-dir', 'offline'].includes(key))) {
      throw new Error('download-models accepts only --cache-dir and --offline');
    }
    const report = progressReporter();
    console.log(JSON.stringify(await downloadModels({ cacheDir: values['cache-dir'], offline: values.offline,
      onProgress: message => report(undefined, message) })));
  } else {
    if (positionals.length !== 2) throw new Error('Provide an input image and a new output directory; use --help for options');
    console.log(JSON.stringify(await segment({ input: positionals[0], output: positionals[1],
      model: values.model, overlap: values.overlap, sourceChunkSize: values['source-chunk-size'],
      batchSize: values['batch-size'], imfMethod: values.imf, imfComponents: values['imf-components'],
      fat: values.fat, water: values.water, threads: values.threads,
      cacheDir: values['cache-dir'], offline: values.offline, onProgress: progressReporter() })));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
