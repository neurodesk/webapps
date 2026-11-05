// Theoretical resolution and the acquisition optics an OME-XML header records.
//
// The resolutions are the FWHM estimates of Faklaris et al. 2022 (J Cell Biol 221:e202107093,
// Table 1), the values MetroloJ_QC compares measured bead FWHMs with. Wavelengths are in
// nanometres, results in micrometres. Widefield and spinning disk use the emission
// wavelength, point-scanning confocal and multiphoton the excitation wavelength.

export const MICROSCOPES = Object.freeze({
  widefield: 'Widefield',
  confocal: 'Point-scanning confocal',
  spinning: 'Spinning disk',
  multiphoton: 'Multiphoton',
});

/** The wavelength each microscope type's resolution formula uses. */
export function wavelengthKind(type) {
  return type === 'confocal' || type === 'multiphoton' ? 'excitation' : 'emission';
}

/**
 * Theoretical lateral and axial FWHM (µm).
 * @param {{ type: keyof MICROSCOPES, na: number, refractiveIndex: number, emission?: number, excitation?: number }} optics
 */
export function theoreticalResolution({ type, na, refractiveIndex: n, emission, excitation }) {
  if (!(na > 0) || !(n > 0)) throw new Error('Theoretical resolution needs a positive NA and refractive index.');
  if (na >= n) throw new Error(`The NA (${na}) must be below the immersion refractive index (${n}).`);
  const kind = wavelengthKind(type);
  const nm = kind === 'excitation' ? excitation : emission;
  if (!(nm > 0)) throw new Error(`The ${MICROSCOPES[type] ?? type} resolution needs the ${kind} wavelength.`);
  const lambda = nm / 1000;
  const cone = n - Math.sqrt(n * n - na * na);
  switch (type) {
    case 'widefield':
      return { lateral: (0.51 * lambda) / na, axial: (1.77 * n * lambda) / (na * na), wavelength: kind };
    case 'confocal':
      return { lateral: (0.51 * lambda) / na, axial: (0.88 * lambda) / cone, wavelength: kind };
    case 'spinning':
      return { lateral: (0.51 * lambda) / na, axial: lambda / cone, wavelength: kind };
    case 'multiphoton':
      return { lateral: na > 0.7 ? (0.383 * lambda) / na ** 0.91 : (0.377 * lambda) / na, axial: (0.626 * lambda) / cone, wavelength: kind };
    default:
      throw new Error(`Unknown microscope type ${type}.`);
  }
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decode(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (match, code) => {
    if (code[0] === '#') return String.fromCodePoint(code[1] === 'x' || code[1] === 'X' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return ENTITIES[code] ?? match;
  });
}

/** The attributes of the first `<prefix:Name …>` element, in either quote style, entities decoded. */
function element(xml, name) {
  const tag = xml.match(new RegExp(`<(?:[\\w.-]+:)?${name}\\b([^>]*)>`))?.[1];
  if (tag === undefined) return null;
  const attributes = {};
  for (const [, key, double, single] of tag.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) attributes[key] = decode(double ?? single);
  return attributes;
}

const NANOMETRES = { nm: 1, 'µm': 1000, um: 1000, pm: 1e-3, 'Å': 0.1, m: 1e9 };

function wavelength(attributes, name) {
  const value = Number(attributes?.[name]);
  if (!(value > 0)) return null;
  const unit = (attributes[`${name}Unit`] ?? 'nm').replace('μ', 'µ');
  const scale = NANOMETRES[unit];
  return scale ? value * scale : null;
}

const MODES = { WideField: 'widefield', LaserScanningConfocalMicroscopy: 'confocal', SpinningDiskConfocal: 'spinning', SlitScanConfocal: 'confocal', MultiPhotonMicroscopy: 'multiphoton' };

/**
 * NA, refractive index, wavelengths and microscope type from an OME-XML description, each null
 * when the header does not record it.
 */
export function omeOptics(description) {
  const xml = String(description ?? '');
  const empty = { na: null, refractiveIndex: null, emission: null, excitation: null, type: null };
  if (!/<(?:[\w.-]+:)?OME\b/.test(xml)) return empty;
  const objective = element(xml, 'Objective');
  const settings = element(xml, 'ObjectiveSettings');
  const channel = element(xml, 'Channel');
  const na = Number(objective?.LensNA);
  const index = Number(settings?.RefractiveIndex);
  return {
    na: na > 0 ? na : null,
    refractiveIndex: index >= 1 ? index : objective?.Immersion === 'Air' ? 1 : null,
    emission: wavelength(channel, 'EmissionWavelength'),
    excitation: wavelength(channel, 'ExcitationWavelength'),
    type: MODES[channel?.AcquisitionMode] ?? null,
  };
}
