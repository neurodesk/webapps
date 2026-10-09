#!/usr/bin/env node
// Writes the deterministic TOF crop the browser test uses: node write_tof_crop.mjs <output.nii> [source.nii.gz]
// Without a source path the pinned example is downloaded; either way its SHA-256 is verified.
import { readFile, writeFile } from 'node:fs/promises';
import { cropTof, TOF_SOURCE } from '../test/tof-crop.mjs';

const [output, sourcePath] = process.argv.slice(2);
if (!output) throw new Error('Usage: write_tof_crop.mjs <output.nii> [source.nii.gz]');
let source;
if (sourcePath) {
  source = await readFile(sourcePath);
} else {
  const response = await fetch(TOF_SOURCE.url);
  if (!response.ok) throw new Error(`${TOF_SOURCE.url}: HTTP ${response.status}`);
  source = Buffer.from(await response.arrayBuffer());
}
await writeFile(output, await cropTof(source));
