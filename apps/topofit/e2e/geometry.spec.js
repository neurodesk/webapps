import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import { writeSurfaceFiles } from '../../../packages/topofit/src/results.js';
import { createQcVolume } from '../../../packages/topofit/src/qc.js';
import { analyzeSurfaces } from '../../../packages/topofit/src/surface-analysis.js';
import { readVolume } from '../../../packages/topofit/src/volume.js';

const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));
const exampleAsset = examples[0].files[0];

const dispatch = (page, command, request = {}) =>
  page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

const ZERO_SROW = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
const LANDMARK_VOX = [11, 4, 11];
const BACKGROUND_VOX = [3, 12, 3];

function transformPoint(affine, [i, j, k]) {
  return [
    affine[0][0] * i + affine[0][1] * j + affine[0][2] * k + affine[0][3],
    affine[1][0] * i + affine[1][1] * j + affine[1][2] * k + affine[1][3],
    affine[2][0] * i + affine[2][1] * j + affine[2][2] * k + affine[2][3],
  ];
}

function buildNifti1({ dims, pixDims, qformCode, sformCode, quatern, qoffset, srow, xyztUnits, values }) {
  const count = dims[0] * dims[1] * dims[2];
  const buffer = Buffer.alloc(352 + count * 4);
  buffer.writeInt32LE(348, 0);
  buffer.writeInt16LE(3, 40);
  for (let i = 0; i < 3; i += 1) buffer.writeInt16LE(dims[i], 42 + i * 2);
  buffer.writeInt16LE(16, 70);
  buffer.writeInt16LE(32, 72);
  for (let i = 0; i < 4; i += 1) buffer.writeFloatLE(pixDims[i], 76 + i * 4);
  buffer.writeFloatLE(352, 108);
  buffer.writeFloatLE(1, 112);
  buffer.writeUInt8(xyztUnits, 123);
  buffer.writeInt16LE(qformCode, 252);
  buffer.writeInt16LE(sformCode, 254);
  for (let i = 0; i < 3; i += 1) buffer.writeFloatLE(quatern[i], 256 + i * 4);
  for (let i = 0; i < 3; i += 1) buffer.writeFloatLE(qoffset[i], 268 + i * 4);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) buffer.writeFloatLE(srow[r][c], 280 + (r * 4 + c) * 4);
  }
  buffer.write('n+1\0', 344, 'ascii');
  for (let i = 0; i < count; i += 1) buffer.writeFloatLE(values[i], 352 + i * 4);
  return buffer;
}

function buildNifti2({
  dims,
  pixDims,
  qformCode,
  sformCode,
  quatern,
  qoffset,
  srow,
  xyztUnits,
  values,
  datatypeCode = 16,
  bitpix = 32,
  voxelBytes = null,
}) {
  const count = dims[0] * dims[1] * dims[2];
  const payloadBytes = voxelBytes ? voxelBytes.byteLength : count * (bitpix / 8);
  const buffer = Buffer.alloc(544 + payloadBytes);
  buffer.writeInt32LE(540, 0);
  Buffer.from([110, 43, 50, 0, 13, 10, 26, 10]).copy(buffer, 4);
  buffer.writeInt16LE(datatypeCode, 12);
  buffer.writeInt16LE(bitpix, 14);
  buffer.writeBigInt64LE(3n, 16);
  for (let i = 1; i < 8; i += 1) buffer.writeBigInt64LE(BigInt(dims[i - 1] ?? 1), 16 + i * 8);
  for (let i = 0; i < 4; i += 1) buffer.writeDoubleLE(pixDims[i], 104 + i * 8);
  buffer.writeBigInt64LE(544n, 168);
  buffer.writeDoubleLE(1, 176);
  buffer.writeInt32LE(qformCode, 344);
  buffer.writeInt32LE(sformCode, 348);
  for (let i = 0; i < 3; i += 1) buffer.writeDoubleLE(quatern[i], 352 + i * 8);
  for (let i = 0; i < 3; i += 1) buffer.writeDoubleLE(qoffset[i], 376 + i * 8);
  for (let r = 0; r < 3; r += 1) {
    for (let c = 0; c < 4; c += 1) buffer.writeDoubleLE(srow[r][c], 400 + (r * 4 + c) * 8);
  }
  buffer.writeInt32LE(xyztUnits, 500);
  if (voxelBytes) {
    Buffer.from(voxelBytes).copy(buffer, 544);
  } else {
    for (let i = 0; i < count; i += 1) buffer.writeFloatLE(values[i], 544 + i * 4);
  }
  return buffer;
}

// A 16x16x16 volume with a bright (1000) off-center 5x5x5 cube centered at
// LANDMARK_VOX (11, 4, 11) and low intensity (10) everywhere else so both
// point sampling and 3D volume rendering expose any orientation/unit error.
function landmarkValues(dims = [16, 16, 16]) {
  const [nx, ny, nz] = dims;
  const values = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const inLandmark = Math.abs(x - LANDMARK_VOX[0]) <= 2
          && Math.abs(y - LANDMARK_VOX[1]) <= 2
          && Math.abs(z - LANDMARK_VOX[2]) <= 2;
        values[x + nx * (y + ny * z)] = inLandmark ? 1000 : 10;
      }
    }
  }
  return values;
}

function expectAffineClose(actual, expected, precision = 2) {
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      expect(actual[r][c], `affine[${r}][${c}]`).toBeCloseTo(expected[r][c], precision);
    }
  }
}

