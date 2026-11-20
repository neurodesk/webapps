import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { LOBES, REGIONS, REGION_ATLASES, readRegionAtlas, selectRegion } from '../src/cortex-regions.js';
import { findPatches } from '../src/patches.js';
import { runSurfaceAnalysis } from '../src/pipeline.js';
import { readAnnotation as readParcellation, writeAnnotation } from '../src/results.js';
import { REGION_MASK_VALUES, analyzeSurfaces } from '../src/surface-analysis.js';
import { writeInt16Nifti } from '../src/qc.js';
import { fixture } from './region-fixture.js';
import { readVolume } from '../src/volume.js';
import { regionMask } from '../src/analysis-qc.js';

const manifest = JSON.parse(await readFile(new URL('../cortex-regions.manifest.json', import.meta.url)));
const labelNames = (atlas, values) => values.map((value) => REGION_ATLASES[atlas].labels[value].name);
const value = (atlas, name) => REGION_ATLASES[atlas].labels.find((label) => label.name === name).value;

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

// SHA-256 of every output of the fixture below, recorded from @neurodesk/topofit at 23c3cae9f,
// the commit before the region mask.
const BASE_SHA256 = {
  'cortex': {
    'lh.mid.normals.csv': 'e4a8ffea9de40729354c569e011c98bb4b6e13f5ae48e422a4f2ecf531c1def7',
    'LH01.mid.white': 'fbdbb7d3270ffe3e34b0cc52cda76acfe73cec13d7e6d72211c29a2106cd50b7',
    'LH02.mid.white': '68f5366b6b5f5a7afcadd719b58d69efb20e9107ddd0eb229cceedd088d12029',
    'LH03.mid.white': '359d372bff16a133a31a2a42cdcf74b290500b1d13c4a0f2049c5c251f9df057',
    'rh.mid.normals.csv': 'e4a8ffea9de40729354c569e011c98bb4b6e13f5ae48e422a4f2ecf531c1def7',
    'RH01.mid.white': 'fbdbb7d3270ffe3e34b0cc52cda76acfe73cec13d7e6d72211c29a2106cd50b7',
    'RH02.mid.white': '68f5366b6b5f5a7afcadd719b58d69efb20e9107ddd0eb229cceedd088d12029',
    'RH03.mid.white': '359d372bff16a133a31a2a42cdcf74b290500b1d13c4a0f2049c5c251f9df057',
    'topofit_patch_coordinates_ras.csv': '5623686f0b28287838041602d209d1861c22bf2cfc26ce91656e374855d7a220',
    'topofit_patch_geometry.json': '0f3c8713806b4b6546231b2e6d26d2883ba948a94b94ac4fa1600801562cefbc',
    'topofit_patch_qc.nii': '0edd46cdba4b26fc563512cbe96f0104e74d3e6e5d79eda2c3d124f72ad60fb2',
    'topofit_surface_analysis.json': '675cfd0c79cc9736a94aa044f3038e5a4342acd00027519f032dfe959eb778a1',
    'topofit_manifest.json': '333573daea2381d9e9a0b1ceaba0897bb3b9480f8e30bda4177671cda1dac336',
  },
  'roi': {
    'lh.mid.normals.csv': 'e4a8ffea9de40729354c569e011c98bb4b6e13f5ae48e422a4f2ecf531c1def7',
    'LH01.mid.white': 'fbdbb7d3270ffe3e34b0cc52cda76acfe73cec13d7e6d72211c29a2106cd50b7',
    'LH02.mid.white': '8459dc90bb0109fed69d6c9f3cbff8c1ae63ee07a91ed726a519d69c9480c59d',
    'LH03.mid.white': '0728bde50d07efbb031a12d542fe99de8aa0575484447ae641bf78fb3362ff1f',
    'rh.mid.normals.csv': 'e4a8ffea9de40729354c569e011c98bb4b6e13f5ae48e422a4f2ecf531c1def7',
    'RH01.mid.white': 'fbdbb7d3270ffe3e34b0cc52cda76acfe73cec13d7e6d72211c29a2106cd50b7',
    'RH02.mid.white': '8459dc90bb0109fed69d6c9f3cbff8c1ae63ee07a91ed726a519d69c9480c59d',
    'RH03.mid.white': '0728bde50d07efbb031a12d542fe99de8aa0575484447ae641bf78fb3362ff1f',
    'topofit_patch_coordinates_ras.csv': 'e0ec3f0c9079c99717d92be15e5009b7170e6a3547a968580e26dc291c53b77f',
    'topofit_patch_geometry.json': '8eea2576998e71a2b5f25289c8cb2ac52d320d4fe7f0e477c6a3e5586aa3656b',
    'topofit_patch_qc.nii': 'bf2f8daf356f083de34130f551b6c5b86acf6961124d44ef7bc74976f769bbda',
    'topofit_surface_analysis.json': 'ef0c2eea7549f0f7ec9dd439449205aa52b603f527064db73763ff1e8fb43f99',
    'topofit_manifest.json': 'fa2a82f6fcf3e2608ed8bb0577c967691a2eb7ba5861de4085c17dc7f82576fd',
  },
  'wang2015:V1': {
    'lh.mid.normals.csv': 'e4a8ffea9de40729354c569e011c98bb4b6e13f5ae48e422a4f2ecf531c1def7',
    'LH01.mid.white': 'fbdbb7d3270ffe3e34b0cc52cda76acfe73cec13d7e6d72211c29a2106cd50b7',
    'LH02.mid.white': '0a76d884bb18eee96bc76255b3fd42e4549ce96be2f75cb02c982759113e3f09',
    'LH03.mid.white': '6be4872ed1b8ccfa4290dcad11238c5c80a42490a5321832b80296c0a2c6eb97',
    'lh.wang2015.annot': 'c2f34a93f406b100b6206ee4512fbae88d869d2e8587b474f7af7f8481827a51',
    'rh.mid.normals.csv': 'e4a8ffea9de40729354c569e011c98bb4b6e13f5ae48e422a4f2ecf531c1def7',
    'RH01.mid.white': '1910494e74b27da562a7c8a5b123ae797fb7c0b902c58067fd60833ac60e1439',
    'RH02.mid.white': '05c3ba39a4eff7d33686aa16b2ee2e2539b32dbc68d4e9b84079c5653c1edf17',
    'RH03.mid.white': '7ec1b0175f9ae3c9ad7bec09dee69546dc44826b3120f1013b9f0a334fa2f119',
    'rh.wang2015.annot': '674a5e5e2d1215740ccedc40e25f3eabb5a81628adf30708ccf16f98609ef0bf',
    'topofit_patch_coordinates_ras.csv': '961826c337be19e19b4ca561d8d8b012f81c38013b6ac7090575912e322a3c3c',
    'topofit_patch_geometry.json': 'b5a738a821ea615cd414399e337d3348ba43dc835ee130c127d9e69ac6d54e53',
    'topofit_patch_qc.nii': '4c78e17a1e84a8a01e1bd80495ad046ed1216e4c2d2bdb87895140dc428cd6a7',
    'topofit_surface_analysis.json': '09abdf9bf5eb673ce562c90329188076ab2c44c081a282cbadf69f498420c1f1',
    'topofit_manifest.json': 'fb359e57ff32539d110381cb98fcf8439f238744d5dea576485c57416c48a94a',
  },
};

