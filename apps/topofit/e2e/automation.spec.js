import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readVolume } from '../../../packages/synthsr/src/volume.js';

const fixture = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
async function start(page) {
  await page.goto('/');
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: 'brain.nii.gz', mimeType: 'application/gzip', buffer: fixture });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'reconstruct' }));
}

test('automation surfaces the real inference worker model-integrity error', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/trega-synth-random.onnx*', (route) => route.fulfill({ body: '' }));
  await start(page);
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 90_000 }).toBe('failed');
  const result = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(result.error.message).toContain('Model size mismatch');
  expect(result.report).toBeUndefined();
  await expect(page.locator('#runButton')).toBeEnabled();
});

test('automation cancellation terminates a real worker awaiting its model', async ({ page }) => {
  test.setTimeout(120_000);
  await page.route('**/trega-synth-random.onnx*', () => {});
  const model = page.waitForRequest(/trega-synth-random\.onnx/, { timeout: 90_000 });
  await start(page);
  await model;
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('cancel'));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state).toBe('cancelled');
  await expect(page.locator('#runButton')).toBeEnabled();
  expect((await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).report).toBeUndefined();
});

// The published example (OpenNeuro ds000001 sub-01) and, for the same scan, the surfaces the
// original PyTorch TopoFit wrote inside the pinned OpenRecon container. Both are fetched at an
// immutable revision and verified against these digests before they are trusted.
const example = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'))[0].files[0];
const REFERENCE_URL = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/b438d1162e7192ca425ca47282b06fe62340c85a/topofit/0.5.1/onnx-20260911/validation/openrecon/end-to-end/surf/';
const REFERENCE_SHA256 = {
  'lh.white': '019b12b21a40c525f5b2574af5f31b55725d517b68e02cd811825974f4fc126b',
  'rh.white': '4a0c230add9cece03f713a7f706251a88db176b00faea2fcac0602fa34cdd1cd',
  'lh.pial': 'ea9d56cfa4274d0e21158bc5fb0b602e322ff92c2a0cffe8fccdb3b9bbd0fd96',
  'rh.pial': 'ddb4a4c2e9a15dc122928a9557b03b641d93a73594ae7065867b46ef686bd7cc',
};
// TopoFit deforms a fixed template: an icosahedral mesh of 62 vertices subdivided six times.
const VERTICES = 245762;
const FACES = 491520;

async function fetchPinned(url, sha256) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== sha256) throw new Error(`${url}: SHA-256 ${digest}, expected ${sha256}`);
  return bytes;
}

// FreeSurfer triangle surface: 3-byte magic, two comment lines, big-endian counts and data.
function readSurface(bytes) {
  expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xff, 0xff, 0xfe]);
  let offset = 3;
  for (let lines = 0; lines < 2;) if (bytes[offset++] === 10) lines += 1;
  const vertexCount = bytes.readInt32BE(offset);
  const faceCount = bytes.readInt32BE(offset + 4);
  offset += 8;
  expect(bytes.length).toBeGreaterThanOrEqual(offset + vertexCount * 12 + faceCount * 12);
  const vertices = new Float64Array(vertexCount * 3);
  for (let i = 0; i < vertices.length; i += 1) vertices[i] = bytes.readFloatBE(offset + i * 4);
  offset += vertexCount * 12;
  const faces = new Int32Array(faceCount * 3);
  for (let i = 0; i < faces.length; i += 1) faces[i] = bytes.readInt32BE(offset + i * 4);
  return { vertices, faces };
}

// Distance between vertices of the same index: the two meshes share the template topology.
function correspondingDistance(a, b) {
  const distances = new Float64Array(a.length / 3);
  let sum = 0;
  for (let i = 0; i < distances.length; i += 1) {
    distances[i] = Math.hypot(a[i * 3] - b[i * 3], a[i * 3 + 1] - b[i * 3 + 1], a[i * 3 + 2] - b[i * 3 + 2]);
    sum += distances[i];
  }
  distances.sort();
  // numpy.quantile(..., method='linear'), as validation/compare.py computes the release p95.
  const position = (distances.length - 1) * 0.95;
  const lower = Math.floor(position);
  const upper = Math.min(lower + 1, distances.length - 1);
  const p95 = distances[lower] + (distances[upper] - distances[lower]) * (position - lower);
  return { mean: sum / distances.length, p95, max: distances.at(-1) };
}

// A closed surface without handles: every edge joins two triangles and V - E + F = 2.
function closedSphere({ vertices, faces }) {
  const count = vertices.length / 3;
  const uses = new Map();
  for (let i = 0; i < faces.length; i += 3) {
    for (const [from, to] of [[faces[i], faces[i + 1]], [faces[i + 1], faces[i + 2]], [faces[i + 2], faces[i]]]) {
      const key = Math.min(from, to) * count + Math.max(from, to);
      uses.set(key, (uses.get(key) ?? 0) + 1);
    }
  }
  for (const value of uses.values()) if (value !== 2) return false;
  return count - uses.size + faces.length / 3 === 2;
}

