#!/usr/bin/env node
import { parseArgs } from 'node:util';

const HELP = `Usage: brainchop INPUT.nii[.gz] OUTPUT_DIR [options]
       brainchop download-models [--cache-dir PATH] [--offline]
       brainchop self-check [--cache-dir PATH]

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
      Model directory for download-models or self-check (weights are embedded in @brainchop/core)
  --offline
      Accepted for offline CLI compatibility (no network access is used)
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
    });
  } else {
    if (positionals.length !== 2) {
      throw new Error('Provide an input T1-weighted MRI NIfTI image and an output directory. Use --help for options.');
    }
    assertAllowedOptions(
      values,
      ['model', 'save-conform', 'no-turbo', 'legacy-cleanup', 'threads', 'overwrite', 'offline'],
      'brainchop',
    );
    const input = requireNonEmptyOption(positionals[0], 'input');
    const output = requireNonEmptyOption(positionals[1], 'output');
    const model = values.model !== undefined
      ? requireNonEmptyOption(values.model, 'model')
      : undefined;
    const threads = values.threads !== undefined
      ? parseStrictInt(values.threads, 'threads', 1, 64)
      : undefined;
    const { segment } = await import('../src/node.js');
    report = await segment({
      input,
      output,
      ...(model !== undefined ? { model } : {}),
      ...(values['save-conform'] ? { saveConform: true } : {}),
      ...(values['no-turbo'] ? { noTurbo: true } : {}),
      ...(values['legacy-cleanup'] ? { legacyCleanup: true } : {}),
      ...(threads !== undefined ? { threads } : {}),
      ...(values.overwrite ? { overwrite: true } : {}),
      onProgress: (text) => console.error(text),
    });
  }

  console.log(JSON.stringify(report));
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