// Builds a closed 3D cube mesh around `centerVox` mapped by the independent
// ground-truth `expectedAffine` (never derived from readVolume).
function cubeSurfaceAround(expectedAffine, centerVox, halfExtentVox = 2) {
  const [cx, cy, cz] = centerVox;
  const corners = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
  ].flatMap(([dx, dy, dz]) => transformPoint(expectedAffine, [
    cx + dx * halfExtentVox,
    cy + dy * halfExtentVox,
    cz + dz * halfExtentVox,
  ]));
  const faces = Int32Array.from([
    0, 2, 1, 0, 3, 2,
    4, 5, 6, 4, 6, 7,
    0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6,
    0, 4, 7, 0, 7, 3,
    1, 2, 6, 1, 6, 5,
  ]);
  return { vertices: Float64Array.from(corners), faces };
}

// Builds surfaces, QC volume, patch QC and V1 region mask using the independent
// analytical `expectedAffine` for surface coordinates, and verifies readVolume()
// agrees with `expectedAffine`.
async function buildAlignedOutputs(scanBuffer, expectedAffine) {
  const arrayBuffer = scanBuffer.buffer.slice(scanBuffer.byteOffset, scanBuffer.byteOffset + scanBuffer.byteLength);
  const volume = readVolume(arrayBuffer);
  expectAffineClose(volume.affine, expectedAffine, 3);

  // Left hemisphere: 14x14 sheet at k=6..8 for flat patch + V1 mask checks.
  const whiteVox = [];
  const pialVox = [];
  const lhFaces = [];
  for (let j = 0; j < 14; j += 1) {
    for (let i = 0; i < 14; i += 1) {
      whiteVox.push(i + 1, j + 1, 6);
      pialVox.push(i + 1, j + 1, 8);
      const index = i + j * 14;
      if (i < 13 && j < 13) lhFaces.push(index, index + 1, index + 14, index + 1, index + 15, index + 14);
    }
  }
  const mapVerts = (coords) => {
    const out = new Float64Array(coords.length);
    for (let i = 0; i < coords.length; i += 3) {
      out.set(transformPoint(expectedAffine, [coords[i], coords[i + 1], coords[i + 2]]), i);
    }
    return out;
  };
  const lhWhite = mapVerts(whiteVox);
  const lhPial = mapVerts(pialVox);
  const lhReg = Float64Array.from(whiteVox, (_, index) => index % 3 === 0 ? 1 : 0);

  // Right hemisphere: compact 3D cube tightly wrapping the off-center bright landmark.
  const landmarkCube = cubeSurfaceAround(expectedAffine, LANDMARK_VOX, 2);
  const landmarkCubeOuter = cubeSurfaceAround(expectedAffine, LANDMARK_VOX, 2.2);
  const rhReg = Float64Array.from(landmarkCube.vertices, (_, index) => index % 3 === 0 ? 1 : 0);

  const vertices = {
    'lh.white': lhWhite,
    'lh.pial': lhPial,
    'lh.registration': lhReg,
    'rh.white': landmarkCube.vertices,
    'rh.pial': landmarkCubeOuter.vertices,
    'rh.registration': rhReg,
  };
  const triangles = { lh: Int32Array.from(lhFaces), rh: landmarkCube.faces };
  const atlas = new ArrayBuffer(18);
  new DataView(atlas).setUint32(0, 1, true);
  new DataView(atlas).setFloat32(4, 1, true);
  new Uint8Array(atlas).set([1, 1], 16);
  const regionAtlas = Uint8Array.of(1, 0, 0, 0, 1, 1, 0, 0);
  const analysis = await analyzeSurfaces({
    source: volume,
    vertices,
    faces: triangles,
    patches: { hemisphere: 'lh', count: 1 },
    region: 'wang2015:V1',
    loadAtlas: async () => atlas,
    loadRegions: async () => regionAtlas.buffer.slice(0),
  });
  expect(analysis.analysis.flat_patch_status).toBe('PATCHES_FOUND');
  const surfaceFiles = writeSurfaceFiles(vertices, triangles);
  const qcBytes = createQcVolume(volume, vertices, 1);
  return {
    volume,
    surfaceFiles,
    qcBytes,
    analysis,
    surfaces: { vertices, faces: triangles },
  };
}

// Computes pixel count and centroid of pixels matching a colour predicate in a canvas region.
async function measurePixels(page, clip, kind) {
  const screenshot = await page.screenshot({ clip });
  return page.evaluate(async ({ base64, kind }) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data, width, height } = context.getImageData(0, 0, image.width, image.height);
    let count = 0;
    let sumX = 0;
    let sumY = 0;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        // Ignore corner HUD badges ("Render View" top-left, orientation cube bottom-left/right).
        if (x < 140 && (y < 50 || y > height - 140)) continue;
        if (x > width - 140 && y > height - 140) continue;
        const i = (y * width + x) * 4;
        const r = data[i];
        const g = data[i + 1];
        const b = data[i + 2];
        let match = false;
        if (kind === 'yellow') match = r > 180 && g > 140 && b < 80;
        else if (kind === 'orange') match = r > 65 && r > b + 25 && g > b + 10 && r > g + 8;
        else if (kind === 'bright-gray') match = r > 160 && g > 160 && b > 160 && Math.abs(r - g) < 25 && Math.abs(r - b) < 25;
        if (match) {
          count += 1;
          sumX += x;
          sumY += y;
        }
      }
    }
    image.close();
    return { count, cx: count ? sumX / count : NaN, cy: count ? sumY / count : NaN };
  }, { base64: screenshot.toString('base64'), kind });
}

function parseLocationCoords(text) {
  const coords = text.split('=')[0].trim().split('×').slice(0, 3).map(Number);
  return coords;
}

