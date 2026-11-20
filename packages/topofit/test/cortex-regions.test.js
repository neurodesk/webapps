import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LOBES, REGIONS, REGION_ATLASES, readRegionAtlas, selectRegion } from '../src/cortex-regions.js';
import { findPatches } from '../src/patches.js';
import { runSurfaceAnalysis } from '../src/pipeline.js';
import { readAnnotation as readParcellation, writeAnnotation } from '../src/results.js';
import { REGION_MASK_VALUES, analyzeSurfaces } from '../src/surface-analysis.js';
import { writeInt16Nifti } from '../src/qc.js';

const manifest = JSON.parse(await readFile(new URL('../cortex-regions.manifest.json', import.meta.url)));
const labelNames = (atlas, values) => values.map((value) => REGION_ATLASES[atlas].labels[value].name);
const value = (atlas, name) => REGION_ATLASES[atlas].labels.find((label) => label.name === name).value;

function source(dims) {
  const header = new ArrayBuffer(348);
  const view = new DataView(header);
  view.setInt32(0, 348, true);
  view.setInt16(40, 3, true);
  for (let i = 1; i < 4; i += 1) {
    view.setInt16(40 + i * 2, dims[i - 1], true);
    view.setFloat32(76 + i * 4, 1, true);
  }
  view.setInt16(254, 1, true);
  for (const offset of [280, 300, 320]) view.setFloat32(offset, 1, true);
  const affine = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  return { dims, affine, data: new Float32Array(dims[0] * dims[1] * dims[2]), source: header, header: { littleEndian: true } };
}

function plane(size) {
  const white = [];
  const faces = [];
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      white.push(x, y, 0);
      const a = x + y * size;
      if (x + 1 < size && y + 1 < size) faces.push(a, a + 1, a + size, a + 1, a + size + 1, a + size);
    }
  }
  const pial = Float64Array.from(white, (v, i) => i % 3 === 2 ? v + 2 : v);
  return { white: Float64Array.from(white), pial, faces: Int32Array.from(faces) };
}

// A flat 31 x 31 mm sheet in both hemispheres. Vertices with x < 15 register to the
// first atlas vertex, the rest to the second; both atlas vertices are cortex.
function fixture(labels = {}) {
  const { white, pial, faces } = plane(31);
  const registration = Float64Array.from(white, (_, i) => {
    const x = white[i - i % 3];
    return (i % 3) === (x < 15 ? 0 : 1) ? 100 : 0;
  });
  const vertices = {};
  const triangles = {};
  for (const hemisphere of ['lh', 'rh']) {
    vertices[`${hemisphere}.white`] = white;
    vertices[`${hemisphere}.pial`] = pial;
    vertices[`${hemisphere}.registration`] = registration;
    triangles[hemisphere] = faces;
  }
  const atlas = new ArrayBuffer(4 + 2 * 14);
  const view = new DataView(atlas);
  view.setUint32(0, 2, true);
  view.setFloat32(4, 1, true);
  view.setFloat32(20, 1, true);
  new Uint8Array(atlas).set([1, 1, 1, 1], 28);
  const regions = new Uint8Array(4 + 2 * 4);
  new DataView(regions.buffer).setUint32(0, 2, true);
  const layout = { wang2015: { lh: [1, 0], rh: [0, 0] }, aparc: { lh: [0, 0], rh: [0, 0] }, ...labels };
  regions.set([...layout.wang2015.lh, ...layout.wang2015.rh, ...layout.aparc.lh, ...layout.aparc.rh], 4);
  return {
    source: source([32, 32, 4]),
    vertices,
    faces: triangles,
    estimateNormals: false,
    patches: { radius: 5, count: 3, hemisphere: 'lh' },
    loadAtlas: async () => atlas.slice(0),
    loadRegions: async () => regions.buffer.slice(0),
  };
}