async function compatibilityRun(extra) {
  const data = fixture({ wang2015: { lh: [1, 0], rh: [0, 2] } });
  const length = data.source.data.length;
  const buffer = writeInt16Nifti(data.source, Int16Array.from({ length }, (_, i) => i % 97), 'scan');
  const roiBuffer = writeInt16Nifti(data.source, Int16Array.from({ length }, (_, i) => (i % 32) < 20 ? 1 : 0), 'roi');
  const result = await runSurfaceAnalysis({
    buffer,
    surfaces: { vertices: data.vertices, faces: data.faces },
    provenance: { runtime: {}, outputSha256: {} },
    estimateNormals: true,
    patches: { radius: 5, count: 3, hemisphere: 'both' },
    loadAtlas: data.loadAtlas,
    loadRegions: data.loadRegions,
    cortexAtlasSha256: 'atlas',
    cortexRegionsSha256: 'regions',
    ...(extra.roi ? { roiBuffer } : {}),
    ...(extra.region ? { region: extra.region } : {}),
  });
  return result.files;
}
const sha256 = (bytes) => createHash('sha256').update(new Uint8Array(bytes)).digest('hex');

test('whole-cortex and ROI searches write exactly the files and bytes of the previous release', async () => {
  for (const [name, extra] of [['cortex', {}], ['roi', { roi: true }]]) {
    const files = await compatibilityRun(extra);
    assert.deepEqual(Object.fromEntries(files.map((file) => [file.name, sha256(file.bytes)])), BASE_SHA256[name], name);
  }
});

