/**
 * TGV parameter resolution
 *
 * The exported config reports the user's TGV settings, so the run must use them too.
 * qsm-core's defaults fill in only what the user left unset.
 */

const isPositive = (x) => Number.isFinite(x) && x > 0;

/**
 * Resolve the alphas a TGV run uses: explicit alpha0/alpha1 when both are set, otherwise
 * the pair the regularization level stands for. The worker's run and ConfigBridge's export
 * both resolve through this, so the exported config names the alphas that ran.
 *
 * @param {Object} tgvSettings - { regularization, alpha0, alpha1 } (any may be unset)
 * @param {Function} defaultAlpha - (regularization) => [alpha0, alpha1]
 * @returns {{ alpha0: number, alpha1: number }}
 */
export function resolveTgvAlphas(tgvSettings, defaultAlpha) {
  const s = tgvSettings || {};
  if (isPositive(s.alpha0) && isPositive(s.alpha1)) return { alpha0: s.alpha0, alpha1: s.alpha1 };
  const [alpha0, alpha1] = defaultAlpha(s.regularization ?? 2);
  return { alpha0, alpha1 };
}

/**
 * Resolve the alphas and iteration count a TGV run should use.
 *
 * @param {Object} tgvSettings - { regularization, iterations, alpha0, alpha1 } (any may be unset)
 * @param {Function} defaultAlpha - (regularization) => [alpha0, alpha1], the generated preset levels
 * @param {Function} defaultIterations - () => number, qsm-core's voxel-size-adaptive count
 * @returns {{ alpha0: number, alpha1: number, iterations: number }}
 */
export function resolveTgvParams(tgvSettings, defaultAlpha, defaultIterations) {
  const s = tgvSettings || {};

  const { alpha0, alpha1 } = resolveTgvAlphas(s, defaultAlpha);

  const iterations = Number.isInteger(s.iterations) && s.iterations > 0
    ? s.iterations
    : defaultIterations();

  return { alpha0, alpha1, iterations };
}