function readAnnotation(buffer) {
  const view = new DataView(buffer);
  const decoder = new TextDecoder();
  let offset = 0;
  const read = () => {
    const value = view.getInt32(offset, false);
    offset += 4;
    return value;
  };
  const readString = () => {
    const length = read();
    const text = decoder.decode(new Uint8Array(buffer, offset, length - 1));
    offset += length;
    return text;
  };
  const count = read();
  const values = [];
  for (let i = 0; i < count; i += 1) {
    assert.equal(read(), i);
    values.push(read());
  }
  const header = { tag: read(), version: read(), maxStructure: read(), file: readString() };
  const entries = [];
  for (let i = read(); i > 0; i -= 1) entries.push({ index: read(), name: readString(), rgba: [read(), read(), read(), read()] });
  assert.equal(offset, buffer.byteLength);
  return { values, header, entries };
}

test('region ids are unique, stable strings naming labels that exist in the manifest', () => {
  assert.equal(new Set(REGIONS.map(({ id }) => id)).size, REGIONS.length);
  for (const region of REGIONS) {
    assert.match(region.id, /^(wang2015|aparc):[A-Za-z0-9-]+$/);
    assert.ok(region.id.startsWith(`${region.atlas}:`));
    assert.ok(region.labels.length > 0);
    for (const label of region.labels) assert.ok(REGION_ATLASES[region.atlas].labels[label], `${region.id} ${label}`);
    assert.ok(!region.labels.includes(0), `${region.id} includes unlabelled vertices`);
  }
  const ids = REGIONS.map(({ id }) => id);
  for (const id of ['wang2015:visual', 'wang2015:V1', 'wang2015:V3B', 'wang2015:IPS5', 'wang2015:FEF', 'wang2015:V1v', 'aparc:lobe-occipital', 'aparc:precentral', 'aparc:pericalcarine']) {
    assert.ok(ids.includes(id), id);
  }
  assert.deepEqual(labelNames('wang2015', REGIONS.find(({ id }) => id === 'wang2015:V1').labels), ['V1v', 'V1d']);
});

test('the visual cortex union holds every Wang 2015 area except FEF', () => {
  const visual = REGIONS.find(({ id }) => id === 'wang2015:visual');
  const expected = REGION_ATLASES.wang2015.labels.filter(({ name }) => !['Unknown', 'FEF'].includes(name)).map(({ value }) => value);
  assert.deepEqual([...visual.labels].sort((a, b) => a - b), expected);
});

test('lobes partition the 34 Desikan-Killiany cortical labels', () => {
  const lobeLabels = Object.values(LOBES).flat();
  assert.equal(new Set(lobeLabels).size, lobeLabels.length);
  const cortical = REGION_ATLASES.aparc.labels.map(({ name }) => name).filter((name) => !['unknown', 'corpuscallosum'].includes(name));
  assert.deepEqual([...lobeLabels].sort(), [...cortical].sort());
  assert.equal(cortical.length, 34);
  const dk = REGIONS.filter((region) => region.atlas === 'aparc' && !region.id.includes(':lobe-'));
  assert.deepEqual(dk.flatMap((region) => labelNames('aparc', region.labels)).sort(), [...cortical].sort());
});

