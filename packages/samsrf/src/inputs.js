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
