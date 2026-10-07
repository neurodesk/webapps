#!/usr/bin/env node
// Writes the deterministic body MRI slab the browser test uses: node write_body_slab.mjs <output.nii> [source.nii.gz]
// Without a source path the pinned example is downloaded; either way its SHA-256 is verified.
import { readFile, writeFile } from 'node:fs/promises';
import { BODY_SOURCE, cutBodySlab } from '../test/body-slab.mjs';

const [output, sourcePath] = process.argv.slice(2);
if (!output) throw new Error('Usage: write_body_slab.mjs <output.nii> [source.nii.gz]');
let source;
if (sourcePath) {
  source = await readFile(sourcePath);
} else {
  const response = await fetch(BODY_SOURCE.url);
  if (!response.ok) throw new Error(`${BODY_SOURCE.url}: HTTP ${response.status}`);
  source = Buffer.from(await response.arrayBuffer());
}
await writeFile(output, await cutBodySlab(source));
