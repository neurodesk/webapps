#!/usr/bin/env node
import { parseArgs } from 'node:util';

// Always disable ONNX Runtime telemetry so an inherited ORT_DISABLE_TELEMETRY=0
// cannot write device IDs under $HOME.
process.env.ORT_DISABLE_TELEMETRY = '1';

const HELP = `Usage: tumour-report INPUT.nii[.gz] OUTPUT_DIR [options]
       tumour-report download-models [--cache-dir PATH] [--offline]
       tumour-report self-check [--cache-dir PATH]

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

function assertAllowedOptions(values, allowed, commandName) {
  const allowedSet = new Set(allowed);
  for (const [key, val] of Object.entries(values)) {
    if (val !== undefined && !allowedSet.has(key)) {
      throw new Error(`Option --${key} is not valid for ${commandName}.`);
    }
  }
}

function requireNonEmptyOption(value, flag) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`--${flag} requires a non-empty value.`);
  }
  return value;
}

function parseStrictInt(raw, flag, min, max) {
  const trimmed = requireNonEmptyOption(raw, flag).trim();
  if (!/^-?\d+$/.test(trimmed)) {
    throw new Error(`--${flag} must be an integer between ${min} and ${max}, got '${raw}'.`);
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num) || num < min || num > max) {
    throw new Error(`--${flag} must be an integer between ${min} and ${max}, got '${raw}'.`);
  }
  return num;
}

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

  const [command] = positionals;
  let report;

  if (command === 'self-check') {
    if (positionals.length !== 1) {
      throw new Error('self-check does not accept extra positional arguments.');
    }
    assertAllowedOptions(values, ['cache-dir'], 'self-check');
    const cacheDir = values['cache-dir'] !== undefined
      ? requireNonEmptyOption(values['cache-dir'], 'cache-dir')
      : undefined;
    const { checkInstallation } = await import('../src/node.js');
    report = await checkInstallation({ cacheDir });
  } else if (command === 'download-models') {
    if (positionals.length !== 1) {
      throw new Error('download-models does not accept extra positional arguments.');
    }
    assertAllowedOptions(values, ['cache-dir', 'offline'], 'download-models');
    const cacheDir = values['cache-dir'] !== undefined
      ? requireNonEmptyOption(values['cache-dir'], 'cache-dir')
      : undefined;
    const { downloadModels } = await import('../src/node.js');
    report = await downloadModels({
      ...(cacheDir !== undefined ? { cacheDir } : {}),
      ...(values.offline ? { offline: true } : {}),
      onProgress: (text) => console.error(text),
    });
  } else {
    if (positionals.length !== 2) {
      throw new Error('Provide an input T1c NIfTI image and an output directory. Use --help for options.');
    }
    assertAllowedOptions(
      values,
      [
        'tumour-type',
        'mask',
        'skull-stripped',
        'no-mni',
        'deformable-mni',
        'threads',
        'cache-dir',
        'offline',
        'overwrite',
      ],
      'tumour-report',
    );
    const input = requireNonEmptyOption(positionals[0], 'input');
    const output = requireNonEmptyOption(positionals[1], 'output');
    const mask = values.mask !== undefined ? requireNonEmptyOption(values.mask, 'mask') : undefined;
    const cacheDir = values['cache-dir'] !== undefined
      ? requireNonEmptyOption(values['cache-dir'], 'cache-dir')
      : undefined;
    const tumourType = values['tumour-type'] !== undefined
      ? requireNonEmptyOption(values['tumour-type'], 'tumour-type')
      : undefined;
    const threads = values.threads !== undefined
      ? parseStrictInt(values.threads, 'threads', 1, 64)
      : undefined;

    const { analyze } = await import('../src/node.js');
    report = await analyze({
      input,
      output,
      ...(mask !== undefined ? { mask } : {}),
      ...(cacheDir !== undefined ? { cacheDir } : {}),
      ...(values.offline ? { offline: true } : {}),
      ...(values.overwrite ? { overwrite: true } : {}),
      ...(threads !== undefined ? { threads } : {}),
      parameters: {
        ...(tumourType !== undefined ? { tumourType } : {}),
        ...(values['skull-stripped'] ? { skullStripped: true } : {}),
        ...(values['no-mni'] ? { computeMniReport: false } : {}),
        ...(values['deformable-mni'] ? { deformableMni: true } : {}),
      },
      onProgress: (text) => console.error(text),
    });
  }

  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
