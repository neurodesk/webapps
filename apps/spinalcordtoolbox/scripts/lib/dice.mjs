// Dice overlap of two binary masks: 2 * |A and B| / (|A| + |B|).
// A voxel is foreground when its value is greater than zero.

export function diceCoefficient(reference, candidate) {
  if (reference.length !== candidate.length) {
    throw new Error(`Dice needs masks of equal length, got ${reference.length} and ${candidate.length}`);
  }
  let referenceCount = 0;
  let candidateCount = 0;
  let intersection = 0;
  for (let index = 0; index < reference.length; index++) {
    const inReference = reference[index] > 0;
    const inCandidate = candidate[index] > 0;
    if (inReference) referenceCount++;
    if (inCandidate) candidateCount++;
    if (inReference && inCandidate) intersection++;
  }
  if (referenceCount + candidateCount === 0) {
    throw new Error('Dice is undefined for two empty masks');
  }
  return {
    dice: (2 * intersection) / (referenceCount + candidateCount),
    referenceCount,
    candidateCount,
    intersection
  };
}
