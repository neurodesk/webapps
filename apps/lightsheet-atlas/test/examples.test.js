// The pinned examples through the whole pipeline (downloads checked against their sha256).
// The crop must give cellfinder's own candidates; the brain must give the registration that
// validation/brainreg-reference.json compares with brainreg.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { openMicroscopyStack } from '@neurodesk/webapp-components/file-io/microscopy-stack';
import { deriveSettings, filterPlane } from '../src/detect.js';
import { fetchPinned, registeredAtlasVoxels, runExample, sha256 } from '../validation/run-example.mjs';

const read = (path) => JSON.parse(readFileSync(new URL(path, import.meta.url)));
const examples = read('../examples.json');
const cellfinder = read('../validation/cellfinder-crop-reference.json');
const brainreg = read('../validation/brainreg-reference.json');

function packbits(mask) {
  const out = new Uint8Array(Math.ceil(mask.length / 8));
  for (let i = 0; i < mask.length; i++) if (mask[i]) out[i >> 3] |= 0x80 >> (i & 7);
  return out;
}

test('every thresholded plane of the crop equals cellfinder 1.10.1 bit for bit', async () => {
  const file = examples.find((e) => e.id === 'cellfinder-crop').files[0];
  const stack = await openMicroscopyStack([new File([await fetchPinned(file)], file.name)]);
  const [Z, H, W] = stack.shape;
  const settings = deriveSettings([5, 2, 2]);
  for (let z = 0; z < Z; z++) {
    const { plane, tiles } = filterPlane(await stack.readPlane(z), H, W, settings);
    const mask = Uint8Array.from(plane, (v) => (v > 0 ? 1 : 0));
    assert.equal(createHash('sha256').update(packbits(mask)).digest('hex'), cellfinder.planes[z].aboveSha256, `plane ${z}`);
    assert.equal(tiles.mask.reduce((a, b) => a + b, 0), cellfinder.planes[z].brightTiles, `plane ${z} tiles`);
  }
});

test('the crop gives cellfinder\'s 38 candidates exactly', async () => {
  const result = await runExample('cellfinder-crop');
  const key = (cell) => cell.slice(0, 3).join(',');
  assert.deepEqual(result.cells.map(key).sort(), cellfinder.cells.map(key).sort());
});

test('the whole brain registers to the pinned atlas labels and region table', async () => {
  const result = await runExample('brainreg-test-brain');
  assert.deepEqual(result.grid.shape, brainreg.app.grid);
  assert.equal(sha256(registeredAtlasVoxels(result)), brainreg.ours.registeredAtlasSha256);
  assert.equal(sha256(result.regionCsv), brainreg.ours.regionsCsvSha256);
  assert.equal(result.rows.length, brainreg.ours.regionRows);
});
