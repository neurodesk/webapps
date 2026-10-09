/**
 * Scan parameters a reconstruction depends on
 *
 * A missing field strength or echo time is reported, never replaced by a default:
 * a guessed value changes the numbers without anyone having chosen it.
 */

/**
 * The magnetic field strength in tesla, or an error if it is missing or not positive.
 *
 * @param {*} magField - Field strength as sent by the app
 * @returns {number} B0 in tesla
 */
export function requireFieldStrength(magField) {
  const b0 = Number(magField);
  if (magField === null || magField === undefined || !Number.isFinite(b0) || b0 <= 0) {
    throw new Error(`A positive magnetic field strength (T) is required, got ${magField}`);
  }
  return b0;
}

/**
 * The step of a field-map run whose result depends on the echo time, or null if none does.
 *
 * TGV and MEDI regularize the field in radians at the first echo, so the same field
 * and settings give different susceptibility at a different TE. In field-map modes
 * that TE has to come from the user.
 *
 * @param {Object} settings - Pipeline settings from PipelineSettingsController.save()
 * @returns {string|null} A label for the step, for error messages
 */
export function echoTimeDependentStep(settings) {
  const s = settings || {};
  const combined = s.combined_method || 'none';
  if (combined === 'tgv') return 'TGV';
  if (combined === 'qsmart') {
    return (s.qsmart?.inversion_algorithm || 'ilsqr') === 'medi' ? 'MEDI (QSMART inner inversion)' : null;
  }
  if (combined === 'none' && (s.dipole_inversion || 'rts') === 'medi') return 'MEDI';
  return null;
}

/**
 * The first echo time of a field map in seconds, or an error if `step` needs one and
 * none was given. Returns [] when nothing in the run depends on the echo time.
 *
 * @param {number[]|undefined} echoTimesMs - Echo times in milliseconds
 * @param {string|null} step - From echoTimeDependentStep
 * @returns {number[]} [TE in seconds], or []
 */
export function fieldMapEchoTimes(echoTimesMs, step) {
  const te = Number(echoTimesMs?.[0]);
  if (Number.isFinite(te) && te > 0) return [te / 1000];
  if (step) {
    throw new Error(`${step} needs the echo time the field map was acquired at; enter it under Echo Times`);
  }
  return [];
}
