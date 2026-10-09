// FSL diffusion gradients: a bval row of V b-values and a bvec file of three rows of V values.

/** Whitespace-separated numbers from one line or a whole file. */
export function parseNumbers(text) {
  return text
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
    .map(Number);
}

/**
 * Parses and validates an FSL bval/bvec pair: non-empty, finite, non-negative b-values, three
 * bvec rows of the same length. Throws an Error a user can act on.
 * @returns {{ bvals: number[], bvecs: [number[], number[], number[]] }}
 */
export function parseBvalBvec(bvalText, bvecText) {
  const bvals = parseNumbers(bvalText);
  if (bvals.length === 0) throw new Error('bval file is empty.');
  if (!bvals.every(Number.isFinite)) throw new Error('bval contains non-numeric or non-finite values.');
  if (bvals.some((b) => b < 0)) throw new Error('bval contains negative values.');
  const rows = bvecText
    .trim()
    .split(/\r?\n/)
    .map((row) => row.trim())
    .filter((row) => row.length > 0)
    .map(parseNumbers);
  if (rows.length !== 3) throw new Error(`bvec must have 3 rows (x/y/z), found ${rows.length}.`);
  for (const row of rows) {
    if (row.length !== bvals.length) throw new Error(`bvec row has ${row.length} values but bval lists ${bvals.length} directions.`);
    if (!row.every(Number.isFinite)) throw new Error('bvec contains non-numeric or non-finite values.');
  }
  return { bvals, bvecs: [rows[0], rows[1], rows[2]] };
}

/** Validates a bval/bvec pair and returns its gradient-direction count. */
export function countDirections(bvalText, bvecText) {
  return parseBvalBvec(bvalText, bvecText).bvals.length;
}

/** The first b0 volume, as dtifit counts them (b < 50), or the first volume when none is. */
export function b0Index(bvalText) {
  return Math.max(0, parseNumbers(bvalText).findIndex((b) => b < 50));
}