async function runAlignedCase(page, scanFile, expectedAffine) {
  const { volume, surfaceFiles, qcBytes, analysis, surfaces } = await buildAlignedOutputs(scanFile.buffer, expectedAffine);
  const landmarkRas = transformPoint(expectedAffine, LANDMARK_VOX);
  const backgroundRas = transformPoint(expectedAffine, BACKGROUND_VOX);
  const allFiles = [
    ...surfaceFiles,
    { id: 'qc', name: 'topofit_qc.nii', mediaType: 'application/nifti', bytes: qcBytes },
    ...analysis.files,
  ];
  await page.addInitScript(({ files, analysisData, surfacesData }) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(job, ...rest) {
        if (!this.fixture) return super.postMessage(job, ...rest);
        window.lastTopofitJob = job;
        const reconstructedFiles = files.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes).buffer }));
        const vertices = Object.fromEntries(Object.entries(surfacesData.vertices).map(([name, values]) => [name, Float32Array.from(values)]));
        const faces = Object.fromEntries(Object.entries(surfacesData.faces).map(([name, values]) => [name, Int32Array.from(values)]));
        this.onmessage({
          data: {
            type: 'result',
            files: reconstructedFiles,
            surfaces: { vertices, faces },
            provenance: { surfaceVertices: vertices['lh.white'].length / 3, surfaceAnalysis: analysisData, runtime: {}, outputSha256: {} },
            elapsedSeconds: 1,
          },
        });
      }
    };
  }, {
    files: allFiles.map((file) => ({ ...file, bytes: Array.from(new Uint8Array(file.bytes)) })),
    analysisData: analysis.analysis,
    surfacesData: {
      vertices: Object.fromEntries(Object.entries(surfaces.vertices).map(([name, values]) => [name, Array.from(values)])),
      faces: Object.fromEntries(Object.entries(surfaces.faces).map(([name, values]) => [name, Array.from(values)])),
    },
  });

  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(scanFile);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#viewerError')).toBeHidden();

  // Check source volume geometry and physical volume (mL) match the independent ground truth.
  const described = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: true },
  })).result;
  expect(described.dims.slice(0, 3)).toEqual(volume.dims);
  expectAffineClose(described.affine, expectedAffine, 2);
  const voxelMm3 = [0, 1, 2].reduce((prod, axis) => prod * Math.hypot(expectedAffine[0][axis], expectedAffine[1][axis], expectedAffine[2][axis]), 1);
  const expectedVolumeMl = (volume.dims[0] * volume.dims[1] * volume.dims[2] * voxelMm3) / 1000;
  expect(described.stats.volumeML).toBeCloseTo(expectedVolumeMl, 2);

  // Independently verify voxel-to-world mapping by moving crosshair to the off-center bright landmark
  // and to the opposite dark background quadrant using coordinates computed directly from expectedAffine.
  await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'go_to_point', params: { mm: landmarkRas } });
  const atLandmark = Number((await page.locator('#location').textContent()).split('=')[1].trim().split(/\s+/)[0]);
  expect(atLandmark).toBeCloseTo(1000, 0);
  await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'go_to_point', params: { mm: backgroundRas } });
  const atBackground = Number((await page.locator('#location').textContent()).split('=')[1].trim().split(/\s+/)[0]);
  expect(atBackground).toBeCloseTo(10, 0);

  // Reconstruct and verify patch QC overlay, source QC overlay, region mask overlay, 2D slice and 3D render alignment.
  await page.locator('#runButton').click();
  await expect(page.locator('#imageLabel')).toContainText('PATCHES', { timeout: 30_000 });
  await expect(page.locator('#viewerError')).toBeHidden();

  const patchCenter = analysis.analysis.flat_patches.LH01.center_ras_mm;
  const wherePatchQc = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;
  for (let axis = 0; axis < 3; axis += 1) {
    expect(wherePatchQc.crosshair.mm[axis]).toBeCloseTo(patchCenter[axis], 0);
  }
  expect(wherePatchQc.volumes).toHaveLength(2);
  const patchQcDesc = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 1, affine: true, stats: false },
  })).result;
  expectAffineClose(patchQcDesc.affine, expectedAffine, 2);
  const locationNumbers = (await page.locator('#location').textContent()).split('=')[1].trim().split(/\s+/).map(Number);
  expect(locationNumbers[0]).toBeGreaterThanOrEqual(10);
  expect(locationNumbers[1]).toBeGreaterThanOrEqual(2400);

  // Source-grid QC overlay shares the exact same millimetre affine as the anatomy.
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Source-grid QC overlay' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('TOPOFIT QC');
  await expect(page.locator('#viewerError')).toBeHidden();
  const qcDescribed = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 1, affine: true, stats: false },
  })).result;
  expectAffineClose(qcDescribed.affine, expectedAffine, 2);

  // Region mask overlay shares the exact millimetre affine and places Left V1 at the crosshair centroid.
  await page.locator('.nd-volume-toggle').filter({ hasText: 'V1 mask in the cortical ribbon' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('V1 SEARCH REGION');
  await expect(page.locator('#viewerError')).toBeHidden();
  await expect(page.locator('#location')).toContainText('Left V1');
  const maskDescribed = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 1, affine: true, stats: false },
  })).result;
  expectAffineClose(maskDescribed.affine, expectedAffine, 2);

  // Flat patch mesh overlay aligns with the anatomy slice and crosshair in mm.
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Left flat patch 1' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('Left flat patch 1');
  await expect(page.locator('#viewerError')).toBeHidden();
  const wherePatch = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;
  for (let axis = 0; axis < 3; axis += 1) {
    expect(wherePatch.crosshair.mm[axis]).toBeCloseTo(patchCenter[axis], 0);
  }
  const canvas = await page.locator('#gl1').boundingBox();
  const axial = {
    x: canvas.x,
    y: canvas.y + canvas.height / 2,
    width: Math.floor(canvas.width / 2),
    height: Math.floor(canvas.height / 2),
  };
  expect((await measurePixels(page, axial, 'yellow')).count, 'Selected patch must highlight on the aligned axial slice').toBeGreaterThan(4);

  // 3D Render registration: verify the Right white surface (wrapping the off-center landmark)
  // and the 3D rendered bright anatomical landmark project to the same 3D screen position.
  await page.getByRole('radio', { name: 'Render view', exact: true }).click();
  const rhRow = page.locator('.nd-volume-toggle').filter({ hasText: 'Right white surface' });
  await rhRow.getByRole('button', { name: 'View', exact: true }).click();
  await expect(rhRow.getByRole('checkbox')).toBeChecked();
  await expect(rhRow.getByRole('checkbox')).toBeEnabled();
  const renderBox = await page.locator('#gl1').boundingBox();
  const surface3D = await measurePixels(page, renderBox, 'orange');
  expect(surface3D.count, '3D landmark surface must render in Render view').toBeGreaterThan(50);

  // Reveal 3D anatomy via FreeBrowse, then hide the surface so we measure the 3D anatomy landmark alone
  // under the exact same camera and volume extents.
  await page.getByTitle('Show sidebar', { exact: true }).click();
  await page.getByRole('tab', { name: 'Volumes', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle visibility', exact: true }).click();
  await page.getByTitle('Hide sidebar', { exact: true }).click();
  await rhRow.getByRole('checkbox').uncheck();
  await expect(rhRow.getByRole('checkbox')).toBeEnabled();
  const anatomy3D = await measurePixels(page, renderBox, 'bright-gray');
  expect(anatomy3D.count, '3D bright anatomical landmark must render when 3D anatomy is visible').toBeGreaterThan(50);
  const centroidDistancePx = Math.hypot(surface3D.cx - anatomy3D.cx, surface3D.cy - anatomy3D.cy);
  expect(
    centroidDistancePx,
    `3D surface centroid (${surface3D.cx.toFixed(1)}, ${surface3D.cy.toFixed(1)}) must align with 3D landmark centroid (${anatomy3D.cx.toFixed(1)}, ${anatomy3D.cy.toFixed(1)})`,
  ).toBeLessThan(18);
}

const values = landmarkValues([16, 16, 16]);

test('NIfTI-2 qform-only scan with zeroed srows aligns anatomy, overlays, surfaces, 3D render and crosshair', async ({ page }) => {
  test.setTimeout(90_000);
  // 90° Z rotation, qfac = -1, spacing 1.5 mm, offset (12, -10, 20), zeroed inactive srows.
  const expectedAffine = [
    [0, -1.5, 0, 12],
    [1.5, 0, 0, -10],
    [0, 0, -1.5, 20],
    [0, 0, 0, 1],
  ];
  const buffer = buildNifti2({
    dims: [16, 16, 16],
    pixDims: [-1, 1.5, 1.5, 1.5],
    qformCode: 1,
    sformCode: 0,
    quatern: [0, 0, Math.SQRT1_2],
    qoffset: [12, -10, 20],
    srow: ZERO_SROW,
    xyztUnits: 2,
    values,
  });
  await runAlignedCase(page, { name: 'qform-only-nifti2.nii', mimeType: 'application/nifti', buffer }, expectedAffine);
});

for (const [format, build] of [['NIfTI-1', buildNifti1], ['NIfTI-2', buildNifti2]]) {
  test(`${format} micrometre scan aligns anatomy, overlays, surfaces, 3D render and crosshair in millimetres`, async ({ page }) => {
    test.setTimeout(90_000);
    const expectedAffine = [
      [1, 0, 0, -5],
      [0, 1, 0, -6],
      [0, 0, 1, -7],
      [0, 0, 0, 1],
    ];
    const buffer = build({
      dims: [16, 16, 16],
      pixDims: [1, 1000, 1000, 1000],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[1000, 0, 0, -5000], [0, 1000, 0, -6000], [0, 0, 1000, -7000]],
      xyztUnits: 3,
      values,
    });
    await runAlignedCase(page, { name: `${format.toLowerCase()}-um.nii`, mimeType: 'application/nifti', buffer }, expectedAffine);
  });

  test(`${format} metre scan aligns anatomy, overlays, surfaces, 3D render and crosshair in millimetres`, async ({ page }) => {
    test.setTimeout(90_000);
    const expectedAffine = [
      [1, 0, 0, -5],
      [0, 1, 0, -6],
      [0, 0, 1, -7],
      [0, 0, 0, 1],
    ];
    const buffer = build({
      dims: [16, 16, 16],
      pixDims: [1, 0.001, 0.001, 0.001],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[0.001, 0, 0, -0.005], [0, 0.001, 0, -0.006], [0, 0, 0.001, -0.007]],
      xyztUnits: 1,
      values,
    });
    await runAlignedCase(page, { name: `${format.toLowerCase()}-m.nii`, mimeType: 'application/nifti', buffer }, expectedAffine);
  });
}

