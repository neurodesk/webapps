#!/usr/bin/env node
'use strict';

/*
 * Offline unit tests of lesion-analysis.js on synthetic cords whose answers
 * can be worked out by hand. Agreement with real `sct_analyze_lesion` output
 * is test_sct_metrics_parity.cjs.
 */

const assert = require('node:assert/strict');
const { lesionAnalysis } = require('./sct-metrics-lib.cjs');

function idx(x, y, z, dims) {
  return x + y * dims[0] + z * dims[0] * dims[1];
}

// A straight cord: x 3..7 (5 wide, centre 5), y 2..8 (7 deep), every slice.
function makeCord(dims) {
  const cord = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 2; y <= 8; y++) {
      for (let x = 3; x <= 7; x++) cord[idx(x, y, z, dims)] = 1;
    }
  }
  return cord;
}

function near(actual, expected, tolerance = 1e-9, label = '') {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label} ${actual} ~= ${expected}`);
}

const dims = [11, 11, 12];
const spacing = [1, 0.5, 2];
const voxels = dims[0] * dims[1] * dims[2];

// ---- One midsagittal lesion in a straight cord ----
{
  const cord = makeCord(dims);
  const lesion = new Uint8Array(voxels);
  // x 4..6, y 4..6, z 5..7: 27 voxels, centred on the cord's midsagittal slice x = 5.
  for (let z = 5; z <= 7; z++) {
    for (let y = 4; y <= 6; y++) {
      for (let x = 4; x <= 6; x++) lesion[idx(x, y, z, dims)] = 1;
    }
  }
  lesion[idx(0, 0, 6, dims)] = 1; // outside the cord, in a lesion of its own

  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing });
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.lesion_count, 1);
  assert.equal(result.warnings.length, 1, 'the lesion outside the cord is reported, not measured');
  assert.match(result.warnings[0], /outside the cord mask/);

  const row = result.rows[0];
  assert.equal(row.label, 2, 'labels keep the numbering of the whole mask; lesion 1 is the one outside the cord');
  near(row['volume [mm3]'], 27 * 1 * 0.5 * 2, 1e-12, 'volume');
  near(row['length [mm]'], 3 * 2, 1e-9, 'length: three slices of 2 mm, no cord angle');
  near(row['width [mm]'], 3 * 0.5, 1e-9, 'AP width');
  near(row['max_equivalent_diameter [mm]'], 2 * Math.sqrt((9 * 0.5) / Math.PI), 1e-9, 'equivalent diameter');
  near(row['max_axial_damage_ratio []'], 9 / 35, 1e-12, 'lesion area over cord area');
  near(row.interpolated_midsagittal_slice, 5, 1e-12, 'midsagittal slice is the cord centre');
  near(row['length_interpolated_midsagittal_slice [mm]'], 6, 1e-9, 'midsagittal length');
  near(row['width_interpolated_midsagittal_slice [mm]'], 1.5, 1e-9, 'midsagittal width');
  // Dorsal is posterior (low y): cord starts at y 2, lesion at y 4.
  near(row['interpolated_dorsal_bridge_width [mm]'], 2 * 0.5, 1e-9, 'dorsal bridge');
  near(row['interpolated_ventral_bridge_width [mm]'], 2 * 0.5, 1e-9, 'ventral bridge');
  near(row['interpolated_total_bridge_width [mm]'], 2, 1e-9, 'total bridge');
  near(row['dorsal_bridge_ratio [%]'], 50, 1e-9, 'bridge ratio is a percentage of the total bridge');
  near(row['ventral_bridge_ratio [%]'], 50, 1e-9);
  for (const x of [4, 5, 6]) {
    near(row[`slice_${x}_dorsal_bridge_width [mm]`], 1, 1e-9, `sagittal slice ${x} dorsal`);
    near(row[`slice_${x}_total_bridge_width [mm]`], 2, 1e-9, `sagittal slice ${x} total`);
  }

  assert.deepEqual(result.columns.slice(0, 14), [
    'label',
    'volume [mm3]',
    'length [mm]',
    'width [mm]',
    'max_equivalent_diameter [mm]',
    'max_axial_damage_ratio []',
    'interpolated_midsagittal_slice',
    'length_interpolated_midsagittal_slice [mm]',
    'width_interpolated_midsagittal_slice [mm]',
    'interpolated_dorsal_bridge_width [mm]',
    'interpolated_ventral_bridge_width [mm]',
    'interpolated_total_bridge_width [mm]',
    'dorsal_bridge_ratio [%]',
    'ventral_bridge_ratio [%]'
  ], "columns follow SCT's measures sheet");
  const lines = result.csv.trimEnd().split('\n');
  assert.equal(lines[0], result.columns.join(','));
  assert.equal(lines.length, 2);
  assert.ok(lines[1].startsWith('2,27.0,'), 'the label is an integer, measures are floats');

  near(result.summary.total_volume_mm3, 27, 1e-12);
  near(result.summary.total_length_mm, 6, 1e-9);
  near(result.summary.max_width_mm, 1.5, 1e-9);

  // SCT names sagittal slices in the orientation the image is stored in.
  const stored = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing, nativeFlips: [true, false, false] });
  assert.ok(stored.columns.includes('slice_6_dorsal_bridge_width [mm]'));
  near(stored.rows[0].interpolated_midsagittal_slice, 10 - 5, 1e-12, 'slice number in the stored orientation');
  assert.equal(stored.columns.indexOf('slice_6_dorsal_bridge_width [mm]') < stored.columns.indexOf('slice_4_dorsal_bridge_width [mm]'), true);
}

// ---- Connectivity: faces and edges join, corners do not (skimage connectivity=2) ----
{
  const cord = makeCord(dims);
  const lesion = new Uint8Array(voxels);
  lesion[idx(4, 4, 2, dims)] = 1;
  lesion[idx(5, 5, 2, dims)] = 1; // shares an edge with the first: same lesion
  lesion[idx(6, 6, 3, dims)] = 1; // shares only a corner with the second: a new lesion
  const { labels, count } = lesionAnalysis.labelLesions(lesion, dims);
  assert.equal(count, 2);
  assert.equal(labels[idx(4, 4, 2, dims)], labels[idx(5, 5, 2, dims)]);
  assert.notEqual(labels[idx(5, 5, 2, dims)], labels[idx(6, 6, 3, dims)]);

  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing });
  assert.equal(result.summary.lesion_count, 2);
  near(result.summary.total_volume_mm3, 3, 1e-12);
  // Labels are numbered in NumPy's scan order of the RPI array: x first.
  near(result.rows[0]['volume [mm3]'], 2, 1e-12);
  near(result.rows[1]['volume [mm3]'], 1, 1e-12);
}

// ---- A parasagittal lesion: bridges fall back to the cord AP diameter ----
{
  const cord = makeCord(dims);
  const lesion = new Uint8Array(voxels);
  for (let z = 4; z <= 5; z++) lesion[idx(7, 5, z, dims)] = 1; // lateral edge, not on x = 5
  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing });
  const row = result.rows[0];
  near(row['length_interpolated_midsagittal_slice [mm]'], 0, 1e-12);
  near(row['width_interpolated_midsagittal_slice [mm]'], 0, 1e-12);
  near(row['interpolated_total_bridge_width [mm]'], 7 * 0.5, 1e-9, 'cord AP diameter stands in for the bridge');
  near(row['interpolated_dorsal_bridge_width [mm]'], 1.75, 1e-9);
  near(row['dorsal_bridge_ratio [%]'], 50, 1e-9);
  near(row['slice_7_dorsal_bridge_width [mm]'], 3 * 0.5, 1e-9, 'its own sagittal slice still has real bridges');
  assert.ok(result.warnings.some(text => /not on the midsagittal slice/.test(text)));
}

// ---- Image statistics inside the lesion (-i): zeros are left out ----
{
  const cord = makeCord(dims);
  const lesion = new Uint8Array(voxels);
  const image = new Float64Array(voxels);
  [[5, 5, 6, 10], [5, 6, 6, 20], [5, 4, 6, 0]].forEach(([x, y, z, value]) => {
    lesion[idx(x, y, z, dims)] = 1;
    image[idx(x, y, z, dims)] = value;
  });
  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing, image, imageName: 't2' });
  assert.deepEqual(result.columns.slice(6, 8), ['mean_t2', 'std_t2']);
  near(result.rows[0].mean_t2, 15, 1e-12);
  near(result.rows[0].std_t2, 5, 1e-12);
}

// ---- No lesion: an empty table with the stable header ----
{
  const cord = makeCord(dims);
  const result = lesionAnalysis.analyzeLesions({ lesion: new Uint8Array(voxels), spinalCord: cord, dims, spacing });
  assert.equal(result.rows.length, 0);
  assert.equal(result.summary.lesion_count, 0);
  assert.match(result.csv, /^label,volume \[mm3\],length \[mm\],width \[mm\]/);
  assert.match(result.warnings[0], /No lesion inside the cord mask/);

  assert.throws(() => lesionAnalysis.analyzeLesions({ lesion: new Uint8Array(3), spinalCord: cord, dims, spacing }), /length mismatch/);
}

console.log('Lesion analysis tests passed');
