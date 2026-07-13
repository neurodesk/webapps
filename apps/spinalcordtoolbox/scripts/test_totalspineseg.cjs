#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const loadClassicScript = require('./load-classic-script.cjs');
const tss = loadClassicScript(path.join(__dirname, '../web/js/modules/totalspineseg.js'));

function makeVolume(dims) {
  return new Uint8Array(dims[0] * dims[1] * dims[2]);
}

function setVoxel(data, dims, x, y, z, value) {
  data[tss.index3D(x, y, z, dims)] = value;
}

(() => {
  {
    const dims = [5, 5, 8];
    const raw = makeVolume(dims);
    for (let z = 0; z < dims[2]; z++) {
      setVoxel(raw, dims, 2, 2, z, tss.STEP1_LABELS.CORD);
      setVoxel(raw, dims, 2, 3, z, tss.STEP1_LABELS.CANAL);
    }
    setVoxel(raw, dims, 1, 1, 7, tss.STEP1_LABELS.C2_C3);
    setVoxel(raw, dims, 1, 1, 5, tss.STEP1_LABELS.OTHER_DISC);
    setVoxel(raw, dims, 1, 1, 3, tss.STEP1_LABELS.OTHER_DISC);
    setVoxel(raw, dims, 1, 1, 1, tss.STEP1_LABELS.C7_T1);
    setVoxel(raw, dims, 2, 1, 1, tss.STEP1_LABELS.OTHER_DISC);

    const result = tss.labelStep1Output(raw, dims);
    assert.equal(result.labels[tss.index3D(1, 1, 7, dims)], 63, 'C2-C3 anchors the superior disc');
    assert.equal(result.labels[tss.index3D(1, 1, 5, dims)], 64, 'generic discs follow the C2-C3 anchor');
    assert.equal(result.labels[tss.index3D(1, 1, 3, dims)], 65, 'cervical default labels continue inferiorly');
    assert.equal(result.labels[tss.index3D(1, 1, 1, dims)], 71, 'C7-T1 landmark overrides inferior labels');
    assert.equal(result.labels[tss.index3D(2, 1, 1, dims)], 71, 'connected landmark components share one definite label');
    assert.equal(result.labels[tss.index3D(2, 2, 0, dims)], 1, 'cord is mapped to TotalSpineSeg label 1');
    assert.equal(result.labels[tss.index3D(2, 3, 0, dims)], 2, 'canal is mapped to TotalSpineSeg label 2');
  }

  {
    const dims = [5, 5, 4];
    const labeled = makeVolume(dims);
    for (let z = 0; z < dims[2]; z++) {
      setVoxel(labeled, dims, 2, 2, z, tss.TSS_LABELS.CORD);
      setVoxel(labeled, dims, 2, 3, z, tss.TSS_LABELS.CANAL);
    }
    setVoxel(labeled, dims, 0, 0, 3, 63);
    setVoxel(labeled, dims, 1, 2, 3, 63);
    setVoxel(labeled, dims, 4, 4, 2, 64);
    setVoxel(labeled, dims, 2, 3, 2, 64);

    const points = tss.extractDiscLabelPoints(labeled, dims, { discPointRadius: 0 });
    assert.equal(points[tss.index3D(1, 2, 3, dims)], 3, 'C2-C3 point is chosen closest to the centerline');
    assert.equal(points[tss.index3D(2, 3, 2, dims)], 4, 'C3-C4 point uses the next SCT disc point label');
    assert.equal(points.filter(Boolean).length, 2, 'one point is emitted per available disc label');

    const visibleMarkers = tss.extractDiscLabelPoints(labeled, dims, { discPointRadius: 1 });
    assert.equal(visibleMarkers[tss.index3D(1, 2, 3, dims)], 3, 'visible marker keeps the C2-C3 center voxel label');
    assert.equal(visibleMarkers[tss.index3D(2, 3, 2, dims)], 4, 'visible marker keeps the C3-C4 center voxel label');
    assert.ok(visibleMarkers.filter(Boolean).length > points.filter(Boolean).length, 'disc label markers are inflated beyond one-voxel points for viewer visibility');
  }

  {
    const dims = [3, 3, 4];
    const raw = makeVolume(dims);
    setVoxel(raw, dims, 1, 1, 3, tss.STEP1_LABELS.OTHER_DISC);
    setVoxel(raw, dims, 1, 1, 1, tss.STEP1_LABELS.C2_C3);

    const result = tss.labelStep1Output(raw, dims);
    assert.ok(result.warnings.some(warning => warning.includes('C2-C3')), 'non-superior C2-C3 landmarks are rejected');
    assert.equal(result.labels[tss.index3D(1, 1, 1, dims)], 0, 'rejected landmarks are not assigned definite disc labels');
  }

  {
    const dims = [20, 8, 4];
    const raw = makeVolume(dims);
    setVoxel(raw, dims, 2, 2, 2, tss.STEP1_LABELS.CORD);
    setVoxel(raw, dims, 5, 2, 2, tss.STEP1_LABELS.CANAL);
    setVoxel(raw, dims, 17, 6, 2, tss.STEP1_LABELS.SACRUM);

    const cleanup = tss.keepLargestDilatedForegroundComponent(raw, dims, { dilate: 3 });
    assert.equal(cleanup.componentCount, 2, 'dilated cleanup tracks detached foreground components');
    assert.equal(cleanup.removedVoxels, 1, 'detached foreground outside the largest component is removed');
    assert.equal(cleanup.labels[tss.index3D(2, 2, 2, dims)], tss.STEP1_LABELS.CORD, 'largest component keeps original labels');
    assert.equal(cleanup.labels[tss.index3D(5, 2, 2, dims)], tss.STEP1_LABELS.CANAL, 'nearby sparse labels are connected by dilation');
    assert.equal(cleanup.labels[tss.index3D(17, 6, 2, dims)], 0, 'far detached labels are removed');
  }

  {
    const dims = [24, 8, 6];
    const raw = makeVolume(dims);
    for (let z = 1; z <= 4; z++) {
      setVoxel(raw, dims, 3, 3, z, tss.STEP1_LABELS.CORD);
      setVoxel(raw, dims, 4, 3, z, tss.STEP1_LABELS.CANAL);
    }
    setVoxel(raw, dims, 3, 2, 4, tss.STEP1_LABELS.C2_C3);
    setVoxel(raw, dims, 3, 2, 2, tss.STEP1_LABELS.C7_T1);
    setVoxel(raw, dims, 22, 7, 5, tss.STEP1_LABELS.C1);

    const result = tss.postprocessStep1(raw, dims, { cleanupDilate: 2 });
    assert.equal(result.cleanup.removedVoxels, 1, 'postprocess removes detached Step 1 false positives before relabeling');
    assert.equal(result.step1Labels[tss.index3D(22, 7, 5, dims)], 0, 'detached C1 candidate is absent from the final step-1 labelmap');
    assert.equal(result.step1Labels[tss.index3D(3, 2, 4, dims)], 63, 'kept disc landmarks are still relabeled');
    assert.ok(result.warnings.some(warning => warning.includes('Removed 1 voxels')), 'cleanup is reported in postprocess warnings');
  }

  {
    const dims = [7, 7, 2];
    const labeled = makeVolume(dims);
    setVoxel(labeled, dims, 2, 3, 0, tss.TSS_LABELS.CANAL);
    setVoxel(labeled, dims, 4, 3, 0, tss.TSS_LABELS.CANAL);
    setVoxel(labeled, dims, 3, 2, 0, tss.TSS_LABELS.CANAL);
    setVoxel(labeled, dims, 3, 4, 0, tss.TSS_LABELS.CORD);
    setVoxel(labeled, dims, 6, 6, 1, tss.TSS_LABELS.CORD);

    const filled = tss.fillCanal(labeled, dims);
    assert.equal(filled[tss.index3D(3, 3, 0, dims)], tss.TSS_LABELS.CANAL, 'canal fill labels background between canal bounds');
    assert.equal(filled[tss.index3D(3, 4, 0, dims)], tss.TSS_LABELS.CORD, 'canal fill never overwrites spinal cord');
    assert.equal(filled[tss.index3D(6, 6, 1, dims)], 0, 'detached cord outside the largest canal component is removed');
  }

  console.log('TotalSpineSeg step-1 post-processing tests passed');
})();
