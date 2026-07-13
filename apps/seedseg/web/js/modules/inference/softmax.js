/**
 * Softmax and probability extraction for multi-class segmentation output.
 */

/**
 * Apply softmax across classes for each voxel and extract class-1 probability.
 * Input layout: [1, numClasses, D, H, W] as flat Float32Array
 * (batch dimension = 1, so effectively [numClasses, voxelCount])
 *
 * @param {Float32Array} rawOutput - Model output [1, numClasses, D*H*W]
 * @param {number} voxelCount - Total number of voxels (D*H*W)
 * @param {number} numClasses - Number of output classes (default 3)
 * @returns {Float32Array} Class-1 probabilities, length voxelCount
 */
export function softmaxExtractClass1(rawOutput, voxelCount, numClasses = 3) {
  const result = new Float32Array(voxelCount);

  for (let v = 0; v < voxelCount; v++) {
    // Find max logit for numerical stability
    let maxLogit = -Infinity;
    for (let c = 0; c < numClasses; c++) {
      const logit = rawOutput[c * voxelCount + v];
      if (logit > maxLogit) maxLogit = logit;
    }

    // Compute exp sum
    let sumExp = 0;
    for (let c = 0; c < numClasses; c++) {
      sumExp += Math.exp(rawOutput[c * voxelCount + v] - maxLogit);
    }

    // Class 1 (gold seed markers) probability
    result[v] = Math.exp(rawOutput[1 * voxelCount + v] - maxLogit) / sumExp;
  }

  return result;
}
