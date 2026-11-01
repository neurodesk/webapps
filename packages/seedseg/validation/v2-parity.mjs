// Fixed probability and per-rank geometry limits retained from repair eeb05fa6e.
// These supplement upstream detection parity and must not be derived from the
// current run's differences. Validation checks the pinned ORT 1.30.0 adapters.
export const V2_PARITY_LIMITS = Object.freeze({
  maxProbabilityDifference: 0.05,
  maxProbabilityDifferenceMirrored: 0.2,
  maxDisagreeingVoxelsPerMarker: 5,
  minMarkerDice: 0.9,
  maxCentroidShiftVoxels: 0.25,
});

const maxValue = (data) => data.reduce((top, value) => Math.max(top, value), 0);

function markerGeometry(data, rank, nx, ny) {
  let voxels = 0;
  const sum = [0, 0, 0];
  for (let index = 0; index < data.length; index++) {
    if (data[index] !== rank) continue;
    voxels++;
    sum[0] += index % nx;
    sum[1] += Math.floor(index / nx) % ny;
    sum[2] += Math.floor(index / (nx * ny));
  }
  return { voxels, centroid: sum.map((value) => value / voxels) };
}

/**
 * Compares the command's and the browser's v2 outputs (NIfTI order, `dims` [nx, ny, nz]).
 * Throws with the first limit exceeded; returns the measured agreement.
 */
export function compareV2Outputs({
  native,
  browser,
  dims,
  mirror = false,
  limits = V2_PARITY_LIMITS,
}) {
  const [nx, ny] = dims;
  let maximumProbabilityDifference = 0;
  for (let index = 0; index < native.probability.length; index++) {
    maximumProbabilityDifference = Math.max(
      maximumProbabilityDifference,
      Math.abs(native.probability[index] - browser.probability[index]),
    );
  }
  const bound = mirror
    ? limits.maxProbabilityDifferenceMirrored
    : limits.maxProbabilityDifference;
  if (!(maximumProbabilityDifference <= bound)) {
    throw new Error(
      `v2 probability difference ${maximumProbabilityDifference} exceeds ${bound}`,
    );
  }
  const ranks = maxValue(native.markers);
  if (maxValue(browser.markers) !== ranks)
    throw new Error(
      `v2 marker count differs: ${ranks} native, ${maxValue(browser.markers)} browser`,
    );
  const markers = [];
  for (let rank = 1; rank <= ranks; rank++) {
    let both = 0;
    let disagreeing = 0;
    for (let index = 0; index < native.markers.length; index++) {
      const a = native.markers[index] === rank;
      const b = browser.markers[index] === rank;
      if (a && b) both++;
      else if (a || b) disagreeing++;
    }
    const left = markerGeometry(native.markers, rank, nx, ny);
    const right = markerGeometry(browser.markers, rank, nx, ny);
    const dice = (2 * both) / (left.voxels + right.voxels);
    const centroidShift = Math.hypot(
      ...left.centroid.map((value, axis) => value - right.centroid[axis]),
    );
    const measured = {
      rank,
      voxels: [left.voxels, right.voxels],
      disagreeing,
      dice,
      centroidShift,
    };
    if (!(disagreeing <= limits.maxDisagreeingVoxelsPerMarker))
      throw new Error(
        `v2 marker ${rank}: ${disagreeing} disagreeing voxels exceed ${limits.maxDisagreeingVoxelsPerMarker}`,
      );
    if (!(dice >= limits.minMarkerDice))
      throw new Error(
        `v2 marker ${rank}: Dice ${dice} below ${limits.minMarkerDice}`,
      );
    if (!(centroidShift <= limits.maxCentroidShiftVoxels))
      throw new Error(
        `v2 marker ${rank}: centroid shift ${centroidShift} exceeds ${limits.maxCentroidShiftVoxels}`,
      );
    markers.push(measured);
  }
  return { maximumProbabilityDifference, markers };
}
