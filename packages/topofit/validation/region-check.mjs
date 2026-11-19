#!/usr/bin/env node
// Region-search sanity check on the pinned real reconstruction (the controlled browser
// surfaces of packages/topofit/validation). Downloads pinned data into a cache directory:
//   node packages/topofit/validation/region-check.mjs [cache-dir] [--output report.json]
// Fails when the mapped atlases disagree with anatomy or with each other, when a region
// search returns a vertex outside its region, or when the whole-cortex search no longer
// gives the documented patches of surface-analysis.md.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nearestAtlasVertices, readCortexAtlas } from '../src/cortex-atlas.js';
import { LOBES, REGIONS, REGION_ATLASES, readRegionAtlas } from '../src/cortex-regions.js';
import { midSurface } from '../src/patches.js';
import { analyzeSurfaces } from '../src/surface-analysis.js';
import { readVolume } from '../src/volume.js';

const SURFACES = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/b438d1162e7192ca425ca47282b06fe62340c85a/topofit/0.5.1/onnx-20260911/validation/browser/controlled/';
const SURFACE_SHA256 = {
  'lh.white': '1e1c108b929b129d82d5239d9c4b8e2ed9d9fb75d036fe973f0c356a84df7dc7',
  'lh.pial': '068982cfa4533bb5ca228c7743b0fa93da1b055df6391444f8505d426b39be96',
  'lh.registration': 'cd2a1cd8eba422b54988bbf96fece0100816095234f87bf6653cfa091b0432a6',
  'rh.white': '7a0d81ec924c590c82f7fd45a1b2a2ff9833f652f06d683c272533be01721a13',
  'rh.pial': 'a0a6ca6add63d89e8d61d266f41bc18a482db21f87f8b6a5e13b25ed39393b60',
  'rh.registration': '843899aa3fe10331d2b5eaaf7499485849cc8164159d885e3169e1c948628d5a',
};
const INPUT = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/b438d1162e7192ca425ca47282b06fe62340c85a/topofit/0.5.1/onnx-20260911/validation/inputs/sub-01_T1w.browser-1mm.nii.gz';
const INPUT_SHA256 = '69dc5c8be1850422e30ce8b03c6b434bb919c0427a3ec79e79b7552b4c00db5e';
// surface-analysis.md, "Real reconstructed cortex": area and RMS of the whole-cortex patches.
const DOCUMENTED = {
  LH01: [149.511432, 0.407652], LH02: [138.111057, 0.320317], LH03: [168.316613, 0.383922],
  RH01: [164.808119, 0.314698], RH02: [155.059072, 0.336236], RH03: [157.530376, 0.374494],
};
const MIN_V1_PERICALCARINE_DICE = 0.3;
const MIN_V1_IN_OCCIPITAL = 0.95;
const MAX_V1_POSTERIOR_FRACTION = 0.25;

const args = process.argv.slice(2);
const outputIndex = args.indexOf('--output');
const output = outputIndex >= 0 ? args.splice(outputIndex, 2)[1] : null;
const cache = args[0] || join(process.env.TMPDIR || '.', 'topofit-region-check');
await mkdir(cache, { recursive: true });
const manifests = {
  cortex: JSON.parse(await readFile(new URL('../cortex-atlas.manifest.json', import.meta.url))),
  regions: JSON.parse(await readFile(new URL('../cortex-regions.manifest.json', import.meta.url))),
};

