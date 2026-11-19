/** FreeSurfer and BIDS hemisphere tokens in a file's base name. */
export function hemisphereOf(path) {
  const name = path.split(/[\\/]/).pop();
  const bids = /(?:^|_)hemi-([LR])(?:_|\.)/i.exec(name);
  if (bids) return bids[1].toLowerCase() === 'r' ? 'rh' : 'lh';
  return /(?:^|[._-])(lh|rh|bi)(?=[._-]|$)/i.exec(name)?.[1].toLowerCase() ?? 'srf';
}

/** Refuse mixed hemispheres before any files are averaged or template coordinates flipped. */
export function resolveHemisphere(names, { hemisphere, required = false } = {}) {
  if (hemisphere !== undefined && !['lh', 'rh', 'bi', 'srf'].includes(hemisphere)) {
    throw new Error('Hemisphere must be lh, rh, bi or srf.');
  }
  const sides = new Set(names.filter(Boolean).map(hemisphereOf).filter(side => side !== 'srf'));
  if (hemisphere && hemisphere !== 'srf') sides.add(hemisphere);
  if (sides.size > 1) throw new Error('Inputs name different hemispheres. Load runs, labels, template and surfaces from one hemisphere.');
  const side = hemisphere ?? sides.values().next().value ?? 'srf';
  if (required && side !== 'lh' && side !== 'rh') {
    throw new Error('Connective fields need a known hemisphere: use lh/rh or hemi-L/hemi-R file names, or --hemisphere lh/rh.');
  }
  return side;
}

/** MATLAB dir order, independent of browser locale. Explicit CLI run order is preserved. */
export function compareRunNames(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * SamSrf reads an Hrf that starts with hrf_ (any case, as the engine's model parser does) as the name
 * of a subject's old-school HRF fit, hrf_*.mat holding fP; any other name is a vertex-wise HRF map.
 */
export function isSubjectHrf(hrf) {
  return typeof hrf === 'string' && /^hrf_/i.test(hrf);
}

/** Whether a file name (or path) is a subject HRF fit: hrf_*.mat. */
export function isSubjectHrfFile(path) {
  const name = path.split(/[\\/]/).pop();
  return /\.mat$/i.test(name) && isSubjectHrf(name);
}

/** The Hrf a model gives to name a subject HRF fit file: its base name without .mat. */
export function subjectHrfName(path) {
  return path.split(/[\\/]/).pop().replace(/\.mat$/i, '');
}
