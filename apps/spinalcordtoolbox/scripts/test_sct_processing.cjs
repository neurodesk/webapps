#!/usr/bin/env node

const assert = require('node:assert/strict');
const path = require('node:path');
const loadClassicScript = require('./load-classic-script.cjs');
const {
  index3D,
  subtractVolumes,
  computeMTR,
  computeMTsat,
  meanTimeSeries,
  identifyB0Dwi,
  splitB0Dwi,
  computeDtiMetrics,
  centerlineFromSegmentation,
  createCylinderMask,
  boundingBoxFromMask,
  cropVolume,
  sliceMorphometry,
  morphometryToCsv,
  createLabelsFromVertBody,
  smoothAlongAxis,
  extractMetricByLabels,
  metricRowsToCsv,
  createQcReportHtml,
  getSctExampleDataManifest,
  getBrowserModelInstallPlan,
  labelVertebraeFromSegmentation,
  registerByCenterOfMass,
  applyTranslation,
  warpTemplate,
  detectPmj,
  flattenSagittal,
  motionCorrectTimeSeries
} = loadClassicScript(path.join(__dirname, '../web/js/modules/sct-processing.js'));

function makeVolume(dims, fill = 0) {
  return new Float32Array(dims[0] * dims[1] * dims[2]).fill(fill);
}

function countNonzero(data) {
  let count = 0;
  for (const value of data) if (value) count++;
  return count;
}

