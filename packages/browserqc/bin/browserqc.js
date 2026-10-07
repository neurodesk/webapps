#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { checkInstallation, downloadModels, runQc } from '../src/node.js';
import { DEFAULT_MODEL, MODELS } from '../src/pipeline.js';

const HELP = `Usage: browserqc INPUT.nii[.gz] OUTPUT_DIR [options]
       browserqc download-models [--cache-dir DIR]
       browserqc self-check

Computes MRIQC-style image-quality metrics of one T1-weighted NIfTI image, as
the BrowserQC web app does: a MindGrab brain mask and segmentation on the CPU,
then niimath --qc with the pinned MNI air template. Writes the web app's
downloads to OUTPUT_DIR:

  qc.json          niimath's QC report with BrowserQC's provenance
  brain-mask.nii   MindGrab brain mask
  csf.nii gm.nii wm.nii   tissue fractions (mindmap-pve)
  labels.nii       label map (16chan18cls, mindmap, mindsnap)

Options:
  --model NAME      ${Object.keys(MODELS).join(', ')} (default ${DEFAULT_MODEL})
  --bids FILE       BIDS JSON sidecar to embed in the report as bids_meta
  --cache-dir DIR   Air template directory (default NEURODESK_BROWSERQC_MODEL_DIR or
                    ~/.cache/neurodesk/browserqc/<release>)
  --offline         Never download; fail if the air template is missing
  -h, --help        Show this help

OUTPUT_DIR must be new or empty. The air template downloads once and is SHA-256
checked on every load; the MindGrab models are part of the release. Progress
goes to standard error and the written files to standard output.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      model: { type: 'string' },
      bids: { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  const progress = (message) => process.stderr.write(`${message}\n`);
  if (values.help || !command) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    const models = await downloadModels({ cacheDir: values['cache-dir'], offline: values.offline, onProgress: progress });
    console.log(`${models.count} model file verified in ${models.directory}`);
  } else {
    if (positionals.length !== 2) throw new Error('Provide an input image and a new output directory. Use --help for options.');
    const result = await runQc({
      input: positionals[0],
      output: positionals[1],
      model: values.model,
      bids: values.bids,
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress: progress,
    });
    progress(`BrowserQC finished in ${result.seconds.toFixed(1)} s`);
    for (const name of result.files) console.log(join(result.output, name));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