test('full reconstruction exports every actual surface, QC and processing manifest', async ({ page }) => {
  test.setTimeout(1_500_000);
  const image = await fetchPinned(example.url, example.sha256);
  await page.goto('/');
  await page.locator('#neurodesk-input-transfer').setInputFiles({ name: example.name, mimeType: 'application/gzip', buffer: image });
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('adopt', { role: 'image' }));
  await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('start', { operation: 'reconstruct' }));
  await expect.poll(async () => (await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'))).state, { timeout: 1_200_000, intervals: [1000, 2000, 5000] }).not.toBe('running');
  const snapshot = await page.evaluate(() => globalThis.neurodeskAutomation.dispatch('snapshot'));
  expect(snapshot.state, snapshot.error?.message).toBe('succeeded');
  const roles = Object.values(snapshot.report.artifacts).map(({ role }) => role);
  expect(roles.filter((role) => role === 'surface')).toHaveLength(6);
  expect(roles.filter((role) => role === 'registration')).toHaveLength(2);
  expect(roles).toContain('qc');
  expect(roles).toContain('metadata');
  expect(snapshot.report.provenance.runtime.assets).toBeTruthy();
  const surfaces = {};
  for (const [artifactId, artifact] of Object.entries(snapshot.report.artifacts)) {
    const downloading = page.waitForEvent('download');
    await page.evaluate((artifactId) => globalThis.neurodeskAutomation.dispatch('download', { artifactId }), artifactId);
    const download = await downloading;
    const bytes = await readFile(await download.path());
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(artifact.sha256);
    if (artifact.role === 'surface') surfaces[download.suggestedFilename()] = readSurface(bytes);
  }
  expect(Object.keys(surfaces).sort()).toEqual(['lh.mid.white', 'lh.pial', 'lh.white', 'rh.mid.white', 'rh.pial', 'rh.white']);

  const source = readVolume(image.buffer.slice(image.byteOffset, image.byteOffset + image.byteLength));
  const centroid = {};
  const corners = [0, 1].flatMap((i) => [0, 1].flatMap((j) => [0, 1].map((k) => [i * (source.dims[0] - 1), j * (source.dims[1] - 1), k * (source.dims[2] - 1)])));
  for (const [name, surface] of Object.entries(surfaces)) {
    expect(surface.vertices.length / 3, name).toBe(VERTICES);
    expect(surface.faces.length / 3, name).toBe(FACES);
    expect(closedSphere(surface), `${name} must be a closed genus-0 surface`).toBe(true);
    // Scanner RAS millimetres: every vertex must fall inside the scanned field of view.
    const minimum = [Infinity, Infinity, Infinity];
    const maximum = [-Infinity, -Infinity, -Infinity];
    let sumX = 0;
    let finite = true;
    for (let i = 0; i < surface.vertices.length; i += 1) {
      const value = surface.vertices[i];
      if (!Number.isFinite(value)) finite = false;
      minimum[i % 3] = Math.min(minimum[i % 3], value);
      maximum[i % 3] = Math.max(maximum[i % 3], value);
      if (i % 3 === 0) sumX += value;
    }
    expect(finite, `${name} has a non-finite coordinate`).toBe(true);
    centroid[name] = sumX / VERTICES;
    for (const axis of [0, 1, 2]) {
      const extent = corners.map(([i, j, k]) => source.affine[axis][0] * i + source.affine[axis][1] * j + source.affine[axis][2] * k + source.affine[axis][3]);
      expect(minimum[axis], `${name} axis ${axis}`).toBeGreaterThan(Math.min(...extent));
      expect(maximum[axis], `${name} axis ${axis}`).toBeLessThan(Math.max(...extent));
    }
  }
  // +x is the patient's right, so the left hemisphere sits at lower x than the right one.
  expect(centroid['lh.white']).toBeLessThan(centroid['rh.white'] - 40);

  for (const hemisphere of ['lh', 'rh']) {
    // Cortical thickness: the mean white-to-pial distance of an adult is 2 to 3.5 mm.
    const thickness = correspondingDistance(surfaces[`${hemisphere}.white`].vertices, surfaces[`${hemisphere}.pial`].vertices);
    expect(thickness.mean).toBeGreaterThan(2);
    expect(thickness.mean).toBeLessThan(3.5);
    for (const layer of ['white', 'pial']) {
      const name = `${hemisphere}.${layer}`;
      const reference = readSurface(await fetchPinned(`${REFERENCE_URL}${name}`, REFERENCE_SHA256[name]));
      expect(Buffer.from(surfaces[name].faces.buffer).equals(Buffer.from(reference.faces.buffer)), `${name} faces differ from the reference topology`).toBe(true);
      const distance = correspondingDistance(surfaces[name].vertices, reference.vertices);
      console.log(`${name}: mean ${distance.mean.toFixed(3)} mm, p95 ${distance.p95.toFixed(3)} mm, max ${distance.max.toFixed(3)} mm from the PyTorch reference`);
      // The release gate of packages/topofit/validation/results/ds000001-end-to-end.json
      // (thresholds.py): the app's cubic conformer measures 0.046 to 0.068 mm mean, 0.164 mm
      // p95 and 0.467 mm max. niimath's conform measured 0.80 to 1.56 mm mean and fails it
      // (ds000001-niimath-baseline.json, docs/architecture/topofit-parity.md).
      expect(distance.mean, name).toBeLessThanOrEqual(0.25);
      expect(distance.p95, name).toBeLessThanOrEqual(0.5);
      expect(distance.max, name).toBeLessThanOrEqual(2);
    }
  }
});
