#!/usr/bin/env node
import { parseArgs } from 'node:util';
process.env.ORT_DISABLE_TELEMETRY ??= '1';
const { checkInstallation, downloadModels, segment, MODEL_SEEDS } = await import('../src/node.js');
const HELP = `Usage: seedseg INPUT.nii[.gz] OUTPUT_DIR [options]
       seedseg download-models [--cache-dir DIR] [--offline]
       seedseg self-check

Runs the prostate fiducial-marker ensemble on a single 3D image, on the CPU.
Writes model1.nii through modelN.nii, avgProb.nii and consensus.nii, as in the web app.

Options:
  --ensemble N       First N published models, 1 through 4 (default 4)
  --models SEEDS     Distinct comma-separated seeds: ${MODEL_SEEDS.join(', ')}
                     Use either --models or --ensemble
  --threshold VALUE  Marker probability in [0, 1] (default 0.1)
  --top-n N          Maximum retained components, 1 through 10 (default 3)
  --markers N        Alias of --top-n, matching the automation contract
  --threads N        CPU threads (default SLURM_CPUS_PER_TASK or up to 4 cores)
  --cache-dir DIR    Model directory (default NEURODESK_SEEDSEG_MODEL_DIR or
                     ~/.cache/neurodesk/seedseg/<model set>)
  --offline          Never download; verify models locally
  -h, --help         Show this help

OUTPUT_DIR must be new or empty. Every model is SHA-256 checked on each load.
DICOM input and manual mask editing use the web app.`;
function reportProgress() {
  let previous;
  return (fraction, message) => {
    if (!message || message === previous) return;
    previous = message;
    const prefix = Number.isFinite(fraction) ? `${Math.round(fraction * 100)}% ` : '';
    process.stderr.write(`${prefix}${message}\n`);
  };
}
try {
  const { values, positionals, tokens } = parseArgs({ allowPositionals: true, tokens: true, options: {
    help: { type: 'boolean', short: 'h' }, ensemble: { type: 'string' }, models: { type: 'string' },
    threshold: { type: 'string' }, 'top-n': { type: 'string' }, markers: { type: 'string' },
    threads: { type: 'string' }, 'cache-dir': { type: 'string' }, offline: { type: 'boolean' },
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
    const progress = reportProgress();
    console.log(JSON.stringify(await downloadModels({ cacheDir: values['cache-dir'], offline: values.offline,
      onProgress: message => progress(undefined, message) })));
  } else {
    if (positionals.length !== 2) throw new Error('Provide an input image and a new output directory; use --help for options');
    if (seen.has('markers') && seen.has('top-n')) throw new Error('Choose one of --markers and --top-n.');
    console.log(JSON.stringify(await segment({ input: positionals[0], output: positionals[1],
      models: values.models?.split(',').map(seed => seed.trim()), ensemble: values.ensemble,
      threshold: values.threshold, nMarkers: values['top-n'] ?? values.markers,
      threads: values.threads, cacheDir: values['cache-dir'], offline: values.offline,
      onProgress: reportProgress() })));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
