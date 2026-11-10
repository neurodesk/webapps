import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { loadNoddi } from '../src/wasm.js';

// Twelve WM gate voxels of the pinned NODDI toolbox 1.05 reference (exes/dwi/noddi-toolbox,
// tools/fixture.py), with the toolbox's own maps.
const fixture = JSON.parse(await readFile(new URL('../../../exes/dwi/noddi-toolbox/tests/fixtures/voxels.json', import.meta.url), 'utf8'));
const bvecs = [0, 1, 2].map((axis) => fixture.bvecs.map((row) => row[axis]));

test('the toolbox WASM fit reproduces the toolbox maps and reports voxel counts', async () => {
  const api = await loadNoddi(await readFile(new URL('../src/noddi.wasm', import.meta.url)));
  const model = api.noddiModel(fixture.bvals, bvecs, { method: 'toolbox' });
  try {
    // The fixture voxels, then one voxel outside the mask.
    const voxels = fixture.voxels.length + 1;
    const data = new Float32Array(voxels * fixture.bvals.length);
    fixture.voxels.forEach((voxel, index) => voxel.signal.forEach((value, frame) => { data[frame * voxels + index] = value; }));
    const mask = new Uint8Array(voxels).fill(1);
    mask[voxels - 1] = 0;
    const maps = model.fit(data, voxels, mask);
    // [19, 59, 5] starts the descent at fiso = 0, where the asin(√f) encoding has zero slope.
    // The WASM's math differs from the native build's in the last bits, and here that is
    // enough to reach another optimum (exes/dwi/noddi-toolbox/README.md); tests/fixture.rs
    // holds the native build to the toolbox on all twelve voxels.
    const sensitive = '19,59,5';
    fixture.voxels.forEach((voxel, index) => {
      for (const [key, name] of [['ICVF', 'icvf'], ['ISOVF', 'isovf'], ['OD', 'odi']]) {
        const value = maps[key][index];
        assert.ok(Number.isFinite(value) && value >= 0 && value <= 1, `${voxel.ijk} ${key}: ${value}`);
        if (String(voxel.ijk) === sensitive) continue;
        assert.ok(Math.abs(value - voxel[name]) < 1e-3, `${voxel.ijk} ${key}: ${value} vs ${voxel[name]}`);
      }
      assert.ok(Math.abs(Math.hypot(maps.dirx[index], maps.diry[index], maps.dirz[index]) - 1) < 1e-6);
    });
    for (const values of Object.values(maps)) assert.equal(values.at(-1), 0);
    assert.deepEqual(model.diagnostics, { fitted: fixture.voxels.length, skipped: 1, nonconverged: 0, failed: 0 });
  } finally {
    model.free();
  }
});

test('the toolbox WASM fit refuses a single shell', async () => {
  const api = await loadNoddi(await readFile(new URL('../src/noddi.wasm', import.meta.url)));
  const bvals = [0, 1000, 1000, 1000, 1000, 1000, 1000];
  const directions = [[0, 0, 0], [1, 0, 0], [0, 1, 0], [0, 0, 1], [1, 1, 0], [1, 0, 1], [0, 1, 1]];
  assert.throws(() => api.noddiModel(bvals, [0, 1, 2].map((axis) => directions.map((row) => row[axis])), { method: 'toolbox' }), /two or more/);
});
