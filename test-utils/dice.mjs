// Dice overlap between segmentations held in typed arrays (or plain arrays) of equal length.
// A voxel belongs to a mask when its value is non-zero; label maps compare one label at a time.
// Two empty masks have no overlap to measure: the score is defined as 1 (they agree), and
// callers that need a non-empty reference must assert that separately (see `maskVoxels`).

function requireSameLength(a, b) {
  if (a.length !== b.length) {
    throw new Error(`Dice needs equally sized arrays, got ${a.length} and ${b.length}`);
  }
}

export function maskVoxels(mask) {
  let count = 0;
  for (let index = 0; index < mask.length; index++) {
    if (mask[index]) count++;
  }
  return count;
}

export function dice(a, b) {
  requireSameLength(a, b);
  let inA = 0;
  let inB = 0;
  let inBoth = 0;
  for (let index = 0; index < a.length; index++) {
    const first = Boolean(a[index]);
    const second = Boolean(b[index]);
    if (first) inA++;
    if (second) inB++;
    if (first && second) inBoth++;
  }
  if (inA + inB === 0) return 1;
  return (2 * inBoth) / (inA + inB);
}

// Per-label Dice for label maps. `labels` defaults to every non-zero label in either map.
// Returns { [label]: { dice, voxelsA, voxelsB } }; a label absent from both maps scores 1.
export function labelDice(a, b, labels) {
  requireSameLength(a, b);
  const counts = new Map();
  const entry = (label) => {
    let value = counts.get(label);
    if (!value) {
      value = { voxelsA: 0, voxelsB: 0, both: 0 };
      counts.set(label, value);
    }
    return value;
  };
  for (let index = 0; index < a.length; index++) {
    const first = a[index];
    const second = b[index];
    if (first) entry(first).voxelsA++;
    if (second) entry(second).voxelsB++;
    if (first && first === second) entry(first).both++;
  }
  const wanted = labels ?? [...counts.keys()].sort((x, y) => x - y);
  const result = {};
  for (const label of wanted) {
    const { voxelsA, voxelsB, both } = counts.get(label) ?? { voxelsA: 0, voxelsB: 0, both: 0 };
    const total = voxelsA + voxelsB;
    result[label] = { dice: total === 0 ? 1 : (2 * both) / total, voxelsA, voxelsB };
  }
  return result;
}
