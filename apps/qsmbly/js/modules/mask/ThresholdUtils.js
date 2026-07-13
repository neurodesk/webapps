/**
 * Threshold Utilities Module
 *
 * Pure functions for image thresholding operations.
 */

/**
 * Compute optimal threshold using Otsu's method
 *
 * Otsu's method finds the threshold that minimizes intra-class variance
 * (or equivalently, maximizes inter-class variance).
 *
 * @param {Float64Array|Float32Array} data - Image data
 * @param {number} numBins - Number of histogram bins (default 256)
 * @returns {Object} { thresholdValue, thresholdPercent, minVal, maxVal }
 */
export function computeOtsuThreshold(data, numBins = 256) {
  // Find min/max
  let minVal = Infinity, maxVal = -Infinity;
  for (let i = 0; i < data.length; i++) {
    if (data[i] < minVal) minVal = data[i];
    if (data[i] > maxVal) maxVal = data[i];
  }

  if (maxVal - minVal < 1e-10) {
    return { thresholdValue: minVal, thresholdPercent: 0, minVal, maxVal, error: 'constant image' };
  }

  // Build histogram
  const histogram = new Array(numBins).fill(0);
  const binWidth = (maxVal - minVal) / numBins;

  for (let i = 0; i < data.length; i++) {
    let bin = Math.floor((data[i] - minVal) / binWidth);
    bin = Math.min(bin, numBins - 1);
    histogram[bin]++;
  }

  // Compute Otsu threshold
  const totalPixels = data.length;
  let sumTotal = 0;
  for (let i = 0; i < numBins; i++) {
    sumTotal += i * histogram[i];
  }

  let sumBackground = 0;
  let weightBackground = 0;
  let maxVariance = 0;
  let optimalThresholdBin = 0;

  for (let t = 0; t < numBins; t++) {
    weightBackground += histogram[t];
    if (weightBackground === 0) continue;

    const weightForeground = totalPixels - weightBackground;
    if (weightForeground === 0) break;

    sumBackground += t * histogram[t];

    const meanBackground = sumBackground / weightBackground;
    const meanForeground = (sumTotal - sumBackground) / weightForeground;

    const variance = weightBackground * weightForeground *
      Math.pow(meanBackground - meanForeground, 2);

    if (variance > maxVariance) {
      maxVariance = variance;
      optimalThresholdBin = t;
    }
  }

  // Convert bin to threshold value
  const thresholdValue = minVal + (optimalThresholdBin + 0.5) * binWidth;

  // Convert to percentage of max
  const thresholdPercent = Math.round((thresholdValue / maxVal) * 100);

  return {
    thresholdValue,
    thresholdPercent: Math.max(1, Math.min(100, thresholdPercent)),
    minVal,
    maxVal
  };
}

/**
 * Create binary mask by thresholding magnitude data
 *
 * @param {Float64Array|Float32Array} magnitudeData - Input magnitude data
 * @param {number} thresholdPercent - Threshold as percentage of max (0-100)
 * @param {number} maxValue - Maximum value in data
 * @returns {Float32Array} Binary mask (0 or 1)
 */
export function createThresholdMask(magnitudeData, thresholdPercent, maxValue) {
  const thresholdValue = (thresholdPercent / 100) * maxValue;
  const mask = new Float32Array(magnitudeData.length);

  for (let i = 0; i < magnitudeData.length; i++) {
    mask[i] = magnitudeData[i] >= thresholdValue ? 1 : 0;
  }

  return mask;
}