test('NIfTI-1 180-degree quaternion scan rounding past 1.0 aligns cleanly without NaN', async ({ page }) => {
  test.setTimeout(90_000);
  const b = Math.fround(0.6);
  const c = Math.fround(0.8);
  // 180° rotation about (0.6, 0.8, 0) with qfac = -1 => R = [[-0.28, 0.96, 0], [0.96, 0.28, 0], [0, 0, 1]]
  const expectedAffine = [
    [-0.28, 0.96, 0, 4],
    [0.96, 0.28, 0, -5],
    [0, 0, 1, 6],
    [0, 0, 0, 1],
  ];
  const buffer = buildNifti1({
    dims: [16, 16, 16],
    pixDims: [-1, 1, 1, 1],
    qformCode: 1,
    sformCode: 0,
    quatern: [b, c, 0],
    qoffset: [4, -5, 6],
    srow: ZERO_SROW,
    xyztUnits: 2,
    values,
  });
  await runAlignedCase(page, { name: 'nifti1-180deg-qform.nii', mimeType: 'application/nifti', buffer }, expectedAffine);
});

test('real brain scan converted to NIfTI-2 qform-only and bad-CRC gzip matches NIfTI-1 geometry in the viewer', async ({ page }) => {
  test.setTimeout(90_000);
  const rawNifti1 = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
  const ab = rawNifti1.buffer.slice(rawNifti1.byteOffset, rawNifti1.byteOffset + rawNifti1.byteLength);
  const refVol = readVolume(ab);
  const h1 = refVol.header;
  const voxelBytes = new Uint8Array(
    refVol.source,
    h1.vox_offset,
    refVol.dims[0] * refVol.dims[1] * refVol.dims[2] * (h1.numBitsPerVoxel / 8),
  );

  const nifti2Buf = buildNifti2({
    dims: refVol.dims,
    pixDims: [h1.pixDims[0], h1.pixDims[1], h1.pixDims[2], h1.pixDims[3]],
    qformCode: h1.qform_code,
    sformCode: 0,
    quatern: [h1.quatern_b, h1.quatern_c, h1.quatern_d],
    qoffset: [h1.qoffset_x, h1.qoffset_y, h1.qoffset_z],
    srow: ZERO_SROW,
    xyztUnits: 2,
    datatypeCode: h1.datatypeCode,
    bitpix: h1.numBitsPerVoxel,
    voxelBytes,
  });
  const gzBadCrc = Buffer.from(gzipSync(nifti2Buf));
  gzBadCrc[gzBadCrc.length - 8] ^= 0xff;

  await page.goto('/');
  await page.locator('#imageInput').setInputFiles({ name: 'real-brain-nifti1.nii.gz', mimeType: 'application/gzip', buffer: rawNifti1 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30_000 });
  const nifti1Desc = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: true },
  })).result;
  const nifti1Where = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;

  await page.locator('#imageInput').setInputFiles({ name: 'real-brain-nifti2-qform.nii.gz', mimeType: 'application/gzip', buffer: gzBadCrc });
  await expect(page.locator('#fileInfo')).toHaveText('real-brain-nifti2-qform.nii.gz', { timeout: 30_000 });
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30_000 });
  await expect(page.locator('#viewerError')).toBeHidden();
  const nifti2Desc = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: true },
  })).result;
  const nifti2Where = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;

  expect(nifti2Desc.dims.slice(0, 3)).toEqual(nifti1Desc.dims.slice(0, 3));
  expectAffineClose(nifti2Desc.affine, nifti1Desc.affine, 2);
  expect(nifti2Desc.stats.volumeML).toBeCloseTo(nifti1Desc.stats.volumeML, 2);
  for (let axis = 0; axis < 3; axis += 1) {
    expect(nifti2Where.crosshair.mm[axis]).toBeCloseTo(nifti1Where.crosshair.mm[axis], 1);
  }
});

