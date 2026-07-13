/**
 * Consensus inference utilities for multi-model segmentation.
 * Matches select_top_n_markers() from consensus_inference.py
 */

import { connectedComponents3D } from './connected-components.js';

/**
 * Average multiple probability maps element-wise.
 * @param {Float32Array[]} maps - Array of probability maps (same length)
 * @returns {Float32Array} Averaged probability map
 */
export function averageProbabilityMaps(maps) {
  const n = maps[0].length;
  const result = new Float32Array(n);
  for (let m = 0; m < maps.length; m++) {
    const map = maps[m];
    for (let i = 0; i < n; i++) {
      result[i] += map[i];
    }
  }
  const count = maps.length;
  for (let i = 0; i < n; i++) {
    result[i] /= count;
  }
  return result;
}

/**
 * Select top N markers from averaged probability map using connected component analysis.
 *
 * Algorithm:
 * 1. Threshold probability map at `threshold`
 * 2. Label connected components with 26-connectivity
 * 3. Score each component by mean probability
 * 4. Keep top N components
 *
 * @param {Float32Array} probabilityMap - Averaged probability map
 * @param {number[]} dims - [nx, ny, nz]
 * @param {number} nMarkers - Number of markers to select (default 3)
 * @param {number} threshold - Probability threshold (default 0.1)
 * @returns {Float32Array} Binary mask with selected markers (0.0 or 1.0)
 */
export function selectTopNMarkers(probabilityMap, dims, nMarkers = 3, threshold = 0.1) {
  const n = probabilityMap.length;

  // Step 1: Threshold
  const binaryMask = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    binaryMask[i] = probabilityMap[i] > threshold ? 1 : 0;
  }

  // Step 2: Connected component labeling (26-connectivity)
  const { labels, numComponents } = connectedComponents3D(binaryMask, dims);

  if (numComponents === 0) {
    return new Float32Array(n); // all zeros
  }

  if (numComponents <= nMarkers) {
    // Keep all components
    const result = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      result[i] = labels[i] > 0 ? 1.0 : 0.0;
    }
    return result;
  }

  // Step 3: Calculate mean probability per component
  const componentSum = new Float64Array(numComponents + 1);
  const componentCount = new Int32Array(numComponents + 1);

  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) {
      componentSum[labels[i]] += probabilityMap[i];
      componentCount[labels[i]]++;
    }
  }

  // Step 4: Sort by mean probability descending
  const scores = [];
  for (let c = 1; c <= numComponents; c++) {
    scores.push({ label: c, meanProb: componentSum[c] / componentCount[c] });
  }
  scores.sort((a, b) => b.meanProb - a.meanProb);

  // Step 5: Keep top N
  const keepLabels = new Set();
  for (let i = 0; i < Math.min(nMarkers, scores.length); i++) {
    keepLabels.add(scores[i].label);
  }

  const result = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    result[i] = keepLabels.has(labels[i]) ? 1.0 : 0.0;
  }

  return result;
}
