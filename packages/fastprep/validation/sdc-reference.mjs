// Exercise the emitted temporal means and solver driver against SDC's pinned native field.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import createNiimath from '@niivue/niimath/niimath.js';
import { loadSdc } from '@neurodesk/sdc';
import { decodeNiftiBuffer, readNiftiFrames } from '@neurodesk/webapp-components/file-io/nifti';
import { niimathDriver, sdcDriver } from '../src/drivers.js';
import { Files } from '../src/files.js';

const cache = process.argv[2];
if (!cache) throw new Error('usage: node sdc-reference.mjs CACHE_DIR');
await mkdir(cache, { recursive: true });
const [example] = JSON.parse(await readFile(new URL('../../../apps/sdc/examples.json', import.meta.url)));
const reference = JSON.parse(await readFile(new URL('../../../apps/sdc/e2e/native-reference.json', import.meta.url)));
async function pinned(asset) {
  const path = join(cache, asset.name ?? 'native_fieldmap.nii.gz');
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    const response = await fetch(asset.url);
    if (!response.ok) throw new Error(`${asset.url}: HTTP ${response.status}`);
    bytes = new Uint8Array(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  assert.equal(bytes.length, asset.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  return bytes;
}
const files = new Files();
const images = example.files.filter((file) => file.role === 'image');
const niimath = niimathDriver(createNiimath);
for (let index = 0; index < images.length; index++) {
  const input = `/work/input${index}.nii.gz`;
  files.put(input, await pinned(images[index]));
  const result = await niimath(['niimath', input, '-Tmean', `/work/mean${index}.nii.gz`], { files });
  assert.equal(result.code, 0, result.stdout);
}
const metadata = JSON.parse(new TextDecoder().decode(await pinned(example.files.find((file) => file.role === 'sidecar'))));
const runtime = await loadSdc(await readFile(new URL('../../sdc/src/sdc.wasm', import.meta.url)));
await sdcDriver(runtime)(['sdc', 'pyhysco', '/work/mean0.nii.gz', '/work/mean1.nii.gz', '/work/out', '--pe1', metadata.PhaseEncodingDirection, '--pe2', 'j', '--trt', String(metadata.TotalReadoutTime)], { files });
const read = async (bytes) => readNiftiFrames(await decodeNiftiBuffer(bytes)).data;
const field = await read(await files.bytes('/work/out_fieldmap.nii.gz'));
const corrected = await read(await files.bytes('/work/out_corrected1.nii.gz'));
const native = await read(await pinned(reference));
let maximum = 0;
for (const value of corrected) maximum = Math.max(maximum, value);
const errors = [];
for (let index = 0; index < field.length; index++) {
  if (corrected[index] > 0.1 * maximum) errors.push(Math.abs(field[index] - native[index]));
}
errors.sort((a, b) => a - b);
const median = errors[errors.length >> 1];
assert.ok(errors.length > 10000);
assert.ok(median < 1e-3, `median field error ${median} Hz`);
console.log(JSON.stringify({ reference: reference.url, brainVoxels: errors.length, medianHz: median, maximumHz: errors.at(-1) }));