test('a named region adds only the mask, and the manifest only its hash', async () => {
  const files = await compatibilityRun({ region: 'wang2015:V1' });
  const hashes = Object.fromEntries(files.map((file) => [file.name, sha256(file.bytes)]));
  const mask = files.find(({ id }) => id === 'region-mask');
  assert.equal(mask.name, 'topofit_region_mask.nii');
  const { 'topofit_manifest.json': manifestHash, ...previous } = BASE_SHA256['wang2015:V1'];
  for (const [name, hash] of Object.entries(previous)) assert.equal(hashes[name], hash, name);
  assert.deepEqual(Object.keys(hashes).sort(), [...Object.keys(BASE_SHA256['wang2015:V1']), mask.name].sort());
  const manifestFile = files.find(({ name }) => name === 'topofit_manifest.json');
  const written = new TextDecoder().decode(manifestFile.bytes);
  const provenance = JSON.parse(written);
  assert.equal(provenance.outputSha256[mask.name], hashes[mask.name]);
  delete provenance.outputSha256[mask.name];
  assert.equal(sha256(new TextEncoder().encode(`${JSON.stringify(provenance, null, 2)}
`)), manifestHash);
});

// A NIfTI-2 float32 scan. `srow` is written whatever the codes; the qform comes from the
// quaternion (b, c, d), `offset`, `pixdim` and `qfac` (pixdim[0]).
function nifti2Source(dims, srow, { sformCode = 1, qformCode = 0, quaternion = [0, 0, 0], offset = [0, 0, 0], pixdim = srow.map((row, axis) => row[axis]), qfac = 1 } = {}) {
  const count = dims[0] * dims[1] * dims[2];
  const buffer = new ArrayBuffer(544 + count * 4);
  const view = new DataView(buffer);
  view.setInt32(0, 540, true);
  new Uint8Array(buffer).set([110, 43, 50, 0, 13, 10, 26, 10], 4);
  view.setInt16(12, 16, true);
  view.setInt16(14, 32, true);
  view.setBigInt64(16, 3n, true);
  for (let i = 1; i < 8; i += 1) view.setBigInt64(16 + i * 8, BigInt(dims[i - 1] ?? 1), true);
  view.setFloat64(104, qfac, true);
  pixdim.forEach((size, axis) => view.setFloat64(112 + axis * 8, size, true));
  view.setBigInt64(168, 544n, true);
  view.setFloat64(176, 1, true);
  view.setInt32(344, qformCode, true);
  view.setInt32(348, sformCode, true);
  [...quaternion, ...offset].forEach((value, index) => view.setFloat64(352 + index * 8, value, true));
  srow.forEach((row, axis) => row.forEach((value, column) => view.setFloat64(400 + (axis * 4 + column) * 8, value, true)));
  view.setInt32(500, 2, true);
  return readVolume(buffer);
}

