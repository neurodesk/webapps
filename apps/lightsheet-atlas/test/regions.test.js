import test from 'node:test';
import assert from 'node:assert/strict';
import { assignCells, cellCsv, regionCsv, regionReport, regionVoxels, structureTable } from '../src/regions.js';

const table = structureTable({
  shape: [2, 2, 4],
  resolution_um: 50,
  right_hemisphere_axis2_below: 2,
  structures: [
    { id: 997, index: 0, acronym: 'root', name: 'root', rgb: [255, 255, 255], path: [997] },
    { id: 315, index: 1, acronym: 'Isocortex', name: 'Isocortex', rgb: [112, 255, 113], path: [997, 315] },
    { id: 549, index: 2, acronym: 'TH', name: 'Thalamus, sensory, motor', rgb: [255, 112, 128], path: [997, 549] },
  ],
});

test('region volumes are counted per hemisphere from the atlas coordinate', () => {
  const labels = Uint16Array.from([1, 1, 2, 0]);
  const coordinates = [Float32Array.from([0, 0, 0, 0]), Float32Array.from([0, 0, 0, 0]), Float32Array.from([0, 3, 1, -1])];
  const voxels = regionVoxels(labels, coordinates, table);
  assert.deepEqual([...voxels.entries()].sort(), [['1:left', 1], ['1:right', 1], ['2:right', 1]]);
});

test('cells take the region and hemisphere at their atlas coordinate', () => {
  // A 1 × 1 × 2 sample grid whose voxels map to atlas voxels (0, 0, 1) and (1, 1, 3).
  const coordinates = [Float32Array.from([0, 1]), Float32Array.from([0, 1]), Float32Array.from([1, 3])];
  const annotation = new Uint16Array(16);
  annotation[0 + 2 * (0 + 2 * 1)] = 1;
  annotation[1 + 2 * (1 + 2 * 3)] = 2;
  const cells = assignCells([[0, 0, 0], [0, 0, 1], [0, 0, 2]], { coordinates, gridShape: [1, 1, 2], annotation, table });
  assert.deepEqual(cells.map((c) => [c.index, c.hemisphere]), [[1, 'right'], [2, 'left'], [0, null]]);
  const csv = cellCsv([[5, 6, 7], [8, 9, 10], [1, 1, 1]], cells, table);
  assert.equal(csv.split('\n')[1], '5,6,7,0,0,50,Isocortex,315,right');
  assert.equal(csv.split('\n')[3], '1,1,1,,,,,,');
});

test('the region table gives counts, volumes and densities, empty without cells', () => {
  const voxels = new Map([['1:left', 8], ['2:right', 2]]);
  const cells = [{ index: 1, hemisphere: 'left' }, { index: 1, hemisphere: 'left' }, { index: 0, hemisphere: null }];
  const rows = regionReport({ voxels, cells, table, voxelVolumeMm3: 0.5 });
  assert.equal(regionCsv(rows), 'acronym,name,structure_id,hemisphere,candidate_count,volume_mm3,candidates_per_mm3\n'
    + 'Isocortex,Isocortex,315,left,2,4,0.5\n'
    + 'TH,"Thalamus, sensory, motor",549,right,0,1,0\n');
  const volumesOnly = regionCsv(regionReport({ voxels, table, voxelVolumeMm3: 0.5 }));
  assert.match(volumesOnly, /\nIsocortex,Isocortex,315,left,,4,\n/);
});
