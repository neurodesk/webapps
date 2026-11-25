#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_OPENING_RADIUS } from '../src/pipeline.js';

const HELP = `Usage: brainchomp INPUT.nii[.gz] OUTPUT_DIR [options]
       brainchomp download-models [--cache-dir PATH]
       brainchomp self-check

Extract a skull-stripped rodent brain image and binary brain mask on the
input voxel grid using brainchomp-lib's threaded CPU WebAssembly runtime.

Options:
  --opening R
      Morphological opening radius in 0.1 mm grid voxels (0..64, default: ${DEFAULT_OPENING_RADIUS})
  --no-fill-holes
      Keep enclosed cavities in the mask instead of filling them as brain
  --threads N
      CPU WebAssembly thread count (1..64)
  --overwrite
      Allow writing into a non-empty output directory
  --cache-dir PATH
      Accepted for download-models (weights are embedded in brainchomp.wasm)
  --offline
      Accepted for offline CLI compatibility (no network access is used)
  -h, --help
      Show this help`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      opening: { type: 'string' },
      'no-fill-holes': { type: 'boolean' },
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

  const { checkInstallation, downloadModels, extract } = await import('../src/node.js');
  let report;
  if (positionals.length === 1 && positionals[0] === 'self-check') {
    report = await checkInstallation();
  } else if (positionals.length === 1 && positionals[0] === 'download-models') {
    report = await downloadModels({ cacheDir: values['cache-dir'] });
  } else {
    if (positionals.length !== 2) {
      throw new Error('Provide an input rodent MRI NIfTI image and an output directory. Use --help for options.');
    }
    report = await extract({
      input: positionals[0],
      output: positionals[1],
      ...(values.opening !== undefined ? { opening: Number(values.opening) } : {}),
      ...(values['no-fill-holes'] ? { fillHoles: false } : {}),
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
