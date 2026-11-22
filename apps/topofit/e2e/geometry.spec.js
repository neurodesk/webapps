import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { test, expect } from '@playwright/test';
import { writeSurfaceFiles } from '../../../packages/topofit/src/results.js';
import { createQcVolume } from '../../../packages/topofit/src/qc.js';
import { analyzeSurfaces } from '../../../packages/topofit/src/surface-analysis.js';
import { applyAffine, readVolume } from '../../../packages/topofit/src/volume.js';

const dispatch = (page, command, request = {}) =>
  page.evaluate(({ command, request }) => globalThis.neurodeskAutomation.dispatch(command, request), { command, request });

const ZERO_SROW = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];

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

// A 16x16x16 volume with a distinctive intensity gradient so voxel-to-world
// mapping is unambiguous on every axis.
function gradientValues(dims = [16, 16, 16]) {
  const [nx, ny, nz] = dims;
  const values = new Float32Array(nx * ny * nz);
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        values[x + nx * (y + ny * z)] = 100 + x * 10 + y * 2 + z;
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

// Builds synthetic surfaces, QC volume, patch QC and V1 region mask on the exact
// world-mm grid readVolume() resolves for `scanBuffer`.
async function buildAlignedOutputs(scanBuffer) {
  const arrayBuffer = scanBuffer.buffer.slice(scanBuffer.byteOffset, scanBuffer.byteOffset + scanBuffer.byteLength);
  const volume = readVolume(arrayBuffer);
  // A 14x14 voxel sheet at k=6 (white) and k=8 (pial) mapped into scanner RAS mm.
  const whiteVox = [];
  const pialVox = [];
  const faces = [];
  for (let j = 0; j < 14; j += 1) {
    for (let i = 0; i < 14; i += 1) {
      whiteVox.push(i + 1, j + 1, 6);
      pialVox.push(i + 1, j + 1, 8);
      const index = i + j * 14;
      if (i < 13 && j < 13) faces.push(index, index + 1, index + 14, index + 1, index + 15, index + 14);
    }
  }
  const white = Float64Array.from(applyAffine(volume.affine, Float32Array.from(whiteVox)));
  const pial = Float64Array.from(applyAffine(volume.affine, Float32Array.from(pialVox)));
  const vertices = {};
  const triangles = { lh: Int32Array.from(faces), rh: Int32Array.from(faces) };
  for (const h of ['lh', 'rh']) {
    vertices[`${h}.white`] = white;
    vertices[`${h}.pial`] = pial;
    vertices[`${h}.registration`] = Float64Array.from(whiteVox, (_, index) => index % 3 === 0 ? 1 : 0);
  }
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

async function patchPixels(page, clip) {
  const screenshot = await page.screenshot({ clip });
  return page.evaluate(async (base64) => {
    const image = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const { data } = context.getImageData(0, 0, image.width, image.height);
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] > 180 && data[i + 1] > 140 && data[i + 2] < 80) count += 1;
    }
    image.close();
    return count;
  }, screenshot.toString('base64'));
}

async function runAlignedCase(page, scanFile) {
  const { volume, surfaceFiles, qcBytes, analysis, surfaces } = await buildAlignedOutputs(scanFile.buffer);
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

  // Check source volume geometry and physical volume (mL, which uses pixDims in mm) agree with readVolume().
  const described = (await dispatch(page, 'viewers.niivue', {
    viewerId: 'image',
    method: 'describe_volume',
    params: { volume: 0, affine: true, stats: true },
  })).result;
  expect(described.dims.slice(0, 3)).toEqual(volume.dims);
  expectAffineClose(described.affine, volume.affine, 2);
  const voxelMm3 = [0, 1, 2].reduce((prod, axis) => prod * Math.hypot(volume.affine[0][axis], volume.affine[1][axis], volume.affine[2][axis]), 1);
  const expectedVolumeMl = (volume.dims[0] * volume.dims[1] * volume.dims[2] * voxelMm3) / 1000;
  expect(described.stats.volumeML).toBeCloseTo(expectedVolumeMl, 2);

  // Reconstruct and verify patch QC overlay, source QC overlay, region mask overlay, surface overlay and crosshair.
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
  expectAffineClose(patchQcDesc.affine, volume.affine, 2);
  // Location readout shows anatomy intensity and patch QC intensity (>= 2400) at the patch center.
  const locationNumbers = (await page.locator('#location').textContent()).split('=')[1].trim().split(/\s+/).map(Number);
  expect(locationNumbers[0]).toBeGreaterThanOrEqual(100);
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
  expectAffineClose(qcDescribed.affine, volume.affine, 2);

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
  expectAffineClose(maskDescribed.affine, volume.affine, 2);

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
  expect(await patchPixels(page, axial), 'Selected patch must highlight on the aligned axial slice').toBeGreaterThan(4);
}

const values = gradientValues([16, 16, 16]);

test('NIfTI-2 qform-only scan with zeroed srows aligns anatomy, overlays, surfaces and crosshair', async ({ page }) => {
  test.setTimeout(90_000);
  // 90° Z rotation, qfac = -1, non-zero offset, zeroed inactive srows.
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
  await runAlignedCase(page, { name: 'qform-only-nifti2.nii', mimeType: 'application/nifti', buffer });
});

for (const [format, build] of [['NIfTI-1', buildNifti1], ['NIfTI-2', buildNifti2]]) {
  test(`${format} micrometre scan aligns anatomy, overlays, surfaces and crosshair in millimetres`, async ({ page }) => {
    test.setTimeout(90_000);
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
    await runAlignedCase(page, { name: `${format.toLowerCase()}-um.nii`, mimeType: 'application/nifti', buffer });
  });

  test(`${format} metre scan aligns anatomy, overlays, surfaces and crosshair in millimetres`, async ({ page }) => {
    test.setTimeout(90_000);
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
    await runAlignedCase(page, { name: `${format.toLowerCase()}-m.nii`, mimeType: 'application/nifti', buffer });
  });
}

test('NIfTI-1 180-degree quaternion scan rounding past 1.0 aligns cleanly without NaN', async ({ page }) => {
  test.setTimeout(90_000);
  const b = Math.fround(0.6);
  const c = Math.fround(0.8);
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
  await runAlignedCase(page, { name: 'nifti1-180deg-qform.nii', mimeType: 'application/nifti', buffer });
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
      values: gradientValues([8, 8, 8]),
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
      values: gradientValues([10, 10, 10]),
    }),
  };

  // Hold NiiVue's volume-load worker request for `first-slow.nii` until released,
  // and capture any inference job to confirm which File stays active.
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

  // Start loading the second scan, then release the cancelled first scan's worker load.
  await page.locator('#imageInput').setInputFiles(secondScan);
  await page.evaluate(() => window.releaseFirstLoad?.());

  await expect(page.locator('#fileInfo')).toHaveText('second-active.nii', { timeout: 30_000 });
  await expect(page.locator('#statusText')).toContainText('Image loaded · ready to reconstruct');
  await expect(page.locator('#runButton')).toBeEnabled();
  await expect(page.locator('#viewerError')).toBeHidden();

  // Wait briefly to confirm no late stale completion replaces the second scan.
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