test('the manifest describes the packed layout with one distinct colour per label', () => {
  assert.deepEqual(manifest.atlases.map(({ id }) => id), ['wang2015', 'aparc']);
  assert.equal(manifest.bytes, 4 + manifest.vertices * 2 * manifest.atlases.length);
  assert.match(manifest.url, /\/resolve\/[0-9a-f]{40}\//);
  assert.ok(manifest.url.includes(manifest.revision));
  for (const atlas of manifest.atlases) {
    assert.ok(atlas.labels.every((label, index) => label.value === index));
    const colours = atlas.labels.map(({ rgb }) => rgb.join());
    assert.equal(new Set(colours).size, colours.length, atlas.id);
  }
  assert.deepEqual(manifest.atlases[0].labels.slice(1).map(({ name }) => name), ['V1v', 'V1d', 'V2v', 'V2d', 'V3v', 'V3d', 'hV4', 'VO1', 'VO2', 'PHC1', 'PHC2', 'TO2', 'TO1', 'LO2', 'LO1', 'V3B', 'V3A', 'IPS0', 'IPS1', 'IPS2', 'IPS3', 'IPS4', 'IPS5', 'SPL1', 'FEF']);
});

test('region selection rejects unknown ids, a missing patch search and an ROI', () => {
  assert.equal(selectRegion(undefined, { patches: {} }), null);
  assert.equal(selectRegion('cortex', { patches: null, roi: {} }), null);
  assert.equal(selectRegion('wang2015:V1', { patches: {} }).name, 'V1');
  assert.throws(() => selectRegion('wang2015:V9', { patches: {} }), /Unknown cortical region "wang2015:V9"/);
  assert.throws(() => selectRegion('roi', { patches: {} }), /Unknown cortical region/);
  assert.throws(() => selectRegion('wang2015:V1', { patches: null }), /requires the flat-patch search/);
  assert.throws(() => selectRegion('aparc:precentral', { patches: {}, roi: {} }), /not both/);
});

test('the region atlas must match the cortex atlas vertex count and layout', () => {
  const buffer = new ArrayBuffer(4 + 3 * 4);
  new DataView(buffer).setUint32(0, 3, true);
  new Uint8Array(buffer).set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12], 4);
  const atlas = readRegionAtlas(buffer, 3);
  assert.deepEqual([...atlas.wang2015.lh, ...atlas.wang2015.rh, ...atlas.aparc.lh, ...atlas.aparc.rh], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  assert.throws(() => readRegionAtlas(buffer, 4), /Invalid cortical region atlas/);
  assert.throws(() => readRegionAtlas(buffer.slice(0, 15), 3), /Invalid cortical region atlas/);
});

test('a named region restricts every patch vertex to the region and writes its parcellation', async () => {
  const data = fixture();
  const whole = await analyzeSurfaces(data);
  assert.ok(Object.values(whole.analysis.flat_patches).some((patch) => patch.center_ras_mm[0] >= 15));
  const result = await analyzeSurfaces({ ...data, region: 'wang2015:V1' });
  assert.equal(result.analysis.flat_patch_status, 'PATCHES_FOUND');
  const geometry = JSON.parse(new TextDecoder().decode(result.files.find(({ id }) => id === 'patch-geometry').bytes)).patches;
  const white = data.vertices['lh.white'];
  for (const patch of Object.values(geometry)) assert.ok(patch.vertex_indices.every((vertex) => white[vertex * 3] < 15));
  const definition = result.analysis.flat_patch_definition;
  assert.equal(definition.region, 'wang2015:V1');
  assert.equal(definition.region_atlas, 'Wang 2015 visual topography');
  const annotations = result.files.filter(({ name }) => name.endsWith('.annot'));
  assert.deepEqual(annotations.map(({ id, name, mediaType }) => [id, name, mediaType]), [['lh-wang2015-annot', 'lh.wang2015.annot', 'application/vnd.freesurfer.annotation']]);
  const v1v = REGION_ATLASES.wang2015.labels[value('wang2015', 'V1v')].rgb;
  const expected = Array.from({ length: white.length / 3 }, (_, vertex) => white[vertex * 3] < 15 ? v1v[0] + v1v[1] * 256 + v1v[2] * 65536 : 0);
  assert.deepEqual(readAnnotation(annotations[0].bytes).values, expected);
});

test('a region outside the searched cortex finds no patch and still writes its parcellation', async () => {
  const data = fixture({ wang2015: { lh: [3, 3], rh: [1, 1] } });
  const empty = await analyzeSurfaces({ ...data, region: 'wang2015:V1' });
  assert.equal(empty.analysis.flat_patch_status, 'NO_PATCH_MEETS_CRITERIA');
  assert.equal(empty.files.filter(({ name }) => name.endsWith('.annot')).length, 1);
  assert.ok(new Uint8Array(empty.files.find(({ id }) => id === 'region-mask').bytes, 352).every((voxel) => voxel === 0));
  await assert.rejects(analyzeSurfaces({ ...data, region: 'wang2015:V1', roi: data.source }), /not both/);
  await assert.rejects(analyzeSurfaces({ ...data, region: 'wang2015:XX' }), /Unknown cortical region/);
});

