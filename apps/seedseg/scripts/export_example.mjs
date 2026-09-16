#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { createProstateSignalVoidPhantom, SYNTHETIC_MARKERS } from '../web/js/prostate-example.js';
import { createNiftiFromVolume } from '../../../packages/components/src/file-io/NiftiUtils.js';

const destination = process.argv[2];
if (process.argv.length !== 3 || !/\.nii(?:\.gz)?$/.test(destination ?? '')) {
  throw new Error('Usage: node scripts/export_example.mjs <output.nii or output.nii.gz>');
}
const volume = createProstateSignalVoidPhantom();
const nifti = new Uint8Array(createNiftiFromVolume(volume));
const bytes = destination.endsWith('.gz') ? gzipSync(nifti) : nifti;
const output = resolve(destination);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, bytes);
await writeFile(`${output}.json`, `${JSON.stringify({
  generator: 'prostate-signal-voids-v1',
  source: 'apps/seedseg/web/js/prostate-example.js',
  description: 'Synthetic T1 signal-void phantom for software demonstration. Not patient data or model validation.',
  dimensions: volume.dims,
  voxelSizeMm: volume.hdr.pixDims.slice(1, 4),
  markersMm: SYNTHETIC_MARKERS,
  bytes: bytes.byteLength,
  sha256: createHash('sha256').update(bytes).digest('hex'),
}, null, 2)}\n`);
console.log(`Exported ${output} (${bytes.byteLength} bytes)`);
