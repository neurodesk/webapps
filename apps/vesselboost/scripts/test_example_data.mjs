import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as nifti from 'nifti-reader-js';

const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url)));

test('the hosted TOF example retains tissue intensities, not just segmented vessels', async () => {
  const file = examples[0].files.find(file => file.role === 'image');
  let bytes;
  if (process.env.VESSELBOOST_EXAMPLE_PATH) {
    bytes = await readFile(process.env.VESSELBOOST_EXAMPLE_PATH);
  } else {
    const response = await fetch(file.url, { signal: AbortSignal.timeout(180000) });
    assert.ok(response.ok, `Example download returned ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  let buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  if (nifti.isCompressed(buffer)) buffer = nifti.decompress(buffer);
  const header = nifti.readHeader(buffer);
  assert.equal(header.dims[0], 3, 'Expected a 3D TOF acquisition');
  const image = nifti.readImage(header, buffer);
  const types = new Map([[2, Uint8Array], [4, Int16Array], [8, Int32Array], [512, Uint16Array], [16, Float32Array]]);
  const Type = types.get(header.datatypeCode);
  assert.ok(Type, `Unsupported example datatype ${header.datatypeCode}`);
  const values = new Type(image);
  const distinct = new Set();
  let nonzero = 0;
  for (const value of values) {
    assert.ok(Number.isFinite(value), 'Image must contain finite intensities');
    if (value !== 0) nonzero++;
    if (distinct.size <= 256) distinct.add(value);
  }
  assert.ok(nonzero / values.length > 0.1,
    `Expected tissue signal across the volume; only ${(100 * nonzero / values.length).toFixed(2)}% is nonzero`);
  assert.ok(distinct.size > 256, 'Expected acquisition intensities, not quantized vessel labels');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
  console.log(`TOF dimensions ${header.dims.slice(1, 4).join(' × ')}; ${(100 * nonzero / values.length).toFixed(1)}% nonzero`);
});
