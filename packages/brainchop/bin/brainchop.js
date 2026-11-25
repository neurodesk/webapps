#!/usr/bin/env node
import { parseArgs } from 'node:util';

const HELP = `Usage: brainchop INPUT.nii[.gz] OUTPUT_DIR [options]
       brainchop download-models [--cache-dir PATH]
       brainchop self-check

Whole-brain T1-weighted MRI segmentation and GM/WM/CSF tissue fraction maps
using @brainchop/core's threaded CPU WebAssembly runtime.

Options:
  --model mindmap|mindmap-fast|mindsnap|tissue-fractions
      Segmentation model (default: mindmap)
        mindmap           18-class cortical and subcortical (MindMap-24)
        mindmap-fast      18-class fast preview (MindMap-16)
        mindsnap          104-region Desikan-Killiany atlas (MindSnap-104)
        tissue-fractions  Continuous GM, WM, CSF and brain fraction maps
  --save-conform
      Write outputs on the conformed 256^3 1 mm grid instead of input space
  --no-turbo
      Disable turbo mode in @brainchop/core
  --legacy-cleanup
      Apply legacy label cleanup (label models only)
  --threads N
      CPU WebAssembly thread count (1..64)
  --overwrite
      Allow writing into a non-empty output directory
  --cache-dir PATH
      Accepted for download-models (weights are embedded in @brainchop/core)
  --offline
      Accepted for offline CLI compatibility (no network access is used)
  -h, --help
      Show this help`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      model: { type: 'string' },
      'save-conform': { type: 'boolean' },
      'no-turbo': { type: 'boolean' },
      'legacy-cleanup': { type: 'boolean' },
      threads: { type: 'string' },
      overwrite: { type: 'boolean' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const { checkInstallation, downloadModels, segment } = await import('../src/node.js');
  let report;
  if (positionals.length === 1 && positionals[0] === 'self-check') {
    report = await checkInstallation();
  } else if (positionals.length === 1 && positionals[0] === 'download-models') {
    report = await downloadModels({ cacheDir: values['cache-dir'] });
  } else {
    if (positionals.length !== 2) {
      throw new Error('Provide an input T1-weighted MRI NIfTI image and an output directory. Use --help for options.');
    }
    report = await segment({
      input: positionals[0],
      output: positionals[1],
      ...(values.model !== undefined ? { model: values.model } : {}),
      ...(values['save-conform'] ? { saveConform: true } : {}),
      ...(values['no-turbo'] ? { noTurbo: true } : {}),
      ...(values['legacy-cleanup'] ? { legacyCleanup: true } : {}),
      ...(values.threads !== undefined ? { threads: Number(values.threads) } : {}),
      ...(values.overwrite ? { overwrite: true } : {}),
      onProgress: (text) => console.error(text),
    });
  }

  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
