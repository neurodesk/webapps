#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const loadClassicScript = require('./load-classic-script.cjs');
const lesionAnalysis = loadClassicScript(path.join(__dirname, '../web/js/modules/lesion-analysis.js'));

function idx(x, y, z, dims) {
  return x + y * dims[0] + z * dims[0] * dims[1];
}

function makeCord(dims) {
  const cord = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 1; y <= 4; y++) {
      for (let x = 1; x <= 3; x++) {
        cord[idx(x, y, z, dims)] = 1;
      }
    }
  }
  return cord;
}

function near(actual, expected, tolerance = 1e-6) {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${actual} ~= ${expected}`);
}

{
  const dims = [5, 6, 4];
  const spacing = [1, 1, 2];
  const cord = makeCord(dims);
  const lesion = new Uint8Array(dims[0] * dims[1] * dims[2]);
  for (const z of [1, 2]) {
    lesion[idx(2, 2, z, dims)] = 1;
    lesion[idx(2, 3, z, dims)] = 1;
  }
  lesion[idx(0, 0, 1, dims)] = 1;

  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing });
  assert.equal(result.rows.length, 1);
  assert.equal(result.summary.lesion_count, 1);
  assert.equal(result.rows[0].voxel_count, 4, 'outside-cord lesion voxel is excluded');
  near(result.rows[0].volume_mm3, 8);
  near(result.rows[0].length_mm, 4);
  near(result.rows[0].max_width_mm, 2);
  near(result.rows[0].max_equivalent_diameter_mm, 1.595769);
  near(result.rows[0].max_axial_damage_ratio, 0.166667);
  near(result.rows[0].dorsal_bridge_width_mm, 1);
  near(result.rows[0].ventral_bridge_width_mm, 1);
  near(result.rows[0].total_bridge_width_mm, 2);
  near(result.rows[0].total_bridge_ratio, 0.5);
  near(result.summary.total_volume_mm3, 8);
  near(result.summary.total_length_mm, 4);
  assert.match(result.csv.split('\n')[0], /sagittal_x_2_dorsal_bridge_width_mm/, 'CSV includes per-sagittal-slice bridge columns');
}

{
  const dims = [5, 6, 5];
  const spacing = [1, 1, 1];
  const cord = makeCord(dims);
  const lesion = new Uint8Array(dims[0] * dims[1] * dims[2]);
  lesion[idx(2, 2, 0, dims)] = 1;
  lesion[idx(2, 3, 4, dims)] = 1;
  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing });
  assert.equal(result.rows.length, 2);
  assert.equal(result.summary.lesion_count, 2);
  assert.equal(result.summary.total_volume_mm3, 2);
  assert.equal(result.summary.total_length_mm, 2);
  assert.equal(result.summary.max_width_mm, 1);
}

{
  const dims = [4, 4, 2];
  const cord = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const lesion = new Uint8Array(dims[0] * dims[1] * dims[2]);
  const result = lesionAnalysis.analyzeLesions({ lesion, spinalCord: cord, dims, spacing: [1, 1, 1] });
  assert.equal(result.rows.length, 0);
  assert.equal(result.summary.lesion_count, 0);
  assert.match(result.csv, /^row_type,lesion_id,voxel_count/, 'empty metrics still emits stable CSV header');
}

console.log('Lesion analysis tests passed');