test('the whole-cortex region gives exactly the result of no region and never loads the region atlas', async () => {
  const data = { ...fixture(), estimateNormals: true, patches: { radius: 5, count: 3 }, loadRegions: () => assert.fail('unexpected region atlas download') };
  const implicit = await analyzeSurfaces(data);
  const explicit = await analyzeSurfaces({ ...data, region: 'cortex' });
  assert.deepEqual(explicit.analysis, implicit.analysis);
  assert.deepEqual(explicit.files.map(({ name }) => name), implicit.files.map(({ name }) => name));
  for (const [index, file] of explicit.files.entries()) assert.deepEqual(new Uint8Array(file.bytes), new Uint8Array(implicit.files[index].bytes), file.name);
  assert.equal(JSON.stringify(Object.keys(implicit.analysis.flat_patch_definition)), JSON.stringify(['schema_version', 'radius', 'count', 'hemisphere', 'maxRms', 'minAreaFraction', 'cortex_mask', 'medial_wall_margin_mm', 'min_ribbon_separation_mm', 'min_normal_coherence', 'region']));
  assert.equal(implicit.analysis.flat_patch_definition.region, 'cortex');
  assert.ok(!implicit.files.some(({ name }) => name.endsWith('.annot')));
  assert.ok(!implicit.files.some(({ id }) => id === 'region-mask'));
});

test('post-reconstruction analysis records the region atlas only while a region is searched', async () => {
  const data = fixture();
  const surfaces = { vertices: data.vertices, faces: data.faces };
  const buffer = writeInt16Nifti(data.source, new Int16Array(data.source.data.length), 'scan');
  const provenance = { runtime: { cortexAtlasSha256: 'old' }, outputSha256: {} };
  const options = { buffer, surfaces, patches: data.patches, loadAtlas: data.loadAtlas, loadRegions: data.loadRegions, cortexAtlasSha256: 'atlas', cortexRegionsSha256: 'regions' };
  const named = await runSurfaceAnalysis({ ...options, provenance, region: 'wang2015:V1' });
  assert.equal(named.provenance.runtime.cortexRegionsSha256, 'regions');
  assert.equal(named.provenance.surfaceAnalysis.flat_patch_definition.region, 'wang2015:V1');
  assert.ok(named.provenance.outputSha256['lh.wang2015.annot']);
  assert.ok(named.provenance.outputSha256['topofit_region_mask.nii']);
  const whole = await runSurfaceAnalysis({ ...options, provenance: named.provenance });
  assert.equal(whole.provenance.runtime.cortexRegionsSha256, undefined);
  assert.equal(whole.provenance.runtime.cortexAtlasSha256, 'atlas');
  assert.equal(whole.provenance.outputSha256['lh.wang2015.annot'], undefined);
  assert.equal(whole.provenance.outputSha256['topofit_region_mask.nii'], undefined);
  assert.equal(whole.provenance.surfaceAnalysis.flat_patch_definition.region, 'cortex');
});

test('annotations round-trip vertex colours and the embedded colour table', () => {
  const table = REGION_ATLASES.aparc.labels;
  const labels = Uint8Array.of(0, value('aparc', 'precentral'), value('aparc', 'insula'), 0);
  const { values, header, entries } = readAnnotation(writeAnnotation(labels, table));
  const pack = ([r, g, b]) => r + g * 256 + b * 65536;
  assert.deepEqual(values, [0, pack(table[labels[1]].rgb), pack(table[labels[2]].rgb), 0]);
  assert.deepEqual(header, { tag: 1, version: -2, maxStructure: table.length, file: 'NOFILE' });
  assert.deepEqual(entries, table.map(({ value: index, name, rgb }) => ({ index, name, rgba: [...rgb, 0] })));
  assert.throws(() => writeAnnotation(Uint8Array.of(table.length), table), /has no colour/);
});

