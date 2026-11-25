#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { DEFAULT_OPENING_RADIUS, MAX_OPENING_RADIUS } from '../src/pipeline.js';

const HELP = `Usage: brainchomp INPUT.nii[.gz] OUTPUT_DIR [options]
       brainchomp download-models [--cache-dir PATH] [--offline]
       brainchomp self-check [--cache-dir PATH]

Extract a skull-stripped rodent brain image and binary brain mask on the
input voxel grid using brainchomp-lib's threaded CPU WebAssembly runtime.

Options:
  --opening R
      Morphological opening radius in 0.1 mm grid voxels (0..${MAX_OPENING_RADIUS}, default: ${DEFAULT_OPENING_RADIUS})
  --no-fill-holes
      Keep enclosed cavities in the mask instead of filling them as brain
  --threads N
      CPU WebAssembly thread count (1..64)
  --overwrite
      Allow writing into a non-empty output directory
  --cache-dir PATH
      Model directory for download-models or self-check (weights are embedded in brainchomp.wasm)
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
      throw new Error('Provide an input rodent MRI NIfTI image and an output directory. Use --help for options.');
    }
    assertAllowedOptions(
      values,
      ['opening', 'no-fill-holes', 'threads', 'overwrite', 'offline'],
      'brainchomp',
    );
    const input = requireNonEmptyOption(positionals[0], 'input');
    const output = requireNonEmptyOption(positionals[1], 'output');
    const opening = values.opening !== undefined
      ? parseStrictInt(values.opening, 'opening', 0, MAX_OPENING_RADIUS)
      : undefined;
    const threads = values.threads !== undefined
      ? parseStrictInt(values.threads, 'threads', 1, 64)
      : undefined;
    const { extract } = await import('../src/node.js');
    report = await extract({
      input,
      output,
      ...(opening !== undefined ? { opening } : {}),
      ...(values['no-fill-holes'] ? { fillHoles: false } : {}),
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