test('qform-only NIfTI-2 scan with zero voxel spacing is rejected in the viewer and preserves any prior scan', async ({ page }) => {
  test.setTimeout(60_000);
  const badZeroSpacing = {
    name: 'zero-spacing-nifti2.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti2({
      dims: [8, 8, 8],
      pixDims: [1, 0, 2, 2],
      qformCode: 1,
      sformCode: 0,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: ZERO_SROW,
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };
  const validScan = {
    name: 'valid-prior.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti1({
      dims: [8, 8, 8],
      pixDims: [1, 2, 2, 2],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[2, 0, 0, -5], [0, 2, 0, -6], [0, 0, 2, -7]],
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };

  await page.goto('/');
  // Rejected on empty workspace: never enables reconstruction.
  await page.locator('#imageInput').setInputFiles(badZeroSpacing);
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await expect(page.locator('#statusText')).toContainText('voxel spacing must be finite and positive');
  await expect(page.locator('#runButton')).toBeDisabled();

  // Rejected after a valid scan: preserves the valid scan in UI and viewer.
  await page.locator('#imageInput').setInputFiles(validScan);
  await expect(page.locator('#fileInfo')).toHaveText('valid-prior.nii');
  await expect(page.locator('#runButton')).toBeEnabled();
  await page.locator('#imageInput').setInputFiles(badZeroSpacing);
  await expect(page.locator('#statusText')).toHaveClass(/error/);
  await expect(page.locator('#fileInfo')).toHaveText('valid-prior.nii');
  await expect(page.locator('#runButton')).toBeEnabled();
  const described = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: false },
  })).result;
  expect(described.volume.name).toBe('valid-prior.nii');
});