test('the region mask fills the ribbon of each searched hemisphere on the source grid', async () => {
  const data = fixture({ wang2015: { lh: [1, 0], rh: [0, 2] } });
  const result = await analyzeSurfaces({ ...data, patches: { ...data.patches, hemisphere: 'both' }, region: 'wang2015:V1' });
  const file = result.files.find(({ id }) => id === 'region-mask');
  assert.deepEqual([file.name, file.mediaType], ['topofit_region_mask.nii', 'application/nifti']);
  assert.ok(result.files.indexOf(file) < result.files.findIndex(({ id }) => id === 'surface-analysis'));
  const header = new DataView(file.bytes);
  assert.deepEqual([header.getInt16(70, true), header.getInt16(72, true), header.getFloat32(108, true)], [2, 8, 352]);
  assert.match(new TextDecoder().decode(new Uint8Array(file.bytes, 148, 80)), /^TopoFit region wang2015:V1 ribbon: left 1, right 2\0/);
  const mask = new Uint8Array(file.bytes, 352);
  assert.equal(mask.length, data.source.data.length);
  const at = (x, y, z) => mask[x + 32 * (y + 32 * z)];
  assert.deepEqual(REGION_MASK_VALUES, { lh: 1, rh: 2 });
  // Left V1 is x < 15 and right V1 x >= 15, both between the white (z 0) and pial (z 2) sheets.
  for (let z = 0; z <= 2; z += 1) {
    for (let y = 0; y <= 30; y += 1) {
      for (let x = 0; x <= 30; x += 1) assert.equal(at(x, y, z), x < 15 ? 1 : 2, `${x},${y},${z}`);
    }
  }
  assert.equal(at(31, 5, 1), 0);
  assert.equal(at(5, 31, 1), 0);
  assert.equal(at(5, 5, 3), 0);
  const again = await analyzeSurfaces({ ...data, patches: { ...data.patches, hemisphere: 'both' }, region: 'wang2015:V1' });
  assert.deepEqual(new Uint8Array(again.files.find(({ id }) => id === 'region-mask').bytes), new Uint8Array(file.bytes));
});

test('a named region keeps every other output of the search and adds only the mask', async () => {
  const data = fixture();
  const result = await analyzeSurfaces({ ...data, region: 'wang2015:V1' });
  const patches = Object.keys(result.analysis.flat_patches).map((id) => `${id}.mid.white`);
  assert.ok(patches.length > 0);
  assert.deepEqual(result.files.map(({ name }) => name), [...patches, 'lh.wang2015.annot', 'topofit_patch_coordinates_ras.csv', 'topofit_patch_geometry.json', 'topofit_patch_qc.nii', 'topofit_region_mask.nii', 'topofit_surface_analysis.json']);
  assert.equal(JSON.stringify(Object.keys(result.analysis.flat_patch_definition)), JSON.stringify(['schema_version', 'radius', 'count', 'hemisphere', 'maxRms', 'minAreaFraction', 'cortex_mask', 'medial_wall_margin_mm', 'min_ribbon_separation_mm', 'min_normal_coherence', 'region', 'region_atlas']));
});

test('a parcellation reads back as label values with its colour table', () => {
  const table = REGION_ATLASES.wang2015.labels;
  const labels = Uint8Array.of(0, value('wang2015', 'V1v'), value('wang2015', 'V1d'), value('wang2015', 'FEF'), 0);
  const read = readParcellation(writeAnnotation(labels, table));
  assert.deepEqual([...read.labels], [...labels]);
  assert.deepEqual(read.table, table.map(({ value: index, name, rgb }) => ({ value: index, name, rgb })));
});

test('a named region left with two non-degenerate faces finds no patch instead of failing', () => {
  const vertices = Float64Array.of(0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0);
  const faces = Int32Array.of(0, 1, 2, 1, 3, 2, 0, 0, 1);
  const eligible = Uint8Array.of(1, 1, 1, 1);
  assert.deepEqual(findPatches(vertices, faces, eligible, {}, true), []);
  assert.throws(() => findPatches(vertices, faces, eligible, {}), /at least three/);
});
