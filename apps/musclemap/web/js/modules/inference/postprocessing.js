/**
 * MuscleMap Postprocessing Pipeline
 *
 * 1. Label remapping (model output index → anatomical label ID)
 * 2. Per-label connected components (keep largest component per label)
 * 3. Inverse transform (uncrop, resample, reorient)
 */

/**
 * Remap model output indices to anatomical label IDs.
 * For MuscleMap, model outputs 0-99 map directly to labels 0-99.
 *
 * @param {Uint8Array} labels - Raw model output labels
 * @param {number[]|null} labelMap - Optional mapping array (index → label ID)
 * @returns {Uint8Array} Remapped labels
 */
export function remapLabels(labels, labelMap = null) {
  if (!labelMap) return labels; // Identity mapping

  const result = new Uint8Array(labels.length);
  for (let i = 0; i < labels.length; i++) {
    result[i] = labelMap[labels[i]] || 0;
  }
  return result;
}

/**
 * For each non-background label, keep only the largest connected component.
 * Uses 3D connected components with 26-connectivity.
 *
 * @param {Uint8Array} labelVolume - 3D label volume
 * @param {number[]} dims - [nx, ny, nz]
 * @param {number} numLabels - Number of label classes (excluding background)
 * @param {Function} connectedComponents3D - CC function from connected-components.js
 * @param {Function} onProgress - Optional progress callback (labelIndex, totalLabels)
 * @returns {Uint8Array} Cleaned label volume
 */
export function perLabelLargestComponent(labelVolume, dims, numLabels, connectedComponents3D, onProgress) {
  const [nx, ny, nz] = dims;
  const n = nx * ny * nz;
  const result = new Uint8Array(n);

  for (let label = 1; label <= numLabels; label++) {
    // Create binary mask for this label
    const mask = new Uint8Array(n);
    let hasVoxels = false;
    for (let i = 0; i < n; i++) {
      if (labelVolume[i] === label) {
        mask[i] = 1;
        hasVoxels = true;
      }
    }

    if (!hasVoxels) continue;

    // Run connected components
    const { labels: ccLabels, numComponents } = connectedComponents3D(mask, dims);

    if (numComponents <= 1) {
      // Only one component or none, keep all
      for (let i = 0; i < n; i++) {
        if (mask[i]) result[i] = label;
      }
    } else {
      // Find largest component
      const componentSizes = new Int32Array(numComponents + 1);
      for (let i = 0; i < n; i++) {
        if (ccLabels[i] > 0) componentSizes[ccLabels[i]]++;
      }

      let largestComp = 1;
      let largestSize = 0;
      for (let c = 1; c <= numComponents; c++) {
        if (componentSizes[c] > largestSize) {
          largestSize = componentSizes[c];
          largestComp = c;
        }
      }

      // Keep only the largest component
      for (let i = 0; i < n; i++) {
        if (ccLabels[i] === largestComp) result[i] = label;
      }
    }

    if (onProgress) onProgress(label, numLabels);
  }

  return result;
}

/**
 * Count voxels per label.
 *
 * @param {Uint8Array} labelVolume
 * @param {number} numLabels
 * @returns {Int32Array} Counts indexed by label
 */
export function countLabels(labelVolume, numLabels) {
  const counts = new Int32Array(numLabels + 1);
  for (let i = 0; i < labelVolume.length; i++) {
    const v = labelVolume[i];
    if (v > 0 && v <= numLabels) counts[v]++;
  }
  return counts;
}

/**
 * Get list of detected (nonzero count) label indices.
 *
 * @param {Int32Array} counts
 * @returns {number[]}
 */
export function getDetectedLabels(counts) {
  const detected = [];
  for (let i = 1; i < counts.length; i++) {
    if (counts[i] > 0) detected.push(i);
  }
  return detected;
}