test('cancelling a slow load and immediately loading a second scan leaves the second scan active', async ({ page }) => {
  test.setTimeout(90_000);
  const firstScan = {
    name: 'first-slow.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti1({
      dims: [8, 8, 8],
      pixDims: [1, 2, 2, 2],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[2, 0, 0, -50], [0, 2, 0, -50], [0, 0, 2, -50]],
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };
  const secondScan = {
    name: 'second-active.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti2({
      dims: [10, 10, 10],
      pixDims: [1, 1000, 1000, 1000],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[1000, 0, 0, 10000], [0, 1000, 0, 20000], [0, 0, 1000, 30000]],
      xyztUnits: 3,
      values: landmarkValues([10, 10, 10]),
    }),
  };

  await page.addInitScript(() => {
    window.releaseFirstLoad = null;
    window.firstLoadStarted = new Promise((resolve) => { window.markFirstLoadStarted = resolve; });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(msg, ...rest) {
        if (this.fixture) {
          window.postedFileName = msg.file?.name;
          this.onmessage({ data: { type: 'error', message: 'Probe complete' } });
          return;
        }
        const name = msg?.name ?? msg?.url?.name ?? msg?.payload?.name ?? msg?.payload?.url?.name ?? msg?.data?.name ?? msg?.data?.url?.name;
        if (name === 'first-slow.nii') {
          window.markFirstLoadStarted();
          window.releaseFirstLoad = () => super.postMessage(msg, ...rest);
          return;
        }
        return super.postMessage(msg, ...rest);
      }
    };
  });

  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(firstScan);
  await expect(page.locator('#cancelButton')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => window.firstLoadStarted);
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toContainText('cancelled');
  await expect(page.locator('#imageInput')).toBeEnabled();

  await page.locator('#imageInput').setInputFiles(secondScan);
  await page.evaluate(() => window.releaseFirstLoad?.());

  await expect(page.locator('#fileInfo')).toHaveText('second-active.nii', { timeout: 30_000 });
  await expect(page.locator('#statusText')).toContainText('Image loaded · ready to reconstruct');
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#viewerError')).toBeHidden();

  await page.waitForTimeout(300);
  await expect(page.locator('#fileInfo')).toHaveText('second-active.nii');
  const described = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: false },
  })).result;
  expect(described.volume.name).toBe('second-active.nii');
  expect(described.dims.slice(0, 3)).toEqual([10, 10, 10]);
  expectAffineClose(described.affine, [[1, 0, 0, 10], [0, 1, 0, 20], [0, 0, 1, 30], [0, 0, 0, 1]], 2);

  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => window.postedFileName)).toBe('second-active.nii');
});

test('cancelling a load during mesh cleanup rolls back the viewer to match the active scan', async ({ page }) => {
  test.setTimeout(90_000);
  const scanA = {
    name: 'scan-a.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti1({
      dims: [8, 8, 8],
      pixDims: [1, 2, 2, 2],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[2, 0, 0, -50], [0, 2, 0, -50], [0, 0, 2, -50]],
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };
  const scanB = {
    name: 'scan-b.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti2({
      dims: [10, 10, 10],
      pixDims: [1, 1000, 1000, 1000],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[1000, 0, 0, 10000], [0, 1000, 0, 20000], [0, 0, 1000, 30000]],
      xyztUnits: 3,
      values: landmarkValues([10, 10, 10]),
    }),
  };

  // Intercept NiiVue's removeAllMeshes so we can cancel right inside mesh cleanup after scan B loaded into NiiVue.
  await page.addInitScript(() => {
    window.holdNextMeshCleanup = false;
    window.releaseMeshCleanup = null;
    window.meshCleanupStarted = new Promise((resolve) => { window.markMeshCleanupStarted = resolve; });
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (type === 'volumeRemoved' && typeof this.removeAllMeshes === 'function' && !this.__meshHooked) {
        this.__meshHooked = true;
        const origRemoveAll = this.removeAllMeshes.bind(this);
        this.removeAllMeshes = async () => {
          if (window.holdNextMeshCleanup) {
            window.holdNextMeshCleanup = false;
            window.markMeshCleanupStarted();
            await new Promise((resolve) => { window.releaseMeshCleanup = resolve; });
          }
          return origRemoveAll();
        };
      }
      return nativeAddEventListener.call(this, type, ...rest);
    };
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(msg, ...rest) {
        if (!this.fixture) return super.postMessage(msg, ...rest);
        window.postedFileName = msg.file?.name;
        this.onmessage({ data: { type: 'error', message: 'Probe complete' } });
      }
    };
  });

  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(scanA);
  await expect(page.locator('#fileInfo')).toHaveText('scan-a.nii', { timeout: 30_000 });
  await expect(page.locator('#runButton')).toBeEnabled();

  await page.evaluate(() => { window.holdNextMeshCleanup = true; });
  await page.locator('#imageInput').setInputFiles(scanB);
  await page.evaluate(() => window.meshCleanupStarted);
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toContainText('cancelled');
  await page.evaluate(() => window.releaseMeshCleanup?.());

  // Viewer must roll back to scan-a.nii, matching fileInfo and reconstruction input.
  await expect.poll(async () => (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: false },
  })).result.volume.name, { timeout: 15_000 }).toBe('scan-a.nii');
  await expect(page.locator('#fileInfo')).toHaveText('scan-a.nii');
  const described = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: false },
  })).result;
  expect(described.dims.slice(0, 3)).toEqual([8, 8, 8]);
  expectAffineClose(described.affine, [[2, 0, 0, -50], [0, 2, 0, -50], [0, 0, 2, -50], [0, 0, 0, 1]], 2);

  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => window.postedFileName)).toBe('scan-a.nii');

  // Reproducing Sol 6.2 r2 P1: cancel B during mesh cleanup, then select an invalid C
  // before B's cleanup finishes. C fails before reaching the viewer, and the viewer must
  // still roll back to scan-a.nii instead of leaving cancelled scan-b.nii displayed.
  const invalidScanC = {
    name: 'invalid-scan-c.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti2({
      dims: [8, 8, 8],
      pixDims: [1, 0, 2, 2],
      qformCode: 1,
      sformCode: 0,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: ZERO_SROW,
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };
  await page.evaluate(() => {
    window.postedFileName = null;
    window.holdNextMeshCleanup = true;
    window.meshCleanupStarted = new Promise((resolve) => { window.markMeshCleanupStarted = resolve; });
  });
  await page.locator('#imageInput').setInputFiles(scanB);
  await page.evaluate(() => window.meshCleanupStarted);
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toContainText('cancelled');
  await page.locator('#imageInput').setInputFiles(invalidScanC);
  await expect(page.locator('#statusText')).toContainText(/voxel spacing|singular/i);
  await page.evaluate(() => window.releaseMeshCleanup?.());

  await expect.poll(async () => (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: false },
  })).result.volume.name, { timeout: 15_000 }).toBe('scan-a.nii');
  await expect(page.locator('#fileInfo')).toHaveText('scan-a.nii');
  await page.locator('#runButton').click();
  await expect.poll(() => page.evaluate(() => window.postedFileName)).toBe('scan-a.nii');
});

