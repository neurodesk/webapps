// V2's upstream compare_parity.py matches top-K candidates within one voxel,
// preserving rank and count flag. Probability differences are reported.
// Source: astewartau/prostate c9b328a2e0bc1768c0b75640f5532e2853e7ef31.
export function compareDetections(ours, reference) {
  let sameTopK = ours.markers.length === reference.markers.length;
  let sameOrder = sameTopK;
  let maximumCentroidShiftVoxels = 0;
  let maximumMeanProbabilityDifference = 0;
  const matched = new Set();
  for (const [index, marker] of ours.markers.entries()) {
    const distances = reference.markers.map(candidate => Math.hypot(...marker.centroidVox.map((value, axis) => value - candidate.centroidVox[axis])));
    const distance = Math.min(...distances);
    const nearest = distances.indexOf(distance);
    if (nearest < 0 || distance > 1 || matched.has(nearest)) {
      sameTopK = false;
      continue;
    }
    matched.add(nearest);
    sameOrder &&= nearest === index;
    maximumCentroidShiftVoxels = Math.max(maximumCentroidShiftVoxels, distance);
    maximumMeanProbabilityDifference = Math.max(maximumMeanProbabilityDifference, Math.abs(marker.meanProb - reference.markers[nearest].meanProb));
  }
  return {
    sameTopK,
    sameOrder: sameTopK && sameOrder,
    sameCandidateCount: ours.nCandidates === reference.nCandidates,
    sameCountFlag: ours.countFlag === reference.countFlag,
    maximumCentroidShiftVoxels,
    maximumMeanProbabilityDifference,
  };
}
