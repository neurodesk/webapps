// Keep the b0 selection independent of dwi2trx's @niivue/niimath dependency in portable n4 archives.
// test/gradients.test.js checks the rule against dwi2trx and the gradients crate's cases.
export { parseBval } from "@neurodesk/webapp-components/file-io/gradients";

/** A volume with b below this value (s/mm²) is a b0, as FSL dtifit and the gradients crate count them. */
export const B0_THRESHOLD = 50;

/**
 * The b0 volumes of a series, or every volume of a series without b-values (`bvals` null).
 * Throws when a b-value is not finite and non-negative, or when no volume is a b0.
 * @returns {number[]}
 */
export function b0Volumes(bvals, frames) {
  if (!bvals) return Array.from({ length: frames }, (_, i) => i);
  if (!bvals.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("The bval file must contain finite non-negative b-values.");
  }
  const b0 = bvals.flatMap((b, i) => (b < B0_THRESHOLD ? [i] : []));
  if (!b0.length) throw new Error(`The bval file lists no b0 volume (b < ${B0_THRESHOLD} s/mm²).`);
  return b0;
}