test('cancelling an example during viewer decode leaves the app cancelled without enabling reconstruction', async ({ page }) => {
  test.setTimeout(60_000);
  // Build a valid NIfTI-1 file padded to the exact byte length expected by examples.json,
  // and stub SHA-256 verification so this test runs offline with no network dependency.
  const baseNifti = buildNifti1({
    dims: [8, 8, 8],
    pixDims: [1, 1, 1, 1],
    qformCode: 0,
    sformCode: 1,
    quatern: [0, 0, 0],
    qoffset: [0, 0, 0],
    srow: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
    xyztUnits: 2,
    values: landmarkValues([8, 8, 8]),
  });
  const padded = Buffer.alloc(exampleAsset.bytes);
  baseNifti.copy(padded, 0);

  await page.context().route(exampleAsset.url, (route) => route.fulfill({
    status: 200,
    contentType: 'application/octet-stream',
    body: padded,
  }));

  await page.addInitScript(({ expectedHex, exampleName }) => {
    const expectedBytes = Uint8Array.from(expectedHex.match(/../g).map((pair) => parseInt(pair, 16)));
    const nativeDigest = crypto.subtle.digest.bind(crypto.subtle);
    crypto.subtle.digest = async (algorithm, data) => {
      if (data?.byteLength === expectedBytes.length || data?.byteLength > 1_000_000) {
        return expectedBytes.buffer.slice(0);
      }
      return nativeDigest(algorithm, data);
    };
    window.releaseExampleDecode = null;
    window.exampleDecodeStarted = new Promise((resolve) => { window.markExampleDecodeStarted = resolve; });
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      postMessage(msg, ...rest) {
        const name = msg?.name ?? msg?.url?.name ?? msg?.payload?.name ?? msg?.payload?.url?.name;
        if (name === exampleName) {
          window.markExampleDecodeStarted();
          window.releaseExampleDecode = () => super.postMessage(msg, ...rest);
          return;
        }
        return super.postMessage(msg, ...rest);
      }
    };
  }, { expectedHex: exampleAsset.sha256, exampleName: exampleAsset.name });

  await page.goto('/');
  await page.locator('[data-neurodesk-example]').selectOption('openneuro-t1');
  await page.evaluate(() => window.exampleDecodeStarted);
  await page.getByRole('button', { name: 'Cancel example download' }).click();
  await expect(page.locator('[data-neurodesk-examples]')).toHaveAttribute('data-example-state', 'cancelled');
  await page.evaluate(() => window.releaseExampleDecode?.());
  await page.waitForTimeout(300);

  await expect(page.locator('#runButton')).toBeDisabled();
  await expect(page.locator('#fileInfo')).toBeHidden();
  const where = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;
  expect(where.volume).toBeNull();
});

