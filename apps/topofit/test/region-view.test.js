import test from 'node:test';
import assert from 'node:assert/strict';
import { writeAnnotation } from '../../../packages/topofit/src/results.js';
import { REGIONS, REGION_ATLASES } from '../../../packages/topofit/src/cortex-regions.js';
import { HEMISPHERE_COLOURS, parcellationColours, parcellationMesh, regionMaskColormap, viewToward } from '../src/region-view.js';

const table = REGION_ATLASES.wang2015.labels;
const v1 = REGIONS.find(({ id }) => id === 'wang2015:V1');

test('the search region keeps its atlas colours, other areas fade and patches are white', () => {
  const [v1v, v1d] = v1.labels;
  const colours = parcellationColours(Uint8Array.of(0, v1v, v1d, 7, v1v), table, new Set(v1.labels), new Set([4]));
  const rgba = (vertex) => Array.from(colours.subarray(vertex * 4, vertex * 4 + 4));
  assert.deepEqual(rgba(0), [150, 150, 150, 255]);
  assert.deepEqual(rgba(1), [...table[v1v].rgb, 255]);
  assert.deepEqual(rgba(2), [...table[v1d].rgb, 255]);
  assert.deepEqual(rgba(3), [...table[7].rgb.map((value) => Math.round(0.4 * value + 0.6 * 150)), 255]);
  assert.deepEqual(rgba(4), [255, 255, 255, 255]);
});

test('a parcellation mesh is the coloured mid-surface and locates its region', () => {
  const white = Float32Array.of(0, 0, 0, 2, 0, 0, 0, 2, 0, 2, 2, 0);
  const pial = Float32Array.from(white, (value, index) => index % 3 === 2 ? 2 : value);
  const labels = Uint8Array.of(v1.labels[0], v1.labels[1], 0, 0);
  const mesh = parcellationMesh({ annotation: writeAnnotation(labels, table), white, pial, faces: Int32Array.of(0, 1, 2, 1, 3, 2), region: new Set(v1.labels) });
  const view = new DataView(mesh.bytes);
  assert.deepEqual([view.getUint16(0, true), view.getUint16(2, true), view.getUint32(4, true), view.getUint32(8, true)], [23117, 7, 2, 4]);
  assert.deepEqual(Array.from(new Float32Array(mesh.bytes, 16 + 24, 3)), [0, 0, 1]);
  assert.deepEqual(mesh.centroid, [1, 0, 1]);
  assert.deepEqual(mesh.surfaceCentroid, [1, 1, 1]);
  assert.throws(() => parcellationMesh({ annotation: writeAnnotation(labels, table), white: white.subarray(3), pial: pial.subarray(3), faces: Int32Array.of(0, 1, 2), region: new Set(v1.labels) }), /does not match/);
});

test('the camera looks at the region from beyond it', () => {
  const round = ({ azimuth, elevation }) => [Math.round(azimuth), Math.round(elevation)];
  assert.deepEqual(round(viewToward([0, 0, 0], [0, -10, 0])), [0, 0]);
  assert.deepEqual(round(viewToward([0, 0, 0], [-10, 0, 0])), [90, 0]);
  assert.deepEqual(round(viewToward([0, 0, 0], [10, 0, 0])), [270, 0]);
  assert.deepEqual(round(viewToward([0, 0, 0], [0, -10, -10])), [0, -45]);
});

test('the region mask colours left 1 and right 2 like the hemispheres', () => {
  const colormap = regionMaskColormap('V1');
  assert.deepEqual(colormap.I, [0, 1, 2]);
  assert.deepEqual([colormap.R[1], colormap.G[1], colormap.B[1]], HEMISPHERE_COLOURS.lh);
  assert.deepEqual([colormap.R[2], colormap.G[2], colormap.B[2]], HEMISPHERE_COLOURS.rh);
  assert.deepEqual(colormap.labels, ['', 'Left V1', 'Right V1']);
});
