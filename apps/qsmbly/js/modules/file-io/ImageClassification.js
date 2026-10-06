/** Classify MR components before applying generic filename heuristics.
 * null means no reliable component information is available.
 */
export function classifyImage(name, metadata) {
  const types = Array.isArray(metadata?.ImageType)
    ? metadata.ImageType.map(type => String(type).toUpperCase()) : [];
  const component = String(metadata?.ComplexImageComponent || '').toUpperCase();
  if (types.some(t => ['LOCALIZER', 'SWI', 'REAL', 'IMAGINARY', 'R', 'I'].includes(t)) ||
      ['REAL', 'IMAGINARY'].includes(component)) return 'extra';
  if (types.some(t => t === 'P' || t === 'PHASE') || component === 'PHASE') return 'phase';
  if (types.some(t => t === 'M' || t === 'MAGNITUDE') || component === 'MAGNITUDE') return 'magnitude';

  // Match output suffixes, never "phaseimage" embedded in a protocol name.
  const base = name.replace(/\.nii(\.gz)?$/i, '');
  // The BIDS part- entity is unambiguous, even when the sidecar omits a component.
  const part = base.match(/(?:^|_)part-(mag|phase|real|imag)(?:_|$)/i);
  if (part) {
    const value = part[1].toLowerCase();
    if (value === 'mag') return 'magnitude';
    if (value === 'phase') return 'phase';
    return 'extra';
  }
  if (/_ph(?:_[a-z0-9]+)?$/i.test(base)) return 'phase';
  // Bruker enhanced magnitude omits MAGNITUDE in dcm2niix's sidecar.
  if (metadata?.Manufacturer?.toLowerCase() === 'bruker' &&
      types.includes('ORIGINAL') && types.includes('MULTIECHO') && types.includes('NONE')) {
    return 'magnitude';
  }
  if (types.length) return 'extra';
  if (/_e\d+$/i.test(base)) return 'magnitude';
  return null;
}
