// A single-frame series with no geometry must be ordered by InstanceNumber, like
// load_and_sort_dicoms, not by filename. The phantom files are named img1..img10
// (lexicographic: img1, img10, img2, ...) with pixel value == InstanceNumber.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readDicomSeries } from '../../web/js/readers/dicom.js';
import { voxelIndex } from '../../web/js/volume.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const DIR = path.join(ROOT, 'tools', 'phantom_out', 'dicom_nogeo');

function readAB(p) {
  const buf = fs.readFileSync(p);
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

const have = fs.existsSync(DIR);
test('nogeo phantom present', () => { assert.ok(have, 'Run tools/gen_phantom.py first'); });

if (have) {
  test('single-frame series with no geometry sorts by InstanceNumber', () => {
    const files = fs.readdirSync(DIR)
      .filter((n) => n.endsWith('.dcm'))
      .map((n) => ({ name: n, buffer: readAB(path.join(DIR, n)) }));
    const vol = readDicomSeries(files);
    const [rows, cols, N] = vol.dims;
    assert.equal(N, 10);
    // Pixel value equals InstanceNumber; sorted order must read 1,2,...,10.
    const order = [];
    for (let s = 0; s < N; s++) order.push(vol.data[voxelIndex(vol, 0, 0, s)]);
    assert.deepEqual(order, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      `expected InstanceNumber order, got ${order.join(',')}`);
  });
}
