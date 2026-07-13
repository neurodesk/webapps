(function initN4ShrinkPolicy(root) {
  const DEFAULT_N4_SHRINK_FACTOR = 4;
  const DEFAULT_MIN_SHRUNK_DIMENSION = 16;

  function finitePositive(value) {
    return Number.isFinite(value) && value > 0;
  }

  function median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[mid]
      : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function estimateExternalDownsampleFactor(currentSpacing, nativeSpacing) {
    if (!Array.isArray(currentSpacing) || !Array.isArray(nativeSpacing)) return 1;
    const ratios = currentSpacing
      .map((spacing, index) => {
        const native = nativeSpacing[index];
        return finitePositive(spacing) && finitePositive(native) ? spacing / native : null;
      })
      .filter(finitePositive);
    const ratio = median(ratios);
    if (!finitePositive(ratio)) return 1;
    return Math.max(1, ratio);
  }

  function chooseN4ShrinkFactor(currentSpacing, nativeSpacing, dims, options = {}) {
    const baseShrinkFactor = Math.max(1, Math.round(options.baseShrinkFactor || DEFAULT_N4_SHRINK_FACTOR));
    const minShrunkDimension = Math.max(1, Math.round(options.minShrunkDimension || DEFAULT_MIN_SHRUNK_DIMENSION));
    const externalDownsampleFactor = estimateExternalDownsampleFactor(currentSpacing, nativeSpacing);

    let shrinkFactor = Math.max(1, Math.floor(baseShrinkFactor / externalDownsampleFactor));
    if (Array.isArray(dims) && dims.length) {
      const minDim = Math.min(...dims.filter(finitePositive));
      if (finitePositive(minDim)) {
        const maxShrinkForDims = Math.max(1, Math.floor(minDim / minShrunkDimension));
        shrinkFactor = Math.min(shrinkFactor, maxShrinkForDims);
      }
    }

    return {
      shrinkFactor,
      baseShrinkFactor,
      minShrunkDimension,
      externalDownsampleFactor,
      effectiveShrinkFactor: shrinkFactor * externalDownsampleFactor
    };
  }

  const api = Object.freeze({
    DEFAULT_N4_SHRINK_FACTOR,
    DEFAULT_MIN_SHRUNK_DIMENSION,
    estimateExternalDownsampleFactor,
    chooseN4ShrinkFactor
  });

  root.VesselBoostN4Policy = api;
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : self);
