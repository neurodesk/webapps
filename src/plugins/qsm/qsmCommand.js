import { qsmDefaults } from './qsmDefaults.js';

const DEFAULT_MASK_OPS = ['threshold:otsu', 'dilate:2', 'fill-holes:0', 'erode:2'];

export function generateQsmxtCommand(settings = {}, maskOps = [], options = {}) {
  const merged = deepMerge(qsmDefaults, settings);
  const parts = ['qsmxt', 'run', options.inputDir || '<bids_dir>', options.outputDir || '<output_dir>'];
  const isTgv = merged.combinedMethod === 'tgv';
  const isQsmart = merged.combinedMethod === 'qsmart';

  if (isTgv) emit(parts, '--qsm-algorithm', 'tgv', qsmDefaults.dipoleInversion);
  else if (isQsmart) emit(parts, '--qsm-algorithm', 'qsmart', qsmDefaults.dipoleInversion);
  else emit(parts, '--qsm-algorithm', merged.dipoleInversion, qsmDefaults.dipoleInversion);

  if (!isTgv && !isQsmart) {
    emit(parts, '--unwrapping-algorithm', merged.unwrapMethod, qsmDefaults.unwrapMethod);
    if (merged.romeo?.phaseGradientCoherence === false) parts.push('--no-romeo-phase-gradient-coherence');
    if (merged.romeo?.magCoherence === false) parts.push('--no-romeo-mag-coherence');
    if (merged.romeo?.magWeight === false) parts.push('--no-romeo-mag-weight');
  }

  emitSigma(parts, '--mcpc3ds-sigma', merged.mcpc3ds?.sigma, qsmDefaults.mcpc3ds.sigma);
  if (merged.fieldCalculationMethod === 'linear_fit' && qsmDefaults.fieldCalculationMethod !== 'linear_fit') parts.push('--combine-phase false');

  const isMediSmv = !isTgv && !isQsmart && merged.dipoleInversion === 'medi' && merged.medi?.smv;
  if (!isTgv && !isQsmart && !isMediSmv) {
    emit(parts, '--bf-algorithm', merged.backgroundRemoval, qsmDefaults.backgroundRemoval);
    emitBackgroundParams(parts, merged);
  }

  if (merged.referenceMean === false) parts.push('--qsm-reference none');
  emitDipoleParams(parts, merged, { isTgv, isQsmart });
  emitMask(parts, maskOps);

  if (options.doSwi) {
    parts.push('--do-swi');
    emitSigma(parts, '--swi-hp-sigma', merged.swi?.hpSigma, qsmDefaults.swi.hpSigma);
    emit(parts, '--swi-scaling', merged.swi?.scaling, qsmDefaults.swi.scaling);
    emitNum(parts, '--swi-strength', merged.swi?.strength, qsmDefaults.swi.strength);
    emitNum(parts, '--swi-mip-window', merged.swi?.mipWindow, qsmDefaults.swi.mipWindow);
  }
  if (options.doT2star) parts.push('--do-t2starmap');
  if (options.doR2star) parts.push('--do-r2starmap');

  return parts.join(' \\\n  ');
}

function emitBackgroundParams(parts, settings) {
  switch (settings.backgroundRemoval) {
    case 'vsharp':
      emitNum(parts, '--vsharp-threshold', settings.vsharp?.threshold, qsmDefaults.vsharp.threshold);
      emitNum(parts, '--vsharp-max-radius-factor', settings.vsharp?.maxRadiusFactor ?? settings.vsharp?.maxRadius, qsmDefaults.vsharp.maxRadiusFactor);
      emitNum(parts, '--vsharp-min-radius-factor', settings.vsharp?.minRadiusFactor ?? settings.vsharp?.minRadius, qsmDefaults.vsharp.minRadiusFactor);
      break;
    case 'pdf':
      emitNum(parts, '--pdf-tol', settings.pdf?.tol, qsmDefaults.pdf.tol);
      break;
    case 'lbv':
      emitNum(parts, '--lbv-tol', settings.lbv?.tol, qsmDefaults.lbv.tol);
      break;
    case 'ismv':
      emitNum(parts, '--ismv-tol', settings.ismv?.tol, qsmDefaults.ismv.tol);
      emitNum(parts, '--ismv-max-iter', settings.ismv?.maxit ?? settings.ismv?.maxIter, qsmDefaults.ismv.maxit);
      emitNum(parts, '--ismv-radius-factor', settings.ismv?.radiusFactor ?? settings.ismv?.radius, qsmDefaults.ismv.radiusFactor);
      break;
    case 'sharp':
      emitNum(parts, '--sharp-threshold', settings.sharp?.threshold, qsmDefaults.sharp.threshold);
      emitNum(parts, '--sharp-radius-factor', settings.sharp?.radiusFactor ?? settings.sharp?.radius, qsmDefaults.sharp.radiusFactor);
      break;
  }
}