const closeAffine = (actual, expected, message) => {
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) assert.ok(Math.abs(actual[row][column] - expected[row][column]) < 1e-5, `${message} [${row}][${column}]: ${actual[row][column]} vs ${expected[row][column]}`);
  }
};

test('a NIfTI-2 scan takes its affine by the NIfTI-1 rule and its outputs keep that grid', () => {
  // A 90 degree turn about z, z flipped by qfac -1 and x moved 20 mm, in the qform only.
  const qform = { qformCode: 1, quaternion: [0, 0, Math.SQRT1_2], offset: [20, 0, 0], pixdim: [2, 2.5, 3], qfac: -1 };
  const expected = [[0, -2.5, 0, 20], [2, 0, 0, 0], [0, 0, -3, 0], [0, 0, 0, 1]];
  const identity = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]];
  const zeros = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const sform = [[2, 0, 0, -5], [0, 2.5, 0.5, -7], [0, 0, 3, -9]];
  const cases = [
    ['qform with inactive identity srows', nifti2Source([5, 6, 7], identity, { ...qform, sformCode: 0 }), expected],
    ['qform with zeroed srows', nifti2Source([5, 6, 7], zeros, { ...qform, sformCode: 0 }), expected],
    ['sform only', nifti2Source([5, 6, 7], sform), [...sform, [0, 0, 0, 1]]],
    ['sform code at least the qform code', nifti2Source([5, 6, 7], sform, { ...qform, sformCode: 1 }), [...sform, [0, 0, 0, 1]]],
    ['no transform', nifti2Source([5, 6, 7], zeros, { sformCode: 0, pixdim: [2, 2.5, 3] }), [[2, 0, 0, 0], [0, 2.5, 0, 0], [0, 0, 3, 0], [0, 0, 0, 1]]],
  ];
  for (const [name, volume, affine] of cases) {
    closeAffine(volume.affine, affine, `${name}: reader`);
    for (const [output, bytes] of [['QC', writeInt16Nifti(volume, new Int16Array(210), 'qc')], ['mask', regionMask(volume, [], 'mask')]]) {
      const written = readVolume(bytes);
      assert.deepEqual(written.dims, [5, 6, 7], `${name}: ${output} dims`);
      closeAffine(written.affine, volume.affine, `${name}: ${output} header`);
    }
  }
});

test('the region mask and QC images keep a NIfTI-2 source grid in a NIfTI-1 header', async () => {
  const data = fixture({ wang2015: { lh: [1, 0], rh: [0, 2] } });
  const options = { ...data, patches: { ...data.patches, hemisphere: 'both' }, region: 'wang2015:V1' };
  const identity = await analyzeSurfaces(options);
  const scan = nifti2Source([32, 32, 4], [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]]);
  const result = await analyzeSurfaces({ ...options, source: scan });
  for (const id of ['region-mask', 'patch-qc']) {
    const written = result.files.find((file) => file.id === id);
    assert.equal(new DataView(written.bytes).getInt32(0, true), 348, id);
    const volume = readVolume(written.bytes);
    assert.deepEqual(volume.dims, [32, 32, 4], id);
    assert.deepEqual(volume.affine, data.source.affine, id);
    assert.deepEqual(volume.data, readVolume(identity.files.find((file) => file.id === id).bytes).data, id);
  }
  const oblique = nifti2Source([5, 6, 7], [[2, 0, 0, -5], [0, 2.5, 0.5, -7], [0, 0, 3, -9]]);
  const header = readVolume(writeInt16Nifti(oblique, new Int16Array(210), 'oblique'));
  assert.deepEqual(header.dims, [5, 6, 7]);
  assert.deepEqual(header.affine, oblique.affine);
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