async function pinned(name, url, sha256) {
  const path = join(cache, name);
  let bytes;
  try {
    bytes = await readFile(path);
  } catch {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    await writeFile(path, bytes);
  }
  assert.equal(createHash('sha256').update(bytes).digest('hex'), sha256, `${name} checksum`);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function readSurface(buffer) {
  const bytes = new Uint8Array(buffer);
  const view = new DataView(buffer);
  let offset = 3;
  for (let lines = 0; lines < 2;) if (bytes[offset++] === 10) lines += 1;
  const count = view.getInt32(offset);
  const faceCount = view.getInt32(offset + 4);
  offset += 8;
  const vertices = Float64Array.from({ length: count * 3 }, (_, i) => view.getFloat32(offset + i * 4));
  offset += count * 12;
  const faces = Int32Array.from({ length: faceCount * 3 }, (_, i) => view.getInt32(offset + i * 4));
  return { vertices, faces };
}

function readAnnotation(buffer) {
  const view = new DataView(buffer);
  const count = view.getInt32(0);
  return Int32Array.from({ length: count }, (_, i) => view.getInt32(8 + i * 8));
}

const centroid = (points, members) => {
  const sum = [0, 0, 0];
  let count = 0;
  for (let i = 0; i < members.length; i += 1) {
    if (!members[i]) continue;
    for (let axis = 0; axis < 3; axis += 1) sum[axis] += points[i * 3 + axis];
    count += 1;
  }
  return sum.map((value) => value / count);
};

const cortexBytes = await pinned('fsaverage-cortex.bin', manifests.cortex.url, manifests.cortex.sha256);
const regionBytes = await pinned('fsaverage-regions.bin', manifests.regions.url, manifests.regions.sha256);
const atlas = readCortexAtlas(cortexBytes);
const regionAtlas = readRegionAtlas(regionBytes, atlas.points.length / 3);
const vertices = {};
const faces = {};
for (const [name, sha256] of Object.entries(SURFACE_SHA256)) {
  const surface = readSurface(await pinned(name, SURFACES + name, sha256));
  vertices[name] = surface.vertices;
  faces[name.slice(0, 2)] = surface.faces;
}
const value = (atlasId, name) => REGION_ATLASES[atlasId].labels.find((label) => label.name === name).value;
const v1Labels = [value('wang2015', 'V1v'), value('wang2015', 'V1d')];
const pericalcarine = value('aparc', 'pericalcarine');
const occipital = LOBES.occipital.map((name) => value('aparc', name));

const report = { surfaces: SURFACES, regionsSha256: manifests.regions.sha256, hemispheres: {}, regions: {} };
const mapped = {};
for (const hemisphere of ['lh', 'rh']) {
  const nearest = nearestAtlasVertices(vertices[`${hemisphere}.registration`], atlas.points);
  const wang = Uint8Array.from(nearest, (vertex) => regionAtlas.wang2015[hemisphere][vertex]);
  const aparc = Uint8Array.from(nearest, (vertex) => regionAtlas.aparc[hemisphere][vertex]);
  const middle = midSurface(vertices[`${hemisphere}.white`], vertices[`${hemisphere}.pial`]);
  const v1 = Uint8Array.from(wang, (label) => v1Labels.includes(label) ? 1 : 0);
  const peri = Uint8Array.from(aparc, (label) => label === pericalcarine ? 1 : 0);
  let both = 0;
  let v1Count = 0;
  let periCount = 0;
  let v1Occipital = 0;
  for (let i = 0; i < v1.length; i += 1) {
    both += v1[i] && peri[i];
    v1Count += v1[i];
    periCount += peri[i];
    v1Occipital += v1[i] && occipital.includes(aparc[i]) ? 1 : 0;
  }
  const atlasV1 = regionAtlas.wang2015[hemisphere].map((label) => v1Labels.includes(label) ? 1 : 0);
  const atlasPeri = regionAtlas.aparc[hemisphere].map((label) => label === pericalcarine ? 1 : 0);
  const atlasBoth = atlasV1.reduce((sum, member, i) => sum + (member && atlasPeri[i]), 0);
  mapped[hemisphere] = { middle, v1, wang, aparc };
  report.hemispheres[hemisphere] = {
    v1Vertices: v1Count,
    pericalcarineVertices: periCount,
    v1PericalcarineDice: 2 * both / (v1Count + periCount),
    fsaverageV1PericalcarineDice: 2 * atlasBoth / (atlasV1.reduce((a, b) => a + b, 0) + atlasPeri.reduce((a, b) => a + b, 0)),
    v1InOccipitalLobe: v1Occipital / v1Count,
    v1CentroidRas: centroid(middle, v1),
    hemisphereCentroidRas: centroid(middle, new Uint8Array(v1.length).fill(1)),
  };
}
const midline = (report.hemispheres.lh.hemisphereCentroidRas[0] + report.hemispheres.rh.hemisphereCentroidRas[0]) / 2;
for (const hemisphere of ['lh', 'rh']) {
  const result = report.hemispheres[hemisphere];
  let minY = Infinity;
  let maxY = -Infinity;
  for (let i = 1; i < mapped[hemisphere].middle.length; i += 3) {
    minY = Math.min(minY, mapped[hemisphere].middle[i]);
    maxY = Math.max(maxY, mapped[hemisphere].middle[i]);
  }
  result.v1PosteriorFraction = (result.v1CentroidRas[1] - minY) / (maxY - minY);
  result.v1MidlineDistanceMm = Math.abs(result.v1CentroidRas[0] - midline);
  result.hemisphereMidlineDistanceMm = Math.abs(result.hemisphereCentroidRas[0] - midline);
  assert.ok(result.v1PericalcarineDice >= MIN_V1_PERICALCARINE_DICE, `${hemisphere} V1/pericalcarine Dice ${result.v1PericalcarineDice}`);
  assert.ok(result.v1InOccipitalLobe >= MIN_V1_IN_OCCIPITAL, `${hemisphere} V1 in occipital lobe ${result.v1InOccipitalLobe}`);
  assert.ok(result.v1PosteriorFraction <= MAX_V1_POSTERIOR_FRACTION, `${hemisphere} V1 is not posterior: ${result.v1PosteriorFraction}`);
  assert.ok(result.v1MidlineDistanceMm < result.hemisphereMidlineDistanceMm, `${hemisphere} V1 is not medial`);
  const lateral = Math.sign(result.hemisphereCentroidRas[0] - midline);
  assert.equal(lateral, hemisphere === 'lh' ? -1 : 1, `${hemisphere} lies on the wrong side of the midline`);
}

const source = readVolume(await pinned('sub-01_T1w.browser-1mm.nii.gz', INPUT, INPUT_SHA256));
const loadAtlas = async () => cortexBytes.slice(0);
const loadRegions = async () => regionBytes.slice(0);
const search = (region, options = {}) => analyzeSurfaces({ source, vertices, faces, estimateNormals: false, patches: options, region, loadAtlas, loadRegions });

const whole = await search('cortex');
for (const [id, [area, rms]] of Object.entries(DOCUMENTED)) {
  const patch = whole.analysis.flat_patches[id];
  assert.ok(Math.abs(patch.area_mm2 - area) < 5e-7 && Math.abs(patch.rms_distance_mm - rms) < 5e-7, `whole-cortex ${id} moved from surface-analysis.md`);
}
assert.equal(Object.keys(whole.analysis.flat_patches).length, Object.keys(DOCUMENTED).length);

const v1 = await search('wang2015:V1');
for (const file of v1.files.filter(({ name }) => name.endsWith('.annot'))) {
  const hemisphere = file.name.slice(0, 2);
  const colours = REGION_ATLASES.wang2015.labels.map(({ rgb }) => rgb[0] + rgb[1] * 256 + rgb[2] * 65536);
  assert.deepEqual(readAnnotation(file.bytes), Int32Array.from(mapped[hemisphere].wang, (label) => label ? colours[label] : 0), `${file.name} differs from the mapping`);
  await writeFile(join(cache, file.name), Buffer.from(file.bytes));
}
const geometry = JSON.parse(new TextDecoder().decode(v1.files.find(({ id }) => id === 'patch-geometry').bytes)).patches;
assert.ok(Object.keys(geometry).length > 0, 'a V1 search found no patch');
for (const [id, patch] of Object.entries(geometry)) {
  const members = mapped[id.slice(0, 2).toLowerCase()].v1;
  assert.ok(patch.vertex_indices.every((vertex) => members[vertex]), `${id} leaves V1`);
}

for (const region of REGIONS) {
  try {
    const result = await search(region.id);
    const patches = Object.values(result.analysis.flat_patches);
    report.regions[region.id] = {
      lh: patches.filter((patch) => patch.surface === 'lh.mid').length,
      rh: patches.filter((patch) => patch.surface === 'rh.mid').length,
      minRmsMm: patches.length ? Math.min(...patches.map((patch) => patch.rms_distance_mm)) : null,
    };
  } catch (error) {
    report.regions[region.id] = { error: error.message };
  }
  console.error(region.id, JSON.stringify(report.regions[region.id]));
}
report.v1Patches = Object.fromEntries(Object.entries(v1.analysis.flat_patches).map(([id, patch]) => [id, { area_mm2: patch.area_mm2, rms_distance_mm: patch.rms_distance_mm, center_ras_mm: patch.center_ras_mm }]));
const text = `${JSON.stringify(report, null, 2)}\n`;
if (output) await writeFile(output, text);
process.stdout.write(text);