test('switching from a scan with a displaced mesh to a micrometre scan updates the crosshair readout to the new bounds', async ({ page }) => {
  test.setTimeout(90_000);
  const scanA = {
    name: 'scan-with-mesh.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti1({
      dims: [16, 16, 16],
      pixDims: [1, 1, 1, 1],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]],
      xyztUnits: 2,
      values,
    }),
  };
  // Displaced mesh far outside scan B's [-5..10] mm bounds so scene bounds shift sharply on mesh removal.
  const displacedVerts = Float32Array.from([100, 120, 140, 110, 120, 140, 100, 130, 140, 100, 120, 150]);
  const displacedFaces = Int32Array.from([0, 2, 1, 0, 1, 3, 0, 3, 2, 1, 2, 3]);
  const surfaceFiles = writeSurfaceFiles({
    'lh.white': displacedVerts,
    'lh.pial': displacedVerts,
    'lh.registration': displacedVerts,
    'rh.white': displacedVerts,
    'rh.pial': displacedVerts,
    'rh.registration': displacedVerts,
  }, { lh: displacedFaces, rh: displacedFaces });

  await page.addInitScript(({ files, qc }) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(job, ...rest) {
        if (!this.fixture) return super.postMessage(job, ...rest);
        const reconstructedFiles = files.map((file) => ({ ...file, bytes: Uint8Array.from(file.bytes).buffer }));
        reconstructedFiles.push({ id: 'qc', name: 'qc.nii', mediaType: 'application/nifti', bytes: Uint8Array.from(qc).buffer });
        this.onmessage({
          data: {
            type: 'result',
            files: reconstructedFiles,
            surfaces: null,
            provenance: { surfaceVertices: 4, surfaceAnalysis: null, runtime: {}, outputSha256: {} },
            elapsedSeconds: 1,
          },
        });
      }
    };
  }, {
    files: surfaceFiles.map((file) => ({ ...file, bytes: Array.from(new Uint8Array(file.bytes)) })),
    qc: Array.from(scanA.buffer),
  });

  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(scanA);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#outputSection')).toHaveAttribute('open', '', { timeout: 30_000 });
  await page.locator('.nd-volume-toggle').filter({ hasText: 'Left white surface' }).getByRole('button', { name: 'View', exact: true }).click();
  await expect(page.locator('#imageLabel')).toContainText('LEFT WHITE SURFACE');
  const oldCoords = parseLocationCoords(await page.locator('#location').textContent());
  expect(oldCoords[0]).toBeGreaterThan(80);

  // Switch to a micrometre scan centered at (2.5, 1.5, 0.5) mm.
  const scanB = {
    name: 'micrometre-target.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti2({
      dims: [16, 16, 16],
      pixDims: [1, 1000, 1000, 1000],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[1000, 0, 0, -5000], [0, 1000, 0, -6000], [0, 0, 1000, -7000]],
      xyztUnits: 3,
      values,
    }),
  };
  await page.locator('#imageInput').setInputFiles(scanB);
  await expect(page.locator('#fileInfo')).toHaveText('micrometre-target.nii', { timeout: 30_000 });
  await expect(page.locator('#runButton')).toBeEnabled();

  const whereNew = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;
  const shownCoords = parseLocationCoords(await page.locator('#location').textContent());
  for (let axis = 0; axis < 3; axis += 1) {
    expect(shownCoords[axis]).toBeCloseTo(whereNew.crosshair.mm[axis], 0);
    expect(Math.abs(shownCoords[axis])).toBeLessThan(20);
  }
});

test('cancelling a replacement during mesh cleanup restores the active QC overlay', async ({ page }) => {
  test.setTimeout(60_000);
  const scanA = {
    name: 'scan-qc-a.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti1({
      dims: [8, 8, 8],
      pixDims: [1, 2, 2, 2],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[2, 0, 0, -10], [0, 2, 0, -10], [0, 0, 2, -10]],
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };
  const scanB = {
    name: 'scan-qc-b.nii',
    mimeType: 'application/nifti',
    buffer: buildNifti1({
      dims: [8, 8, 8],
      pixDims: [1, 1, 1, 1],
      qformCode: 0,
      sformCode: 1,
      quatern: [0, 0, 0],
      qoffset: [0, 0, 0],
      srow: [[1, 0, 0, 5], [0, 1, 0, 5], [0, 0, 1, 5]],
      xyztUnits: 2,
      values: landmarkValues([8, 8, 8]),
    }),
  };

  await page.addInitScript(({ qc }) => {
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.fixture = String(url).includes('inference-worker');
      }
      postMessage(job, ...rest) {
        if (!this.fixture) return super.postMessage(job, ...rest);
        this.onmessage({
          data: {
            type: 'result',
            files: [{ id: 'qc', name: 'qc.nii', mediaType: 'application/nifti', bytes: Uint8Array.from(qc).buffer }],
            surfaces: null,
            provenance: { surfaceVertices: 4, surfaceAnalysis: null, runtime: {}, outputSha256: {} },
            elapsedSeconds: 1,
          },
        });
      }
    };
    window.holdNextMeshCleanup = false;
    window.releaseMeshCleanup = null;
    window.meshCleanupStarted = new Promise((resolve) => { window.markMeshCleanupStarted = resolve; });
    const nativeAddEventListener = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, ...rest) {
      if (type === 'volumeRemoved' && typeof this.removeAllMeshes === 'function' && !this.__meshHooked) {
        this.__meshHooked = true;
        const origRemoveAll = this.removeAllMeshes.bind(this);
        this.removeAllMeshes = async () => {
          if (window.holdNextMeshCleanup) {
            window.holdNextMeshCleanup = false;
            window.markMeshCleanupStarted();
            await new Promise((resolve) => { window.releaseMeshCleanup = resolve; });
          }
          return origRemoveAll();
        };
      }
      return nativeAddEventListener.call(this, type, ...rest);
    };
  }, { qc: Array.from(scanA.buffer) });

  await page.goto('/');
  await page.locator('#imageInput').setInputFiles(scanA);
  await expect(page.locator('#runButton')).toBeEnabled({ timeout: 30_000 });
  await page.locator('#runButton').click();
  await expect(page.locator('#outputSection')).toHaveAttribute('open', '', { timeout: 30_000 });
  await expect(page.locator('#imageLabel')).toContainText('TOPOFIT QC');
  const before = (await dispatch(page, 'viewers.niivue', { viewerId: 'image', method: 'where_am_i' })).result;
  expect(before.volumes).toHaveLength(2);

  await page.evaluate(() => {
    window.holdNextMeshCleanup = true;
  });
  await page.locator('#imageInput').setInputFiles(scanB);
  await page.evaluate(() => window.meshCleanupStarted);
  await page.locator('#cancelButton').click();
  await expect(page.locator('#statusText')).toContainText('cancelled');
  await page.evaluate(() => window.releaseMeshCleanup?.());

  await expect.poll(async () => (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'where_am_i',
  })).result.volumes.map((v) => v.name), { timeout: 15_000 }).toEqual(['scan-qc-a.nii', 'qc.nii']);
  await expect(page.locator('#imageLabel')).toContainText('TOPOFIT QC');
  await expect(page.locator('#fileInfo')).toHaveText('scan-qc-a.nii');
});
