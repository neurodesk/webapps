#!/usr/bin/env node
// brainchop-mindgrab for machines without the native brainchop-core build: the same
// command line, run on @brainchop/core's CPU WebAssembly.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { UsageError, mindgrabHelp, parseMindgrabArgs } from '../src/mindgrab-cli.js';
import { loadMindgrabCpu } from '../src/mindgrab.js';

function mindgrabPackageUrl() {
  const dir = process.env.BRAINCHOP_MINDGRAB_PACKAGE;
  if (dir) return pathToFileURL(resolve(dir, 'package.json'));
  for (const specifier of ['@brainchop/core/package.json', '@brainchop/mindgrab/package.json']) {
    try {
      return import.meta.resolve(specifier);
    } catch {
      // Try fallback package name.
    }
  }
  throw new Error('cannot find @brainchop/core; install it next to this command (npm install @brainchop/core) or set BRAINCHOP_MINDGRAB_PACKAGE to its directory');
}

async function save(path, nifti) {
  await writeFile(path, path.endsWith('.gz') ? gzipSync(nifti) : nifti);
  console.error(`brainchop :: Saved ${path}`);
}

try {
  const args = parseMindgrabArgs(process.argv.slice(2));
  const mindgrab = await loadMindgrabCpu(mindgrabPackageUrl());
  if (args.help) {
    console.log(mindgrabHelp(mindgrab.version, { packageName: mindgrab.packageName, supportsNoTurbo: mindgrab.supportsNoTurbo }));
  } else if (args.version) {
    console.log(`brainchop-mindgrab ${mindgrab.version}`);
  } else {
    if (args.noTurbo && !mindgrab.supportsNoTurbo) {
      throw new UsageError(`--no-turbo is not supported by ${mindgrab.packageName} ${mindgrab.version}`);
    }
    const result = await mindgrab.segment(await readFile(args.input), {
      model: 'mindgrab',
      mask: args.mask !== undefined,
      borderMm: args.borderMm,
      ct: args.ct,
      comply: args.comply,
      noTurbo: args.noTurbo,
      gzipOutput: false,
    });
    await save(args.output, new Uint8Array(result.image));
    if (args.mask !== undefined) await save(args.mask, new Uint8Array(result.mask));
  }
} catch (error) {
  // The module's own log names its in-memory files (/in.nii, /out.nii), so it is shown only on failure.
  for (const line of error.log ?? []) console.error(line);
  console.error(`brainchop: ${error.message}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}
