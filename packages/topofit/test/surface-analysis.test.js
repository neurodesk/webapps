import assert from 'node:assert/strict';
import test from 'node:test';
import { runSurfaceAnalysis } from '../src/pipeline.js';
import { analyzeSurfaces, readPatchRoi } from '../src/surface-analysis.js';
import { triangleVoxelMask } from '../src/analysis-qc.js';
import { writeInt16Nifti } from '../src/qc.js';

function fixture() {
  const white = new Float64Array([2, 2, 2, 8, 2, 2, 2, 8, 2, 8, 8, 2, 14, 2, 2, 14, 8, 2]);
  const pial = Float64Array.from(white, (v, i) => i % 3 === 2 ? v + 2 : v);
  const triangles = new Int32Array([0, 1, 2, 1, 3, 2, 1, 4, 3, 4, 5, 3]);
  const vertices = {};
  const faces = {};
  for (const h of ['lh', 'rh']) {
    vertices[`${h}.white`] = white;
    vertices[`${h}.pial`] = pial;
    vertices[`${h}.registration`] = new Float64Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]);
    faces[h] = triangles;
  }
  const source = { dims: [20, 20, 20], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], data: new Float32Array(8000), source: new ArrayBuffer(348), header: { littleEndian: true } };
  const header = new DataView(source.source);
  header.setInt32(0, 348, true);
  header.setInt16(40, 3, true);
  for (let i = 1; i < 4; i += 1) {
    header.setInt16(40 + i * 2, 20, true);
    header.setFloat32(76 + i * 4, 1, true);
  }
  header.setInt16(254, 1, true);
  for (const offset of [280, 300, 320]) header.setFloat32(offset, 1, true);
  const atlas = new ArrayBuffer(18);
  const view = new DataView(atlas);
  view.setUint32(0, 1, true);
  view.setFloat32(4, 1, true);
  new Uint8Array(atlas).set([1, 1], 16);
  return { vertices, faces, source, loadAtlas: async () => atlas };
}

test('analysis exports corresponding local coordinates, normals, measurements and native-grid QC', async () => {
  const result = await analyzeSurfaces({ ...fixture(), estimateNormals: true, patches: { radius: 10, hemisphere: 'lh', count: 1, minAreaFraction: 0.1 } });
  assert.equal(result.analysis.flat_patch_status, 'PATCHES_FOUND');
  assert.deepEqual(Object.keys(result.analysis.flat_patches), ['LH01']);
  const patch = result.analysis.flat_patches.LH01;
  assert.deepEqual(patch.normal_ras, [0, 0, 1]);
  assert.equal(patch.median_ribbon_separation_mm, 2);
  const geometry = JSON.parse(new TextDecoder().decode(result.files.find((f) => f.id === 'patch-geometry').bytes)).patches.LH01;
  assert.equal(geometry.vertex_indices.length, geometry.normals_ras.length);
  assert.ok(geometry.normals_ras.every((row) => row[2] === 1));
  assert.ok(geometry.faces.flat().every((index) => index < geometry.vertex_indices.length));
  const qc = result.files.find((f) => f.id === 'patch-qc');
  const data = new Int16Array(qc.bytes, 352);
  assert.ok(data.includes(3000));
  assert.ok(data.includes(4095));
  assert.equal(result.files.filter((f) => f.mediaType === 'text/csv').length, 3);
  assert.deepEqual(patch.center_ras_mm, geometry.mid_ras_mm[geometry.vertex_indices.indexOf(patch.center_vertex_index)]);
  const csv = new TextDecoder().decode(result.files.find((file) => file.id === 'patch-coordinates').bytes).trim().split('\n');
  assert.match(csv[0], /x_ras_mm,y_ras_mm,z_ras_mm,nx_ras,ny_ras,nz_ras/);
  assert.deepEqual(csv[1].split(',').slice(3, 9).map(Number), [...patch.center_ras_mm, ...patch.normal_ras]);
});

test('normals-only analysis never downloads an atlas', async () => {
  const result = await analyzeSurfaces({ ...fixture(), estimateNormals: true, loadAtlas: () => assert.fail('unexpected atlas download') });
  assert.equal(result.analysis.flat_patch_status, 'NOT_REQUESTED');
  assert.equal(result.files.length, 3);
});

test('no acceptable patch retains measurements without offering an empty QC image', async () => {
  const result = await analyzeSurfaces({ ...fixture(), patches: { radius: 20 } });
  assert.equal(result.analysis.flat_patch_status, 'NO_PATCH_MEETS_CRITERIA');
  assert.deepEqual(result.analysis.flat_patches, {});
  assert.ok(!result.files.some((file) => file.id === 'patch-qc'));
});

test('an empty ROI fails without a whole-cortex fallback', async () => {
  const data = fixture();
  await assert.rejects(analyzeSurfaces({ ...data, patches: {}, roi: data.source }), /ROI contains no eligible/);
});

test('ROI boundary rejects mismatched shape and affine', () => {
  const { source } = fixture();
  const buffer = writeInt16Nifti(source, new Int16Array(8000).fill(1), 'ROI');
  assert.equal(readPatchRoi(buffer, source).data.length, 8000);
  assert.throws(() => readPatchRoi(buffer, { ...source, dims: [21, 20, 20] }), /same shape and affine/);
  assert.throws(() => readPatchRoi(buffer, { ...source, affine: [[1, 0, 0, 2], ...source.affine.slice(1)] }), /same shape and affine/);
});