function assertNearlyEqual(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ~= ${expected}`);
}

{
  const dims = [2, 2, 1];
  const left = new Float32Array([4, 5, 6, 7]);
  const right = new Float32Array([1, 2, 3, 4]);
  assert.deepEqual(Array.from(subtractVolumes(left, right, dims)), [3, 3, 3, 3]);
}

{
  const data = new Float32Array([
    1, 2, 3, 4,
    3, 4, 5, 6,
    5, 6, 7, 8
  ]);
  assert.deepEqual(Array.from(meanTimeSeries(data, [2, 2, 1, 3])), [3, 4, 5, 6]);
}

{
  const dims = [4, 1, 1];
  const mt0 = new Float32Array([100, 100, 0, 100]);
  const mt1 = new Float32Array([80, 120, 10, -100]);
  const mtr = computeMTR(mt0, mt1, dims, 100);
  assertNearlyEqual(mtr[0], 20);
  assertNearlyEqual(mtr[1], -20);
  assert.ok(Number.isNaN(mtr[2]));
  assertNearlyEqual(mtr[3], 100);
}

{
  const dims = [1, 1, 1];
  const mt = new Float32Array([900]);
  const pd = new Float32Array([1000]);
  const t1 = new Float32Array([800]);
  const { mtsat, t1map } = computeMTsat(mt, pd, t1, dims, {
    trMt: 0.030,
    trPd: 0.030,
    trT1: 0.015,
    faMt: 9,
    faPd: 9,
    faT1: 15
  });
  assertNearlyEqual(t1map[0], 0.758693, 1e-5);
  assertNearlyEqual(mtsat[0], 0.57643, 1e-5);
}

{
  assert.deepEqual(
    identifyB0Dwi({ bvecs: [[0, 0, 0], [1, 0, 0], [0, 1, 0]] }),
    { indexB0: [0], indexDwi: [1, 2] }
  );
  assert.deepEqual(
    identifyB0Dwi({ bvecs: [[0, 1, 0], [0, 0, 1], [0, 0, 0]], bvals: [0, 1000, 80], bvalMin: 100 }),
    { indexB0: [0, 2], indexDwi: [1] }
  );

  const data = new Float32Array([
    1, 2,
    10, 20,
    100, 200
  ]);
  const split = splitB0Dwi(data, [2, 1, 1, 3], {
    bvecs: [[0, 0, 0], [1, 0, 0], [0, 1, 0]]
  });
  assert.deepEqual(Array.from(split.b0Mean), [1, 2]);
  assert.deepEqual(Array.from(split.dwiMean), [55, 110]);
}

{
  const bvals = [0, 1000, 1000, 1000, 1000, 1000, 1000];
  const bvecs = [
    [0, 0, 0],
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
    [Math.SQRT1_2, Math.SQRT1_2, 0],
    [Math.SQRT1_2, 0, Math.SQRT1_2],
    [0, Math.SQRT1_2, Math.SQRT1_2]
  ];
  const l1 = 0.0015;
  const l2 = 0.0005;
  const l3 = 0.0005;
  const s0 = 1000;
  const data = new Float32Array(bvals.length);
  data[0] = s0;
  for (let i = 1; i < bvals.length; i++) {
    const [gx, gy, gz] = bvecs[i];
    const adc = l1 * gx * gx + l2 * gy * gy + l3 * gz * gz;
    data[i] = s0 * Math.exp(-bvals[i] * adc);
  }
  const metrics = computeDtiMetrics(data, [1, 1, 1, bvals.length], bvals, bvecs);
  assertNearlyEqual(metrics.ad[0], l1, 1e-7);
  assertNearlyEqual(metrics.rd[0], (l2 + l3) / 2, 1e-7);
  assertNearlyEqual(metrics.md[0], (l1 + l2 + l3) / 3, 1e-7);
  assertNearlyEqual(metrics.fa[0], 0.603023, 1e-5);
}

{
  const dims = [5, 5, 3];
  const seg = new Uint8Array(dims[0] * dims[1] * dims[2]);
  seg[index3D(2, 2, 0, dims)] = 1;
  seg[index3D(1, 2, 2, dims)] = 1;
  seg[index3D(3, 2, 2, dims)] = 1;

  const centerline = centerlineFromSegmentation(seg, dims);
  assert.deepEqual(
    centerline.map(point => [point.x, point.y, point.z, !!point.interpolated]),
    [[2, 2, 0, false], [2, 2, 1, true], [2, 2, 2, false]]
  );

  const mask = createCylinderMask(dims, [1, 1, 2], centerline, 1);
  assert.equal(countNonzero(mask), 15);

  const bbox = boundingBoxFromMask(mask, dims);
  assert.deepEqual(bbox, { origin: [1, 1, 0], end: [4, 4, 3] });
}

{
  const dims = [4, 4, 2];
  const volume = makeVolume(dims);
  volume[index3D(1, 1, 0, dims)] = 11;
  volume[index3D(2, 2, 1, dims)] = 22;
  const mask = new Uint8Array(volume.length);
  mask[index3D(1, 1, 0, dims)] = 1;
  mask[index3D(2, 2, 1, dims)] = 1;

  const bbox = boundingBoxFromMask(mask, dims);
  const cropped = cropVolume(volume, dims, bbox);
  assert.deepEqual(cropped.dims, [2, 2, 2]);
  assert.deepEqual(cropped.origin, [1, 1, 0]);
  assert.equal(cropped.data[index3D(0, 0, 0, cropped.dims)], 11);
  assert.equal(cropped.data[index3D(1, 1, 1, cropped.dims)], 22);
}

{
  const dims = [4, 4, 2];
  const seg = new Uint8Array(dims[0] * dims[1] * dims[2]);
  seg[index3D(1, 1, 0, dims)] = 1;
  seg[index3D(2, 1, 0, dims)] = 1;
  seg[index3D(1, 2, 0, dims)] = 1;
  seg[index3D(2, 2, 0, dims)] = 1;

  const rows = sliceMorphometry(seg, dims, [0.5, 0.5, 2]);
  assert.equal(rows[0].voxelCount, 4);
  assert.equal(rows[0].areaMm2, 1);
  assert.equal(rows[0].centroidX, 1.5);
  assert.equal(rows[0].centroidY, 1.5);
  assert.equal(rows[1].voxelCount, 0);

  assert.equal(
    morphometryToCsv(rows),
    'slice,voxel_count,area_mm2,equivalent_diameter_mm,centroid_x,centroid_y\n'
      + '0,4,1,1.128379,1.5,1.5\n'
      + '1,0,0,0,,\n'
  );
}

{
  const dims = [5, 5, 4];
  const labeled = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < 2; z++) labeled[index3D(2, 2, z, dims)] = 2;
  for (let z = 2; z < 4; z++) labeled[index3D(2, 2, z, dims)] = 5;
  const labels = createLabelsFromVertBody(labeled, dims, [2, 5]);
  assert.equal(labels[index3D(2, 2, 0, dims)], 2);
  assert.equal(labels[index3D(2, 2, 2, dims)], 5);
  assert.equal(countNonzero(labels), 2);
}

{
  const dims = [1, 1, 5];
  const impulse = new Float32Array([0, 0, 1, 0, 0]);
  const smoothed = smoothAlongAxis(impulse, dims, [1, 1, 1], 1, 2);
  assert.ok(smoothed[2] < 1);
  assert.ok(smoothed[2] > smoothed[1]);
  assertNearlyEqual(smoothed[1], smoothed[3]);
}

{
  const dims = [4, 1, 1];
  const metric = new Float32Array([1, 2, -3, 4]);
  const atlas = new Float32Array([51, 51, 52, 52]);
  const rows = extractMetricByLabels(metric, atlas, dims, [51, 52], { method: 'map', discardNegVal: true });
  assert.deepEqual(rows, [
    { label: 51, method: 'map', voxelCount: 2, mean: 1.5 },
    { label: 52, method: 'map', voxelCount: 1, mean: 4 }
  ]);
  assert.equal(metricRowsToCsv(rows), 'label,method,voxel_count,mean\n51,map,2,1.5\n52,map,1,4\n');
}

{
  const html = createQcReportHtml([{ process: 'sct_dmri_moco', input: 'dmri.nii.gz', output: '<qc>' }]);
  assert.ok(html.includes('SCT QC Report'));
  assert.ok(html.includes('sct_dmri_moco'));
  assert.ok(html.includes('&lt;qc&gt;'));
}

{
  const exampleData = getSctExampleDataManifest();
  assert.equal(exampleData.id, 'sct_example_data');
  assert.ok(exampleData.sections.includes('dmri'));

  const plan = getBrowserModelInstallPlan({
    tasks: [{ id: 'spinalcord', displayName: 'Spinal cord', supportStatus: 'unvalidated', modelAssets: [{ id: 'asset', conversionStatus: 'failed' }] }]
  }, 'spinalcord');
  assert.deepEqual(plan.assets, [{ id: 'asset', filename: null, conversionStatus: 'failed', cacheKey: 'spinalcord:asset:unknown' }]);
}

{
  const dims = [3, 3, 4];
  const seg = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < 4; z++) seg[index3D(1, 1, z, dims)] = 1;
  const labeled = labelVertebraeFromSegmentation(seg, dims, { startLevel: 2, slicesPerLevel: 2 });
  assert.equal(labeled[index3D(1, 1, 0, dims)], 2);
  assert.equal(labeled[index3D(1, 1, 1, dims)], 2);
  assert.equal(labeled[index3D(1, 1, 2, dims)], 3);
  assert.equal(labeled[index3D(1, 1, 3, dims)], 3);
}

{
  const dims = [5, 5, 1];
  const src = new Float32Array(dims[0] * dims[1] * dims[2]);
  const dst = new Float32Array(src.length);
  src[index3D(1, 1, 0, dims)] = 1;
  dst[index3D(3, 2, 0, dims)] = 1;
  const transform = registerByCenterOfMass(src, dims, dst, dims);
  assert.deepEqual(transform.offset, [2, 1, 0]);
  const moved = applyTranslation(src, dims, transform.offset, { interpolation: 'nearest' });
  assert.equal(moved[index3D(3, 2, 0, dims)], 1);
  const warped = warpTemplate(src, dims, transform, { interpolation: 'nearest' });
  assert.equal(warped[index3D(3, 2, 0, dims)], 1);
}

{
  const dims = [3, 3, 3];
  const image = new Float32Array(dims[0] * dims[1] * dims[2]);
  image[index3D(2, 1, 0, dims)] = 5;
  image[index3D(1, 1, 2, dims)] = 9;
  assert.deepEqual(detectPmj(image, dims), { x: 1, y: 1, z: 2, value: 9 });
}

{
  const dims = [5, 3, 2];
  const volume = new Float32Array(dims[0] * dims[1] * dims[2]);
  const seg = new Uint8Array(volume.length);
  seg[index3D(1, 1, 0, dims)] = 1;
  seg[index3D(3, 1, 1, dims)] = 1;
  volume[index3D(1, 1, 0, dims)] = 1;
  volume[index3D(3, 1, 1, dims)] = 1;
  const flat = flattenSagittal(volume, dims, seg);
  assert.ok(flat[index3D(2, 1, 0, dims)] > 0.4);
  assert.ok(flat[index3D(2, 1, 1, dims)] > 0.4);
}

{
  const dims4 = [5, 5, 1, 2];
  const frameSize = 25;
  const data = new Float32Array(frameSize * 2);
  data[index3D(2, 2, 0, [5, 5, 1])] = 1;
  data[frameSize + index3D(3, 2, 0, [5, 5, 1])] = 1;
  const corrected = motionCorrectTimeSeries(data, dims4);
  assert.deepEqual(corrected.transforms[1].offset, [-1, 0, 0]);
  assert.ok(corrected.data[frameSize + index3D(2, 2, 0, [5, 5, 1])] > 0.4);
}

console.log('SCT browser processing tests passed');
