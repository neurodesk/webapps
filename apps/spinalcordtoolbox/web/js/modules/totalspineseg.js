(function initTotalSpineSegModule(root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.TotalSpineSeg = factory();
  }
})(typeof self !== 'undefined' ? self : globalThis, function createTotalSpineSegModule() {
  'use strict';

  const STEP1_LABELS = Object.freeze({
    OTHER_DISC: 1,
    C2_C3: 2,
    C7_T1: 3,
    T12_L1: 4,
    L5_S: 5,
    SACRUM: 6,
    C1: 7,
    CANAL: 8,
    CORD: 9
  });

  const TSS_LABELS = Object.freeze({
    CORD: 1,
    CANAL: 2,
    C1: 11,
    SACRUM: 50
  });

  const DISC_LANDMARKS = Object.freeze([
    { rawLabel: STEP1_LABELS.C2_C3, outputLabel: 63, name: 'C2-C3' },
    { rawLabel: STEP1_LABELS.C7_T1, outputLabel: 71, name: 'C7-T1' },
    { rawLabel: STEP1_LABELS.T12_L1, outputLabel: 91, name: 'T12-L1' },
    { rawLabel: STEP1_LABELS.L5_S, outputLabel: 100, name: 'L5-S' }
  ]);

  const SELECTED_DISC_LANDMARKS = Object.freeze([
    STEP1_LABELS.C2_C3,
    STEP1_LABELS.L5_S,
    STEP1_LABELS.C7_T1,
    STEP1_LABELS.T12_L1
  ]);

  const DISC_REGION_MAX_SIZES = Object.freeze([5, 12, 6, 1]);
  const DISC_REGION_DEFAULT_SIZES = Object.freeze([5, 12, 5, 1]);
  const DISC_LABEL_ANCHORS = Object.freeze([63, 71, 91, 100]);
  const SCT_DISC_LABELS = Object.freeze([
    63, 64, 65, 66, 67,
    71, 72, 73, 74, 75, 76, 77, 78, 79, 80, 81, 82,
    91, 92, 93, 94, 95,
    100
  ]);
  const DEFAULT_STEP1_CLEANUP_DILATE = 5;
  const DEFAULT_DISC_POINT_RADIUS = 2;

  function index3D(x, y, z, dims) {
    return x + y * dims[0] + z * dims[0] * dims[1];
  }

  function coordsFromIndex(index, dims) {
    const [nx, ny] = dims;
    const slice = nx * ny;
    const z = Math.floor(index / slice);
    const rem = index - z * slice;
    const y = Math.floor(rem / nx);
    const x = rem - y * nx;
    return [x, y, z];
  }

  function assertVolume(data, dims, name) {
    if (!data || data.length !== dims[0] * dims[1] * dims[2]) {
      throw new Error(`${name || 'volume'} length does not match dimensions`);
    }
  }

  function createRegionSequence(anchors = DISC_LABEL_ANCHORS, sizes = DISC_REGION_DEFAULT_SIZES, step = 1) {
    const labels = [];
    for (let i = 0; i < anchors.length; i++) {
      for (let j = 0; j < sizes[i]; j++) {
        labels.push(anchors[i] + j * step);
      }
    }
    return labels;
  }

  function dilateBinaryMask(mask, dims, iterations) {
    const [nx, ny, nz] = dims;
    const slice = nx * ny;
    let current = new Uint8Array(mask);
    for (let iteration = 0; iteration < iterations; iteration++) {
      const next = new Uint8Array(current);
      for (let index = 0; index < current.length; index++) {
        if (!current[index]) continue;
        const z = Math.floor(index / slice);
        const rem = index - z * slice;
        const y = Math.floor(rem / nx);
        const x = rem - y * nx;
        if (x > 0) next[index - 1] = 1;
        if (x + 1 < nx) next[index + 1] = 1;
        if (y > 0) next[index - nx] = 1;
        if (y + 1 < ny) next[index + nx] = 1;
        if (z > 0) next[index - slice] = 1;
        if (z + 1 < nz) next[index + slice] = 1;
      }
      current = next;
    }
    return current;
  }

  function visitDilatedComponent(mask, dims, seed, visited, queue, onVoxel) {
    const [nx, ny, nz] = dims;
    const slice = nx * ny;
    let head = 0;
    let tail = 0;
    queue[tail++] = seed;
    visited[seed] = 1;

    while (head < tail) {
      const current = queue[head++];
      onVoxel(current);
      const z = Math.floor(current / slice);
      const rem = current - z * slice;
      const y = Math.floor(rem / nx);
      const x = rem - y * nx;

      for (let dz = -1; dz <= 1; dz++) {
        const zz = z + dz;
        if (zz < 0 || zz >= nz) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= ny) continue;
          for (let dx = -1; dx <= 1; dx++) {
            if (dx === 0 && dy === 0 && dz === 0) continue;
            const xx = x + dx;
            if (xx < 0 || xx >= nx) continue;
            const next = index3D(xx, yy, zz, dims);
            if (visited[next] || !mask[next]) continue;
            visited[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
  }

  function keepLargestDilatedForegroundComponent(data, dims, options = {}) {
    assertVolume(data, dims, 'TotalSpineSeg step 1 labels');
    const dilate = options.dilate == null ? DEFAULT_STEP1_CLEANUP_DILATE : Math.max(0, Number(options.dilate) || 0);
    const sourceMask = new Uint8Array(data.length);
    let sourceVoxels = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] === 0) continue;
      sourceMask[i] = 1;
      sourceVoxels++;
    }

    if (sourceVoxels === 0) {
      return {
        labels: new Uint8Array(data.length),
        componentCount: 0,
        keptVoxels: 0,
        removedVoxels: 0,
        largestDilatedVoxels: 0
      };
    }

    const componentMask = dilateBinaryMask(sourceMask, dims, dilate);
    const visited = new Uint8Array(data.length);
    const queue = new Int32Array(data.length);
    let componentCount = 0;
    let largestSeed = -1;
    let largestSourceVoxels = 0;
    let largestDilatedVoxels = 0;

    for (let seed = 0; seed < componentMask.length; seed++) {
      if (!componentMask[seed] || visited[seed]) continue;
      componentCount++;
      let componentSourceVoxels = 0;
      let componentDilatedVoxels = 0;
      visitDilatedComponent(componentMask, dims, seed, visited, queue, (index) => {
        componentDilatedVoxels++;
        if (sourceMask[index]) componentSourceVoxels++;
      });
      if (componentSourceVoxels > largestSourceVoxels) {
        largestSourceVoxels = componentSourceVoxels;
        largestDilatedVoxels = componentDilatedVoxels;
        largestSeed = seed;
      }
    }

    const labels = new Uint8Array(data.length);
    if (largestSeed < 0) {
      return {
        labels,
        componentCount,
        keptVoxels: 0,
        removedVoxels: sourceVoxels,
        largestDilatedVoxels: 0
      };
    }

    visited.fill(0);
    visitDilatedComponent(componentMask, dims, largestSeed, visited, queue, (index) => {
      if (sourceMask[index]) labels[index] = data[index];
    });

    return {
      labels,
      componentCount,
      keptVoxels: largestSourceVoxels,
      removedVoxels: sourceVoxels - largestSourceVoxels,
      largestDilatedVoxels
    };
  }

  function getConnectedComponentsForLabels(data, dims, sourceLabels) {
    assertVolume(data, dims, 'segmentation');
    const [nx, ny, nz] = dims;
    const labelSet = new Set(sourceLabels);
    const visited = new Uint8Array(data.length);
    const components = [];
    const neighbors = [
      [-1, 0, 0], [1, 0, 0],
      [0, -1, 0], [0, 1, 0],
      [0, 0, -1], [0, 0, 1]
    ];

    for (let start = 0; start < data.length; start++) {
      if (visited[start] || !labelSet.has(data[start])) continue;

      const queue = [start];
      const indices = [];
      const rawLabelCounts = new Map();
      visited[start] = 1;
      let q = 0;
      let sumX = 0;
      let sumY = 0;
      let sumZ = 0;
      let minZ = Infinity;
      let maxZ = -Infinity;

      while (q < queue.length) {
        const current = queue[q++];
        const [x, y, z] = coordsFromIndex(current, dims);
        indices.push(current);
        sumX += x;
        sumY += y;
        sumZ += z;
        minZ = Math.min(minZ, z);
        maxZ = Math.max(maxZ, z);
        rawLabelCounts.set(data[current], (rawLabelCounts.get(data[current]) || 0) + 1);

        for (const [dx, dy, dz] of neighbors) {
          const xx = x + dx;
          const yy = y + dy;
          const zz = z + dz;
          if (xx < 0 || yy < 0 || zz < 0 || xx >= nx || yy >= ny || zz >= nz) continue;
          const next = index3D(xx, yy, zz, dims);
          if (visited[next] || !labelSet.has(data[next])) continue;
          visited[next] = 1;
          queue.push(next);
        }
      }

      components.push({
        indices,
        rawLabelCounts,
        centroid: [sumX / indices.length, sumY / indices.length, sumZ / indices.length],
        minZ,
        maxZ
      });
    }

    return components.sort((a, b) => b.centroid[2] - a.centroid[2]);
  }

  function largestComponentMask(mask, dims) {
    assertVolume(mask, dims, 'component mask');
    const visited = new Uint8Array(mask.length);
    const queue = new Int32Array(mask.length);
    let bestSeed = -1;
    let bestSize = 0;
    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || visited[seed]) continue;
      let size = 0;
      visitDilatedComponent(mask, dims, seed, visited, queue, () => { size++; });
      if (size > bestSize) {
        bestSize = size;
        bestSeed = seed;
      }
    }

    const output = new Uint8Array(mask.length);
    if (bestSeed < 0) return output;
    visited.fill(0);
    visitDilatedComponent(mask, dims, bestSeed, visited, queue, (index) => {
      output[index] = 1;
    });
    return output;
  }

  function fillCanal(segmentation, dims, options = {}) {
    assertVolume(segmentation, dims, 'TotalSpineSeg labeled output');
    const canalLabel = options.canalLabel || TSS_LABELS.CANAL;
    const cordLabel = options.cordLabel || TSS_LABELS.CORD;
    const largestCanal = options.largestCanal !== false;
    const largestCord = options.largestCord !== false;
    const [nx, ny, nz] = dims;
    const output = new Uint8Array(segmentation);
    let hasCanal = false;
    let hasCord = false;

    for (let i = 0; i < output.length; i++) {
      if (output[i] === canalLabel) hasCanal = true;
      if (output[i] === cordLabel) hasCord = true;
    }

    if (cordLabel && largestCord && hasCord) {
      const cordMask = new Uint8Array(output.length);
      for (let i = 0; i < output.length; i++) {
        if (output[i] === cordLabel) cordMask[i] = 1;
      }
      const largestCordMask = largestComponentMask(cordMask, dims);
      for (let i = 0; i < output.length; i++) {
        if (cordMask[i] && !largestCordMask[i]) output[i] = canalLabel;
      }
      hasCanal = true;
    }

    if (!hasCanal) return output;

    if (largestCanal) {
      const canalMask = new Uint8Array(output.length);
      for (let i = 0; i < output.length; i++) {
        if (output[i] === canalLabel || output[i] === cordLabel) canalMask[i] = 1;
      }
      const largestCanalMask = largestComponentMask(canalMask, dims);
      for (let i = 0; i < output.length; i++) {
        if (canalMask[i] && !largestCanalMask[i]) output[i] = 0;
      }
    }

    for (let z = 0; z < nz; z++) {
      const minXByY = new Int32Array(ny);
      const maxXByY = new Int32Array(ny);
      const minYByX = new Int32Array(nx);
      const maxYByX = new Int32Array(nx);
      minXByY.fill(nx);
      maxXByY.fill(-1);
      minYByX.fill(ny);
      maxYByX.fill(-1);

      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const value = output[index3D(x, y, z, dims)];
          if (value !== canalLabel && value !== cordLabel) continue;
          if (x < minXByY[y]) minXByY[y] = x;
          if (x > maxXByY[y]) maxXByY[y] = x;
          if (y < minYByX[x]) minYByX[x] = y;
          if (y > maxYByX[x]) maxYByX[x] = y;
        }
      }

      for (let y = 0; y < ny; y++) {
        if (maxXByY[y] < 0) continue;
        for (let x = minXByY[y]; x <= maxXByY[y]; x++) {
          if (minYByX[x] <= y && y <= maxYByX[x]) {
            const index = index3D(x, y, z, dims);
            if (output[index] !== cordLabel) output[index] = canalLabel;
          }
        }
      }
    }

    return output;
  }

  function chooseComponentLandmark(component, selectedDiscLandmarks = SELECTED_DISC_LANDMARKS) {
    for (const rawLabel of selectedDiscLandmarks) {
      if (component.rawLabelCounts.has(rawLabel)) {
        return DISC_LANDMARKS.find(item => item.rawLabel === rawLabel) || null;
      }
    }
    return null;
  }

  function buildDiscComponentOutputMap(components, options = {}) {
    const selectedDiscLandmarks = options.selectedDiscLandmarks || SELECTED_DISC_LANDMARKS;
    const possibleLabels = createRegionSequence(
      options.discLandmarkOutputLabels || DISC_LABEL_ANCHORS,
      options.regionMaxSizes || DISC_REGION_MAX_SIZES,
      options.discOutputStep || 1
    );
    const defaultLabels = createRegionSequence(
      options.discLandmarkOutputLabels || DISC_LABEL_ANCHORS,
      options.regionDefaultSizes || DISC_REGION_DEFAULT_SIZES,
      options.discOutputStep || 1
    );
    const landmarks = new Map();
    const warnings = [];

    for (let i = 0; i < components.length; i++) {
      const landmark = chooseComponentLandmark(components[i], selectedDiscLandmarks);
      if (!landmark) continue;

      if (landmark.rawLabel === STEP1_LABELS.C2_C3 && i !== 0) {
        warnings.push('Ignored C2-C3 landmark because it is not the superior-most disc component.');
        continue;
      }
      if (landmark.rawLabel === STEP1_LABELS.L5_S && i !== components.length - 1) {
        warnings.push('Ignored L5-S landmark because it is not the inferior-most disc component.');
        continue;
      }
      landmarks.set(i, landmark.outputLabel);
    }

    if (landmarks.size === 0) {
      return { outputByComponent: new Map(), warnings: [...warnings, 'No usable disc landmarks found.'] };
    }

    const outputByComponent = new Map();
    const orderedLandmarks = [...landmarks.entries()].sort((a, b) => a[0] - b[0]);

    for (const [componentIndex, outputLabel] of orderedLandmarks) {
      const defaultOutputIndex = defaultLabels.indexOf(outputLabel);
      const possibleOutputIndex = possibleLabels.indexOf(outputLabel);
      if (possibleOutputIndex < 0) continue;

      if (outputByComponent.size === 0 && defaultOutputIndex >= 0) {
        const startComponent = Math.max(0, componentIndex - defaultOutputIndex);
        const startOutput = Math.max(0, defaultOutputIndex - componentIndex);
        for (let c = startComponent, o = startOutput; c < components.length && o < defaultLabels.length; c++, o++) {
          outputByComponent.set(c, defaultLabels[o]);
        }
      }

      for (let c = componentIndex, o = possibleOutputIndex; c < components.length && o < possibleLabels.length; c++, o++) {
        outputByComponent.set(c, possibleLabels[o]);
      }
    }

    return { outputByComponent, warnings };
  }

  function labelStep1Output(rawLabels, dims, options = {}) {
    assertVolume(rawLabels, dims, 'TotalSpineSeg step 1 labels');
    const output = new Uint8Array(rawLabels.length);

    for (let i = 0; i < rawLabels.length; i++) {
      if (rawLabels[i] === STEP1_LABELS.CORD) output[i] = TSS_LABELS.CORD;
      else if (rawLabels[i] === STEP1_LABELS.CANAL) output[i] = TSS_LABELS.CANAL;
      else if (rawLabels[i] === STEP1_LABELS.C1) output[i] = TSS_LABELS.C1;
      else if (rawLabels[i] === STEP1_LABELS.SACRUM) output[i] = TSS_LABELS.SACRUM;
    }

    const discComponents = getConnectedComponentsForLabels(rawLabels, dims, [
      STEP1_LABELS.OTHER_DISC,
      STEP1_LABELS.C2_C3,
      STEP1_LABELS.C7_T1,
      STEP1_LABELS.T12_L1,
      STEP1_LABELS.L5_S
    ]);
    const { outputByComponent, warnings } = buildDiscComponentOutputMap(discComponents, options);

    for (const [componentIndex, outputLabel] of outputByComponent.entries()) {
      const component = discComponents[componentIndex];
      if (!component) continue;
      for (const index of component.indices) output[index] = outputLabel;
    }

    return {
      labels: output,
      discComponents,
      componentOutputLabels: outputByComponent,
      warnings
    };
  }

  function buildCenterlineByZ(segmentation, dims, labels = [TSS_LABELS.CORD, TSS_LABELS.CANAL]) {
    const [nx, ny, nz] = dims;
    const labelSet = new Set(labels);
    const sums = Array.from({ length: nz }, () => ({ x: 0, y: 0, count: 0 }));
    for (let z = 0; z < nz; z++) {
      for (let y = 0; y < ny; y++) {
        for (let x = 0; x < nx; x++) {
          const index = index3D(x, y, z, dims);
          if (!labelSet.has(segmentation[index])) continue;
          sums[z].x += x;
          sums[z].y += y;
          sums[z].count++;
        }
      }
    }
    return sums.map(item => item.count > 0 ? [item.x / item.count, item.y / item.count] : null);
  }

  function nearestCenterlineAtZ(centerlineByZ, z) {
    if (centerlineByZ[z]) return centerlineByZ[z];
    for (let delta = 1; delta < centerlineByZ.length; delta++) {
      if (z - delta >= 0 && centerlineByZ[z - delta]) return centerlineByZ[z - delta];
      if (z + delta < centerlineByZ.length && centerlineByZ[z + delta]) return centerlineByZ[z + delta];
    }
    return null;
  }

  function chooseDiscPoint(indices, segmentation, dims, centerlineByZ) {
    let sumX = 0;
    let sumY = 0;
    let sumZ = 0;
    for (const index of indices) {
      const [x, y, z] = coordsFromIndex(index, dims);
      sumX += x;
      sumY += y;
      sumZ += z;
    }
    const centroid = [sumX / indices.length, sumY / indices.length, sumZ / indices.length];
    let bestIndex = indices[0];
    let bestScore = Infinity;

    for (const index of indices) {
      const [x, y, z] = coordsFromIndex(index, dims);
      const centerline = nearestCenterlineAtZ(centerlineByZ, z);
      const dx = centerline ? x - centerline[0] : x - centroid[0];
      const dy = centerline ? y - centerline[1] : y - centroid[1];
      const dz = centerline ? 0 : z - centroid[2];
      const score = dx * dx + dy * dy + dz * dz;
      if (score < bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    }

    return bestIndex;
  }

  function paintDiscPoint(output, dims, centerIndex, label, radius) {
    const [nx, ny, nz] = dims;
    const [cx, cy, cz] = coordsFromIndex(centerIndex, dims);
    const r = Math.max(0, Math.floor(Number(radius) || 0));
    const r2 = r * r;
    for (let dz = -r; dz <= r; dz++) {
      const z = cz + dz;
      if (z < 0 || z >= nz) continue;
      for (let dy = -r; dy <= r; dy++) {
        const y = cy + dy;
        if (y < 0 || y >= ny) continue;
        for (let dx = -r; dx <= r; dx++) {
          if (dx * dx + dy * dy + dz * dz > r2) continue;
          const x = cx + dx;
          if (x < 0 || x >= nx) continue;
          output[index3D(x, y, z, dims)] = label;
        }
      }
    }
  }

  function extractDiscLabelPoints(segmentation, dims, options = {}) {
    assertVolume(segmentation, dims, 'TotalSpineSeg labeled output');
    const output = new Uint8Array(segmentation.length);
    const discLabels = options.discLabels || SCT_DISC_LABELS;
    const pointStartLabel = options.pointStartLabel || 3;
    const pointRadius = options.discPointRadius == null ? DEFAULT_DISC_POINT_RADIUS : options.discPointRadius;
    const centerlineByZ = buildCenterlineByZ(segmentation, dims, options.centerlineLabels || [TSS_LABELS.CORD, TSS_LABELS.CANAL]);

    for (let i = 0; i < discLabels.length; i++) {
      const label = discLabels[i];
      const indices = [];
      for (let index = 0; index < segmentation.length; index++) {
        if (segmentation[index] === label) indices.push(index);
      }
      if (indices.length === 0) continue;
      const centerIndex = chooseDiscPoint(indices, segmentation, dims, centerlineByZ);
      paintDiscPoint(output, dims, centerIndex, pointStartLabel + i, pointRadius);
    }

    return output;
  }

  function postprocessStep1(rawLabels, dims, options = {}) {
    const cleanup = options.cleanupLargestComponent === false
      ? {
          labels: rawLabels,
          componentCount: null,
          keptVoxels: null,
          removedVoxels: 0,
          largestDilatedVoxels: null
        }
      : keepLargestDilatedForegroundComponent(rawLabels, dims, { dilate: options.cleanupDilate });
    const labeled = labelStep1Output(cleanup.labels, dims, options);
    const filledLabels = options.fillCanal === false ? labeled.labels : fillCanal(labeled.labels, dims, options);
    const discPoints = extractDiscLabelPoints(filledLabels, dims, options);
    const warnings = [...labeled.warnings];
    if (cleanup.removedVoxels > 0) {
      warnings.unshift(`Removed ${cleanup.removedVoxels} voxels outside the largest TotalSpineSeg Step 1 component.`);
    }
    return {
      step1Labels: filledLabels,
      discLabels: discPoints,
      discComponents: labeled.discComponents,
      componentOutputLabels: labeled.componentOutputLabels,
      cleanup,
      warnings
    };
  }

  return {
    STEP1_LABELS,
    TSS_LABELS,
    DISC_LANDMARKS,
    SCT_DISC_LABELS,
    DEFAULT_DISC_POINT_RADIUS,
    index3D,
    coordsFromIndex,
    createRegionSequence,
    dilateBinaryMask,
    keepLargestDilatedForegroundComponent,
    largestComponentMask,
    fillCanal,
    getConnectedComponentsForLabels,
    buildDiscComponentOutputMap,
    labelStep1Output,
    buildCenterlineByZ,
    extractDiscLabelPoints,
    postprocessStep1
  };
});
