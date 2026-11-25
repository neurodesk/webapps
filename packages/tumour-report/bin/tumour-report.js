#!/usr/bin/env node
import { parseArgs } from 'node:util';

process.env.ORT_DISABLE_TELEMETRY ??= '1';

const HELP = `Usage: tumour-report INPUT.nii[.gz] OUTPUT_DIR [options]
       tumour-report download-models [--cache-dir PATH] [--offline]
       tumour-report self-check

Segment contrast-enhancing brain tumours on a native-space T1c MRI with
Raidionics v1.3 and compute native morphometry and MNI ICBM152 RADS reports.

Options:
  --tumour-type glioblastoma|meningioma|metastasis
      Tumour type context (default: glioblastoma; adds resectability index)
  --mask PATH
      Optional binary tumour mask aligned to the T1c image (skips segmentation)
  --skull-stripped
      Input T1c is already skull-stripped (skips MRI_Brain extraction)
  --no-mni
      Skip MNI ICBM152 Greedy registration and RADS anatomical report
  --deformable-mni
      Refine MNI registration with lesion-masked deformable Greedy SVF
  --threads N
      ONNX Runtime CPU intra-op thread count (1..64)
  --cache-dir PATH
      Model and atlas cache directory (default: NEURODESK_TUMOUR_REPORT_MODEL_DIR)
  --offline
      Refuse network downloads and require verified local models/atlases
  --overwrite
      Allow writing into a non-empty output directory
  -h, --help
      Show this help`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      offline: { type: 'boolean' },
      overwrite: { type: 'boolean' },
      'cache-dir': { type: 'string' },
      threads: { type: 'string' },
      'tumour-type': { type: 'string' },
      mask: { type: 'string' },
      'skull-stripped': { type: 'boolean' },
      'no-mni': { type: 'boolean' },
      'deformable-mni': { type: 'boolean' },
    },
  });

  if (values.help) {
    console.log(HELP);
    process.exit(0);
  }

  const { analyze, checkInstallation, downloadModels } = await import('../src/node.js');
  const common = {
    ...(values['cache-dir'] ? { cacheDir: values['cache-dir'] } : {}),
    ...(values.offline ? { offline: true } : {}),
    onProgress: (text) => console.error(text),
  };

  let report;
  if (positionals.length === 1 && positionals[0] === 'self-check') {
    report = await checkInstallation();
  } else if (positionals.length === 1 && positionals[0] === 'download-models') {
    report = await downloadModels(common);
  } else {
    if (positionals.length !== 2) {
      throw new Error('Provide an input T1c NIfTI image and an output directory. Use --help for options.');
    }
    const parameters = {
      ...(values['tumour-type'] !== undefined ? { tumourType: values['tumour-type'] } : {}),
      ...(values['skull-stripped'] ? { skullStripped: true } : {}),
      ...(values['no-mni'] ? { computeMniReport: false } : {}),
      ...(values['deformable-mni'] ? { deformableMni: true } : {}),
    };
    report = await analyze({
      ...common,
      input: positionals[0],
      output: positionals[1],
      ...(values.mask ? { mask: values.mask } : {}),
      ...(values.overwrite ? { overwrite: true } : {}),
      ...(values.threads !== undefined ? { threads: Number(values.threads) } : {}),
      parameters,
    });
  }

  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