test('triangle voxelization fills interiors and retains oblique coordinate transforms', () => {
  const { source } = fixture();
  const vertices = new Float64Array([2, 2, 3, 8, 2, 3, 2, 8, 3]);
  const mask = triangleVoxelMask(source, vertices, new Int32Array([0, 1, 2]));
  assert.equal(mask[4 + 20 * (4 + 20 * 3)], 1);
  assert.equal(mask[8 + 20 * (8 + 20 * 3)], 0);
  const rotated = { ...source, affine: [[0, -1, 0, 20], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]] };
  const points = Float64Array.from([18, 2, 3, 18, 8, 3, 12, 2, 3]);
  assert.deepEqual(triangleVoxelMask(rotated, points, new Int32Array([0, 1, 2])), mask);
});

test('post-reconstruction analysis replaces prior products and provenance without changing the surfaces', async () => {
  const data = fixture();
  const surfaces = { vertices: data.vertices, faces: data.faces };
  const before = structuredClone(surfaces);
  const buffer = writeInt16Nifti(data.source, new Int16Array(8000), 'scan');
  const provenance = {
    inputSha256: 'original-input', runtime: { cortexAtlasSha256: 'previous-atlas' }, roiSha256: 'previous-roi',
    outputSha256: Object.fromEntries([...Object.keys(data.vertices), 'lh.mid.white', 'rh.mid.white', 'topofit_qc.nii', 'obsolete.nii'].map((name) => [name, `hash-${name}`])),
  };
  const first = await runSurfaceAnalysis({ buffer, surfaces, provenance, patches: { radius: 10, hemisphere: 'lh', count: 1, minAreaFraction: 0.1 }, estimateNormals: true, loadAtlas: data.loadAtlas, cortexAtlasSha256: 'atlas' });
  assert.deepEqual(Object.keys(first.provenance.surfaceAnalysis.flat_patches), ['LH01']);
  assert.equal(first.provenance.runtime.cortexAtlasSha256, 'atlas');
  assert.equal(first.provenance.roiSha256, undefined);
  const second = await runSurfaceAnalysis({ buffer, surfaces, provenance: first.provenance, estimateNormals: true });
  assert.equal(second.provenance.surfaceAnalysis.flat_patch_status, 'NOT_REQUESTED');
  assert.equal(second.provenance.runtime.cortexAtlasSha256, undefined);
  assert.equal(second.provenance.outputSha256['LH01.mid.white'], undefined);
  assert.equal(second.provenance.outputSha256['obsolete.nii'], undefined);
  assert.equal(second.provenance.outputSha256['topofit_qc.nii'], 'hash-topofit_qc.nii');
  assert.equal(second.provenance.inputSha256, 'original-input');
  assert.equal(second.provenance.outputSha256['lh.mid.white'], 'hash-lh.mid.white');
  assert.equal(second.provenance.outputSha256['rh.mid.white'], 'hash-rh.mid.white');
  assert.equal(second.provenance.outputSha256['topofit_patch_coordinates_ras.csv'], undefined);
  assert.deepEqual(surfaces, before);
  assert.equal(provenance.roiSha256, 'previous-roi');
  for (const file of second.files.filter((file) => file.id !== 'provenance')) {
    const digest = await crypto.subtle.digest('SHA-256', file.bytes);
    const hash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('');
    assert.equal(second.provenance.outputSha256[file.name], hash);
  }
  const saved = JSON.parse(new TextDecoder().decode(second.files.find((file) => file.id === 'provenance').bytes));
  assert.deepEqual(saved, second.provenance);
});

test('patch coordinates and plane normals remain scanner RAS on translated oblique anatomy', async () => {
  const data = fixture();
  const transform = (points) => Float64Array.from(points, (_, i) => {
    const base = i - i % 3;
    const [x, y, z] = points.subarray(base, base + 3);
    return [10 - y, x - 7, z + 0.3 * x][i % 3];
  });
  for (const side of ['lh', 'rh']) {
    for (const surface of ['white', 'pial']) data.vertices[`${side}.${surface}`] = transform(data.vertices[`${side}.${surface}`]);
  }
  data.source.affine = [[0, -1, 0, 10], [1, 0, 0, -7], [0.3, 0, 1, 0], [0, 0, 0, 1]];
  const result = await analyzeSurfaces({ ...data, patches: { radius: 10, hemisphere: 'lh', count: 1, minAreaFraction: 0.1 } });
  const patch = result.analysis.flat_patches.LH01;
  const expected = [0, -0.3 / Math.hypot(1, 0.3), 1 / Math.hypot(1, 0.3)];
  for (let axis = 0; axis < 3; axis += 1) {
    assert.ok(Math.abs(patch.normal_ras[axis] - expected[axis]) < 1e-10);
    const index = patch.center_vertex_index * 3 + axis;
    assert.equal(patch.center_ras_mm[axis], (data.vertices['lh.white'][index] + data.vertices['lh.pial'][index]) / 2);
  }
  assert.ok(Math.abs(Math.hypot(...patch.normal_ras) - 1) < 1e-12);
});
