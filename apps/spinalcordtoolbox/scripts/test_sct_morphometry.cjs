#!/usr/bin/env node
'use strict';

/*
 * Offline unit tests of sct-centerline.js and sct-morphometry.js: the FITPACK
 * port against SciPy's own numbers on a fixed vector, synthetic cords with
 * known geometry, aggregation rules and the CSV writer. Agreement with real
 * SCT output on real masks is test_sct_metrics_parity.cjs.
 */

const assert = require('node:assert/strict');
const path = require('node:path');
const { centerline, morphometry } = require('./sct-metrics-lib.cjs');

function near(actual, expected, tolerance, label) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} ~= ${expected} (±${tolerance})`);
}

function cylinder(dims, centreAt, radius) {
  const [nx, ny, nz] = dims;
  const seg = new Uint8Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    const [cx, cy] = centreAt(z);
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 <= radius * radius) seg[x + y * nx + z * nx * ny] = 1;
      }
    }
  }
  return seg;
}

// ---- Python-compatible helpers ----
{
  assert.equal(centerline.roundHalfEven(0.5), 0);
  assert.equal(centerline.roundHalfEven(1.5), 2);
  assert.equal(centerline.roundHalfEven(2.5), 2);
  assert.equal(centerline.roundHalfEven(-0.5), 0);
  assert.equal(centerline.roundHalfEven(7.49), 7);

  // SCT rounds float32 voxel sizes to the digits a float32 carries.
  assert.equal(centerline.sctVoxelSize(Math.fround(0.8)), 0.8);
  assert.equal(centerline.sctVoxelSize(0.8), 0.8);
  assert.equal(centerline.sctVoxelSize(Math.fround(0.8958333)), 0.8958333);
  assert.equal(centerline.sctVoxelSize(5), 5);
  assert.equal(centerline.sctVoxelSize(Math.fround(0.3)), 0.3);

  const repr = centerline.pythonFloatRepr;
  assert.equal(repr(5), '5.0');
  assert.equal(repr(0), '0.0');
  assert.equal(repr(0.1), '0.1');
  assert.equal(repr(60.99903900340001), '60.99903900340001');
  assert.equal(repr(-0.9398935752263924), '-0.9398935752263924');
  assert.equal(repr(0.0001), '0.0001');
  assert.equal(repr(0.00001), '1e-05');
  assert.equal(repr(1.5e-7), '1.5e-07');
  assert.equal(repr(1e16), '1e+16');
  assert.equal(repr(123456789012345.6), '123456789012345.6');
  assert.equal(repr(1e15), '1000000000000000.0');

  assert.deepEqual(morphometry.parseNumList('2:5'), [2, 3, 4, 5]);
  assert.deepEqual(morphometry.parseNumList('1;3; 7:8'), [1, 3, 7, 8]);
  assert.deepEqual(morphometry.parseNumList(''), []);
  assert.throws(() => morphometry.parseNumList('C2'), /not a number or a range/);
  assert.equal(morphometry.numListToString([1, 2, 3, 5]), '1:3;5');
  assert.equal(morphometry.numListToString([9, 10, 11]), '9:11');
  assert.equal(morphometry.numListToString([3]), '3');
  assert.equal(morphometry.numListToString([]), '');

  // The x flip that turns RAS into RPI and back.
  const flipped = centerline.rasToRpi(Uint8Array.from([1, 2, 3, 4, 5, 6]), [3, 2, 1]);
  assert.deepEqual(Array.from(flipped), [3, 2, 1, 6, 5, 4]);
  assert.deepEqual(centerline.nativeFlipsFromRas([false, false, false]), [true, false, false]);
}

// ---- FITPACK port: identical knots, coefficients, values and derivatives to SciPy ----
{
  const reference = require(path.join(__dirname, '../test/fixtures/sct-metrics/scipy_splrep.json'));
  const x = Array.from({ length: 20 }, (_, i) => i);
  const y = x.map(i => Math.sin(i / 3) + 0.1 * ((i * 7) % 5));
  const xr = Array.from({ length: 25 }, (_, i) => i - 2);
  for (const [name, expected] of Object.entries(reference)) {
    const tck = centerline.splrep(x, y, expected.s, expected.k);
    assert.equal(tck.ier, expected.ier, `${name}: FITPACK return code`);
    assert.equal(tck.t.length, expected.t.length, `${name}: knot count`);
    tck.t.forEach((value, i) => near(value, expected.t[i], 1e-12, `${name}: knot ${i}`));
    tck.c.slice(0, tck.t.length - expected.k - 1).forEach((value, i) => near(value, expected.c[i], 1e-10, `${name}: coefficient ${i}`));
    near(tck.fp, expected.fp, 1e-10, `${name}: residual`);
    // Includes two points before and after the data: extrapolation as splev does it.
    centerline.splev(xr, tck, 0).forEach((value, i) => near(value, expected.fit[i], 1e-10, `${name}: value at ${xr[i]}`));
    centerline.splev(xr, tck, 1).forEach((value, i) => near(value, expected.deriv[i], 1e-10, `${name}: derivative at ${xr[i]}`));
  }
  assert.throws(() => centerline.splrep([0, 1, 2], [0, 1, 2], 0, 3), /cannot define/);
}

// ---- A straight cord: no angles, known area and length ----
{
  const dims = [41, 41, 12];
  const spacing = [1, 1, 2];
  const seg = cylinder(dims, () => [20, 20], 6);
  let voxelsPerSlice = 0;
  for (let i = 0; i < dims[0] * dims[1]; i++) voxelsPerSlice += seg[i];

  const { metrics, zMin, zMax } = morphometry.computeShape(seg, dims, spacing);
  assert.equal(zMin, 0);
  assert.equal(zMax, 11);
  for (let z = 0; z < dims[2]; z++) {
    near(metrics.angle_AP[z], 0, 1e-9, 'straight cord angle_AP');
    near(metrics.angle_RL[z], 0, 1e-9, 'straight cord angle_RL');
    near(metrics.length[z], 2, 1e-9, 'slice length is the slice thickness');
    // Linear upsampling to 0.1 mm keeps the summed mask.
    near(metrics.area[z], voxelsPerSlice, 1e-6, 'area is the voxel count times pixel area');
    near(metrics.eccentricity[z], 0, 1e-6, 'a disc has no eccentricity');
    near(metrics.diameter_AP[z], 12, 0.5, 'AP diameter of a 113-voxel disc');
    near(metrics.diameter_RL[z], metrics.diameter_AP_ellipse[z], 1e-6, 'both ellipse axes of a disc');
    // The voxel staircase of a small disc leaves notches the convex hull fills.
    assert.ok(metrics.solidity[z] > 0.9 && metrics.solidity[z] <= 1, 'a disc is nearly convex');
    near(metrics.length_anterior[z] + metrics.length_posterior[z], metrics.diameter_AP[z], 1e-12, 'AP halves sum to the diameter');
  }

  // Without angle correction a one-slice mask is measurable; with it SCT needs a centerline.
  const single = new Uint8Array(seg.length);
  single.set(seg.subarray(0, dims[0] * dims[1]), 0);
  const flat = morphometry.computeShape(single, dims, spacing, { angleCorrection: false });
  near(flat.metrics.area[0], voxelsPerSlice, 1e-6, 'single slice area');
  assert.ok(Number.isNaN(flat.metrics.area[1]), 'slices without mask are NaN');
  assert.throws(() => morphometry.computeShape(single, dims, spacing), /at least two slices/);
  assert.throws(() => morphometry.computeShape(new Uint8Array(seg.length), dims, spacing), /empty/);
}

// ---- A cord tilted in the sagittal plane: angle_RL, corrected area, corrected length ----
{
  const dims = [41, 81, 30];
  const spacing = [1, 1, 1];
  const slope = 0.5; // voxels of y per slice
  const seg = cylinder(dims, z => [20, 15 + slope * z], 6);
  const { metrics } = morphometry.computeShape(seg, dims, spacing);
  const expectedAngle = Math.atan(slope) * 180 / Math.PI;
  const straight = morphometry.computeShape(seg, dims, spacing, { angleCorrection: false }).metrics;
  for (let z = 8; z < 22; z++) {
    near(metrics.angle_RL[z], expectedAngle, 0.5, 'angle about the RL axis');
    near(metrics.angle_AP[z], 0, 0.05, 'no angle about the AP axis');
    near(metrics.length[z], 1 / Math.cos(Math.atan(slope)), 0.01, 'length along the cord');
    near(metrics.area[z] / straight.area[z], Math.cos(Math.atan(slope)), 0.01, 'area shrinks by the cosine of the angle');
  }
}

// ---- A shape regionprops would describe: orientation, RL and AP from the ellipse ----
{
  // An axis-aligned ellipse wider in x (RL) than in y (AP).
  const dims = [61, 41, 4];
  const seg = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        if (((x - 30) / 12) ** 2 + ((y - 20) / 5) ** 2 <= 1) seg[x + y * dims[0] + z * dims[0] * dims[1]] = 1;
      }
    }
  }
  const { metrics } = morphometry.computeShape(seg, dims, [0.5, 0.5, 1], { angleCorrection: false });
  near(metrics.diameter_RL[1], 12, 0.3, 'RL diameter in mm');
  near(metrics.diameter_AP_ellipse[1], 5, 0.3, 'AP ellipse diameter in mm');
  // Mean AP chord over the central 3 mm, so a little under the 5 mm axis.
  near(metrics.diameter_AP[1], 4.8, 0.3, 'AP diameter in mm');
  near(metrics.eccentricity[1], Math.sqrt(1 - (5 / 12) ** 2), 0.02, 'eccentricity');
  near(Math.abs(metrics.orientation[1]), 0, 0.5, 'orientation of an axis-aligned cord');
  let voxels = 0;
  for (let i = 0; i < dims[0] * dims[1]; i++) voxels += seg[i];
  near(metrics.area[1], voxels * 0.25, 1e-6, 'area in mm2 is the voxel count times 0.5 x 0.5 mm');
}

// ---- Aggregation: SCT's slice and level grouping ----
{
  const nz = 8;
  const metrics = Object.fromEntries(morphometry.METRIC_KEYS.map(key => [key, new Float64Array(nz).fill(NaN)]));
  for (let z = 2; z <= 6; z++) {
    metrics.area[z] = 10 * z;
    metrics.length[z] = 1;
  }
  const levelBySlice = Int32Array.from([0, 0, 4, 4, 3, 3, 3, 0]);

  const all = morphometry.aggregateMetrics(metrics);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].slices, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(all[0].values['MEAN(area)'], 40, 'empty slices drop out of the mean');
  near(all[0].values['STD(area)'], Math.sqrt(200), 1e-12, 'population standard deviation');
  assert.equal(all[0].values['SUM(length)'], 5);
  assert.equal(all[0].values['MEAN(solidity)'], null, 'a metric with no finite value is empty');
  assert.equal(all[0].vertLevel, null);

  const perSlice = morphometry.aggregateMetrics(metrics, { perslice: true, levelBySlice });
  assert.equal(perSlice.length, 8);
  assert.equal(perSlice[0].values['MEAN(area)'], null);
  assert.equal(perSlice[0].values['SUM(length)'], null);
  assert.equal(perSlice[0].vertLevel, null, 'a slice outside every level has none');
  assert.deepEqual(perSlice[3].vertLevel, [4]);
  assert.equal(perSlice[3].values['STD(area)'], 0);

  const perLevel = morphometry.aggregateMetrics(metrics, { levels: [3, 4, 9], perlevel: true, levelBySlice });
  assert.equal(perLevel.length, 2, 'a requested level that is absent gives no row');
  assert.deepEqual(perLevel.map(row => row.vertLevel), [[4], [3]], 'rows are ordered inferior to superior');
  assert.deepEqual(perLevel[0].slices, [2, 3]);
  assert.equal(perLevel[1].values['MEAN(area)'], 50);

  const across = morphometry.aggregateMetrics(metrics, { levels: [3, 4], levelBySlice });
  assert.deepEqual(across[0].slices, [2, 3, 4, 5, 6]);
  assert.deepEqual(across[0].vertLevel, [3, 4]);

  const window = morphometry.aggregateMetrics(metrics, { levels: [3], slices: [4, 5], perlevel: true, levelBySlice });
  assert.deepEqual(window[0].slices, [4, 5], '-z and -vert intersect');

  assert.throws(() => morphometry.aggregateMetrics(metrics, { slices: [8] }), /outside the image/);
  assert.throws(() => morphometry.aggregateMetrics(metrics, { levels: [3] }), /need disc labels/);
}

// ---- Vertebral levels from disc labels ----
{
  const dims = [21, 21, 30];
  const spacing = [1, 1, 1];
  const seg = cylinder(dims, () => [10, 10], 3);
  // Discs sit anterior to the cord, as intervertebral discs do.
  const discs = [{ x: 10, y: 16, z: 20, value: 3 }, { x: 10, y: 16, z: 9, value: 4 }];
  const { levelBySlice, projected } = morphometry.levelsFromDiscs(seg, dims, spacing, discs);
  assert.equal(projected.length, 2);
  assert.deepEqual(projected.map(entry => entry.voxel), [[10, 10, 9], [10, 10, 20]], 'discs project onto the centerline');
  for (let z = 0; z <= 9; z++) assert.equal(levelBySlice[z], 4, `slice ${z}: at or below the 4 disc`);
  for (let z = 10; z <= 20; z++) assert.equal(levelBySlice[z], 3, `slice ${z}: between the discs`);
  for (let z = 21; z < 30; z++) assert.equal(levelBySlice[z], 2, `slice ${z}: above the top disc is one level up`);

  // A marker sphere reduces to its centre voxel.
  const labels = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let dz = -2; dz <= 2; dz++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (dx * dx + dy * dy + dz * dz <= 4) labels[(10 + dx) + (16 + dy) * dims[0] + (20 + dz) * dims[0] * dims[1]] = 3;
      }
    }
  }
  assert.deepEqual(morphometry.discPointsFromLabels(labels, dims), [{ value: 3, x: 10, y: 16, z: 20 }]);
}

// ---- The whole command and its CSV ----
{
  const dims = [21, 21, 30];
  const spacing = [1, 1, 1];
  const seg = cylinder(dims, () => [10, 10], 3);
  const discs = [{ x: 10, y: 16, z: 20, value: 3 }, { x: 10, y: 16, z: 9, value: 4 }];

  const perLevel = morphometry.processSegmentation({
    seg, dims, spacing, discs, aggregate: 'level', filename: 'cord.nii.gz', version: 'test', timestamp: '2026-01-02 03:04:05'
  });
  assert.equal(perLevel.rows.length, 3);
  assert.deepEqual(perLevel.rows.map(row => row.vert_level), ['4', '3', '2']);
  assert.equal(perLevel.summary.command, 'sct_process_segmentation -i cord.nii.gz -discfile discs.nii.gz -vert 2:4 -perlevel 1');
  near(perLevel.summary.length_mm, 30, 1e-9, 'cord length');

  const lines = perLevel.csv.split('\r\n');
  assert.equal(
    lines[0],
    'Timestamp,SCT Version,Filename,Slice (I->S),VertLevel,DistancePMJ,MEAN(area),STD(area),MEAN(angle_AP),STD(angle_AP),'
    + 'MEAN(angle_RL),STD(angle_RL),MEAN(diameter_AP),STD(diameter_AP),MEAN(diameter_AP_ellipse),STD(diameter_AP_ellipse),'
    + 'MEAN(diameter_RL),STD(diameter_RL),MEAN(length_anterior),STD(length_anterior),MEAN(length_posterior),STD(length_posterior),'
    + 'MEAN(eccentricity),STD(eccentricity),MEAN(orientation),STD(orientation),MEAN(solidity),STD(solidity),SUM(length)',
    "SCT's column layout"
  );
  assert.ok(lines[1].startsWith('"2026-01-02 03:04:05","test","cord.nii.gz","0:9","4","",'), 'text is quoted, numbers are not');
  assert.equal(lines[4], '', 'the file ends with a line break');

  const sliced = morphometry.processSegmentation({ seg, dims, spacing, aggregate: 'slice', slices: '3:5', angleCorrection: false });
  assert.deepEqual(sliced.rows.map(row => row.slices), ['3', '4', '5']);
  assert.equal(sliced.rows[0].vert_level, '', 'no levels without disc labels');
  assert.equal(sliced.summary.command, 'sct_process_segmentation -i mask.nii.gz -z 3:5 -perslice 1 -angle-corr 0');

  assert.throws(() => morphometry.processSegmentation({ seg, dims, spacing, aggregate: 'level' }), /needs disc labels/);
  assert.throws(() => morphometry.processSegmentation({ seg, dims, spacing, aggregate: 'slice', levels: '2:3' }), /per-level and across-levels/);
  assert.throws(() => morphometry.processSegmentation({ seg, dims, spacing, aggregate: 'cubic' }), /Unknown aggregation/);

  let calls = 0;
  morphometry.processSegmentation({ seg, dims, spacing, onProgress: (done, total) => { calls += 1; assert.equal(total, 30); } });
  assert.equal(calls, 30, 'progress is reported once per measured slice');
}

console.log('SCT morphometry tests passed');
