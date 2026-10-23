#!/usr/bin/env node
// brainchop-mindgrab for machines without the native brainchopC build: the same
// command line, run on @brainchop/mindgrab's CPU WebAssembly.

import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { UsageError, mindgrabHelp, parseMindgrabArgs } from '../src/mindgrab-cli.js';
import { loadMindgrabCpu } from '../src/mindgrab.js';

function mindgrabPackageUrl() {
  const dir = process.env.BRAINCHOP_MINDGRAB_PACKAGE;
  if (dir) return pathToFileURL(resolve(dir, 'package.json'));
  try {
    return import.meta.resolve('@brainchop/mindgrab/package.json');
  } catch {
    throw new Error('cannot find @brainchop/mindgrab; install it next to this command (npm install @brainchop/mindgrab) or set BRAINCHOP_MINDGRAB_PACKAGE to its directory');
  }
}

async function save(path, nifti) {
  await writeFile(path, path.endsWith('.gz') ? gzipSync(nifti) : nifti);
  console.error(`brainchop :: Saved ${path}`);
}

try {
  const args = parseMindgrabArgs(process.argv.slice(2));
  const mindgrab = await loadMindgrabCpu(mindgrabPackageUrl());
  if (args.help) {
    console.log(mindgrabHelp(mindgrab.version));
  } else {
    const result = await mindgrab.segment(await readFile(args.input), {
      model: 'mindgrab',
      mask: args.mask !== undefined,
      borderMm: args.borderMm,
      ct: args.ct,
      comply: args.comply,
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