function emitDipoleParams(parts, settings, flags) {
  if (flags.isTgv) {
    emitNum(parts, '--tgv-iterations', settings.tgv?.iterations, qsmDefaults.tgv.iterations);
    emitNum(parts, '--tgv-erosions', settings.tgv?.erosions, qsmDefaults.tgv.erosions);
    emitNum(parts, '--tgv-alpha0', settings.tgv?.alpha0, qsmDefaults.tgv.alpha0);
    emitNum(parts, '--tgv-alpha1', settings.tgv?.alpha1, qsmDefaults.tgv.alpha1);
    emitNum(parts, '--tgv-step-size', settings.tgv?.stepSize, qsmDefaults.tgv.stepSize);
    emitNum(parts, '--tgv-tol', settings.tgv?.tol, qsmDefaults.tgv.tol);
    return;
  }
  if (flags.isQsmart) {
    emitNum(parts, '--qsmart-ilsqr-tol', settings.qsmart?.ilsqrTol, qsmDefaults.qsmart.ilsqrTol);
    emitNum(parts, '--qsmart-ilsqr-max-iter', settings.qsmart?.ilsqrMaxIter, qsmDefaults.qsmart.ilsqrMaxIter);
    emitNum(parts, '--qsmart-vasc-sphere-radius', settings.qsmart?.vascSphereRadiusMm, qsmDefaults.qsmart.vascSphereRadiusMm);
    emitNum(parts, '--qsmart-sdf-spatial-radius', settings.qsmart?.sdfSpatialRadius, qsmDefaults.qsmart.sdfSpatialRadius);
    return;
  }

  switch (settings.dipoleInversion) {
    case 'rts':
      emitNum(parts, '--rts-delta', settings.rts?.delta, qsmDefaults.rts.delta);
      emitNum(parts, '--rts-mu', settings.rts?.mu, qsmDefaults.rts.mu);
      emitNum(parts, '--rts-rho', settings.rts?.rho, qsmDefaults.rts.rho);
      emitNum(parts, '--rts-tol', settings.rts?.tol, qsmDefaults.rts.tol);
      emitNum(parts, '--rts-max-iter', settings.rts?.maxIter, qsmDefaults.rts.maxIter);
      emitNum(parts, '--rts-lsmr-iter', settings.rts?.lsmrIter, qsmDefaults.rts.lsmrIter);
      break;
    case 'tv':
      emitNum(parts, '--tv-lambda', settings.tv?.lambda, qsmDefaults.tv.lambda);
      emitNum(parts, '--tv-rho', settings.tv?.rho, qsmDefaults.tv.rho);
      emitNum(parts, '--tv-tol', settings.tv?.tol, qsmDefaults.tv.tol);
      emitNum(parts, '--tv-max-iter', settings.tv?.maxIter, qsmDefaults.tv.maxIter);
      break;
    case 'tkd':
      emitNum(parts, '--tkd-threshold', settings.tkd?.threshold, qsmDefaults.tkd.threshold);
      break;
    case 'tsvd':
      emitNum(parts, '--tsvd-threshold', settings.tsvd?.threshold, qsmDefaults.tsvd.threshold);
      break;
    case 'tikhonov':
      emitNum(parts, '--tikhonov-lambda', settings.tikhonov?.lambda, qsmDefaults.tikhonov.lambda);
      break;
    case 'nltv':
      emitNum(parts, '--nltv-lambda', settings.nltv?.lambda, qsmDefaults.nltv.lambda);
      emitNum(parts, '--nltv-mu', settings.nltv?.mu, qsmDefaults.nltv.mu);
      emitNum(parts, '--nltv-tol', settings.nltv?.tol, qsmDefaults.nltv.tol);
      emitNum(parts, '--nltv-max-iter', settings.nltv?.maxIter, qsmDefaults.nltv.maxIter);
      emitNum(parts, '--nltv-newton-iter', settings.nltv?.newtonMaxIter, qsmDefaults.nltv.newtonMaxIter);
      break;
    case 'medi':
      emitNum(parts, '--medi-lambda', settings.medi?.lambda, qsmDefaults.medi.lambda);
      emitNum(parts, '--medi-percentage', settings.medi?.percentage, qsmDefaults.medi.percentage);
      emitNum(parts, '--medi-max-iter', settings.medi?.maxIter, qsmDefaults.medi.maxIter);
      emitNum(parts, '--medi-cg-max-iter', settings.medi?.cgMaxIter, qsmDefaults.medi.cgMaxIter);
      emitNum(parts, '--medi-cg-tol', settings.medi?.cgTol, qsmDefaults.medi.cgTol);
      emitNum(parts, '--medi-tol', settings.medi?.tol, qsmDefaults.medi.tol);
      emitNum(parts, '--medi-smv-radius', settings.medi?.smvRadius, qsmDefaults.medi.smvRadius);
      if (settings.medi?.smv !== qsmDefaults.medi.smv && settings.medi?.smv) parts.push('--medi-smv');
      break;
  }
}

function emitMask(parts, maskOps) {
  if (!maskOps?.length) return;
  const current = `phase-quality,${maskOps.join(',')}`;
  const defaults = `phase-quality,${DEFAULT_MASK_OPS.join(',')}`;
  if (current !== defaults) parts.push(`--mask ${current}`);
}

function emit(parts, flag, value, defaultValue) {
  if (value != null && value !== defaultValue) parts.push(`${flag} ${value}`);
}

function emitNum(parts, flag, value, defaultValue) {
  if (value != null && Number(value) !== Number(defaultValue)) parts.push(`${flag} ${value}`);
}

function emitSigma(parts, flag, value, defaultValue) {
  if (!Array.isArray(value) || !Array.isArray(defaultValue)) return;
  if (value.length !== defaultValue.length || value.some((item, index) => Number(item) !== Number(defaultValue[index]))) {
    parts.push(`${flag} ${value.join(' ')}`);
  }
}

function deepMerge(base, overrides) {
  if (!overrides || typeof overrides !== 'object') return structuredCloneFallback(base);
  const result = structuredCloneFallback(base);
  for (const [key, value] of Object.entries(overrides)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMerge(result[key], value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function structuredCloneFallback(value) {
  return globalThis.structuredClone ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}
