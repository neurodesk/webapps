// Pure orientation and output-naming helpers for rodent brain extraction.
// Shared between the Brainchomp web app and the portable @neurodesk/brainchomp CLI.

// The current Brainchomp model was trained on 256^3 0.1 mm volumes whose headers
// claimed LPS while voxel axes ran R, S, A. Apply this world-space (RAS) remap
// to the temporary copy sent to brainchomp-lib; outputs retain the original affine.
export const INPUT_WORLD_REMAP = Object.freeze([
  Object.freeze([-1, 0, 0]),
  Object.freeze([0, 0, -1]),
  Object.freeze([0, 1, 0]),
]);

export const DIRS = Object.freeze({
  R: Object.freeze([1, 0, 0]),
  L: Object.freeze([-1, 0, 0]),
  A: Object.freeze([0, 1, 0]),
  P: Object.freeze([0, -1, 0]),
  S: Object.freeze([0, 0, 1]),
  I: Object.freeze([0, 0, -1]),
});

export const DIR_NAMES = Object.freeze({
  R: 'Right',
  L: 'Left',
  A: 'Anterior (nose)',
  P: 'Posterior (tail)',
  S: 'Superior (back)',
  I: 'Inferior (belly)',
});

export function axisOf(direction) {
  return DIRS[direction]?.findIndex((value) => value !== 0) ?? -1;
}

/**
 * Available directions for the next step of the 3-step quadruped Reorient prompt.
 * Picks are chosen in order [A, S, L] so each step excludes axes already picked.
 */
export function availableDirections(picks) {
  const used = new Set(picks.map(axisOf));
  return Object.keys(DIRS).filter((dir) => !used.has(axisOf(dir)));
}

/**
 * Build the 3x3 world-space remap matrix from the user's [A, S, L] picks,
 * where L may be '?' ("not sure", choosing the proper rotation R = A x S).
 * Returns null for the identity orientation.
 */
export function buildReorientMatrix([a, s, l]) {
  if (!DIRS[a] || !DIRS[s]) throw new Error('Choose valid anatomical directions for A and S.');
  if (l !== '?' && !DIRS[l]) throw new Error('Choose a valid anatomical direction for L.');
  if (a === 'A' && s === 'S' && (l === 'L' || l === '?')) return null;
  const dA = DIRS[a];
  const dS = DIRS[s];
  const dR = l === '?'
    ? [
        dA[1] * dS[2] - dA[2] * dS[1],
        dA[2] * dS[0] - dA[0] * dS[2],
        dA[0] * dS[1] - dA[1] * dS[0],
      ]
    : DIRS[l].map((value) => -value);
  return [0, 1, 2].map((row) => [dR[row], dA[row], dS[row]]);
}

/** Multiply the upper 3x4 rows of a 4x4 affine by a 3x3 world-space remap. */
export function applyWorldRemap(affine, remap) {
  const out = [0, 1, 2].map((row) =>
    [0, 1, 2, 3].map((col) =>
      remap[row][0] * affine[0][col]
      + remap[row][1] * affine[1][col]
      + remap[row][2] * affine[2][col],
    ),
  );
  out.push([0, 0, 0, 1]);
  return out;
}

export function outputNames(inputName) {
  const stem = String(inputName || 'rodent').replace(/\.nii(\.gz)?$/i, '');
  return {
    brain: `${stem}_brainchomp_brain.nii`,
    mask: `${stem}_brainchomp_mask.nii`,
    reoriented: `${stem.replace(/_reoriented$/i, '')}_reoriented.nii`,
  };
}
