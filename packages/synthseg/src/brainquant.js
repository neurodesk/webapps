// Age-normative SynthSeg brain volume report (research use only).
// A port of brainquant.py from neurodesk/neurocontainers recipes/synthseg; the
// numbers must match it, so the arithmetic keeps the Python operation order.

export const NORMS_SCHEMA = 'neurodesk.synthseg.brainquant.norms/1';
const MODEL_KEYS = ['female', 'male', 'all'];
const LOW_PERCENTILE = 5;
const HIGH_PERCENTILE = 95;
const HEADER_SEX = { F: 'female', M: 'male' };
// Scanners at or above this field strength are compared with the 7 T reference, as in brainquant.py.
export const ULTRA_HIGH_FIELD_T = 5.0;

function pyRepr(value) {
  if (value === undefined || value === null) {
    return 'None';
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False';
  }
  if (typeof value === 'string') {
    return `'${value}'`;
  }
  if (Array.isArray(value)) {
    return `[${value.map(pyRepr).join(', ')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value).map(([key, item]) => `${pyRepr(key)}: ${pyRepr(item)}`).join(', ')}}`;
  }
  return String(value);
}

class MissingField extends Error {}

function field(object, key) {
  if (object === null || typeof object !== 'object' || !(key in object)) {
    throw new MissingField(key);
  }
  return object[key];
}

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Brain volume norms: ${label} must be a finite number, got ${pyRepr(value)}`);
  }
  return value;
}

function numbers(value, count, label) {
  if (!Array.isArray(value) || value.length !== count) {
    throw new Error(`Brain volume norms: ${label} must list ${count} numbers, got ${pyRepr(value)}`);
  }
  return value.map((item, index) => number(item, `${label}[${index}]`));
}

function model(raw, label) {
  return {
    mu: numbers(field(raw, 'mu'), 3, `${label}.mu`),
    icvSlope: number(field(raw, 'icv_slope'), `${label}.icv_slope`),
    logSigma: numbers(field(raw, 'log_sigma'), 2, `${label}.log_sigma`),
  };
}

function structure(entry) {
  const columns = field(entry, 'columns');
  if (!Array.isArray(columns) || columns.length === 0 || !columns.every((column) => typeof column === 'string' && column)) {
    throw new Error(`Brain volume norms: structure ${field(entry, 'id')} needs CSV columns`);
  }
  const rawModels = field(entry, 'models');
  const keys = Object.keys(rawModels ?? {});
  if (keys.length !== MODEL_KEYS.length || !MODEL_KEYS.every((key) => keys.includes(key))) {
    throw new Error(
      `Brain volume norms: structure ${field(entry, 'id')} models ${pyRepr([...keys].sort())}, expected ${pyRepr(MODEL_KEYS)}`,
    );
  }
  const id = String(field(entry, 'id'));
  const models = {};
  for (const key of MODEL_KEYS) {
    models[key] = model(rawModels[key], `${id}.${key}`);
  }
  return { id, title: String(field(entry, 'title')), columns: [...columns], models };
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) {
      deepFreeze(item);
    }
    Object.freeze(value);
  }
  return value;
}

export function parseNorms(raw) {
  const schema = raw !== null && typeof raw === 'object' ? raw.schema : undefined;
  if (schema !== NORMS_SCHEMA) {
    throw new Error(`Brain volume norms schema ${pyRepr(schema)}, expected ${NORMS_SCHEMA}`);
  }
  let norms;
  try {
    const reference = field(raw, 'reference');
    const structures = field(raw, 'structures').map(structure);
    norms = {
      reference: {
        cohort: String(field(reference, 'cohort')),
        url: String(field(reference, 'url')),
        license: String(field(reference, 'license')),
        subjects: Math.trunc(field(reference, 'subjects')),
        female: Math.trunc(field(reference, 'female')),
        male: Math.trunc(field(reference, 'male')),
        ageMin: number(field(reference, 'age_min'), 'reference.age_min'),
        ageMax: number(field(reference, 'age_max'), 'reference.age_max'),
        synthseg: String(field(reference, 'synthseg')),
        fieldStrength: String(reference.field_strength ?? ''),
      },
      ageCenter: number(field(raw, 'age_center'), 'age_center'),
      ageScale: number(field(raw, 'age_scale'), 'age_scale'),
      icvColumn: String(field(raw, 'icv_column')),
      referenceIcvMm3: number(field(raw, 'reference_icv_mm3'), 'reference_icv_mm3'),
      structures,
    };
  } catch (error) {
    if (error instanceof MissingField) {
      throw new Error(`Brain volume norms are missing field '${error.message}'`);
    }
    throw error;
  }
  if (norms.structures.length === 0 || norms.ageScale <= 0 || norms.referenceIcvMm3 <= 0) {
    throw new Error('Brain volume norms need structures and positive age_scale and reference ICV');
  }
  return deepFreeze(norms);
}

export function scaledAge(norms, age) {
  return (age - norms.ageCenter) / norms.ageScale;
}

export function location({ mu: [b0, b1, b2] }, a) {
  return b0 + b1 * a + b2 * (a * a);
}

export function scale({ logSigma: [s0, s1] }, a) {
  return Math.exp(s0 + s1 * a);
}

export function centile(model, a, q) {
  return Math.exp(location(model, a) + normalQuantile(q) * scale(model, a));
}

// W. J. Cody, "Rational Chebyshev approximations for the error function",
// Math. Comp. 23 (1969), as in his CALERF routine.
const ERF_A = [3.1611237438705655, 113.86415415105016, 377.485237685302, 3209.3775891384694, 0.18577770618460315];
const ERF_B = [23.601290952344122, 244.02463793444417, 1282.6165260773723, 2844.236833439171];
const ERFC_C = [
  0.5641884969886701, 8.883149794388377, 66.11919063714163, 298.6351381974001,
  881.952221241769, 1712.0476126340707, 2051.0783778260716, 1230.3393547979972,
  2.1531153547440383e-8,
];
const ERFC_D = [
  15.744926110709835, 117.6939508913125, 537.1811018620099, 1621.3895745666903,
  3290.7992357334597, 4362.619090143247, 3439.3676741437216, 1230.3393548037495,
];
const ERFC_P = [0.30532663496123236, 0.36034489994980445, 0.12578172611122926, 0.016083785148742275, 0.0006587491615298378, 0.016315387137302097];
const ERFC_Q = [2.568520192289822, 1.8729528499234673, 0.5279051029514285, 0.06051834131244132, 0.0023352049762686918];
const ONE_OVER_SQRT_PI = 0.5641895835477563;

function gaussianTail(y, rational) {
  const ysq = Math.trunc(y * 16) / 16;
  const del = (y - ysq) * (y + ysq);
  return Math.exp(-ysq * ysq) * Math.exp(-del) * rational;
}

export function erfc(x) {
  if (Number.isNaN(x)) {
    return NaN;
  }
  const y = Math.abs(x);
  let result;
  if (y <= 0.46875) {
    const ysq = y > 1.11e-16 ? y * y : 0;
    let xnum = ERF_A[4] * ysq;
    let xden = ysq;
    for (let i = 0; i < 3; i++) {
      xnum = (xnum + ERF_A[i]) * ysq;
      xden = (xden + ERF_B[i]) * ysq;
    }
    return 1 - x * (xnum + ERF_A[3]) / (xden + ERF_B[3]);
  }
  if (y <= 4) {
    let xnum = ERFC_C[8] * y;
    let xden = y;
    for (let i = 0; i < 7; i++) {
      xnum = (xnum + ERFC_C[i]) * y;
      xden = (xden + ERFC_D[i]) * y;
    }
    result = gaussianTail(y, (xnum + ERFC_C[7]) / (xden + ERFC_D[7]));
  } else if (y >= 26.543) {
    result = 0;
  } else {
    const ysq = 1 / (y * y);
    let xnum = ERFC_P[5] * ysq;
    let xden = ysq;
    for (let i = 0; i < 4; i++) {
      xnum = (xnum + ERFC_P[i]) * ysq;
      xden = (xden + ERFC_Q[i]) * ysq;
    }
    const rational = ysq * (xnum + ERFC_P[4]) / (xden + ERFC_Q[4]);
    result = gaussianTail(y, (ONE_OVER_SQRT_PI - rational) / y);
  }
  return x < 0 ? 2 - result : result;
}

export function normalCdf(z) {
  return 0.5 * erfc(-z / Math.SQRT2);
}

// P. J. Acklam's rational approximation, refined by one Halley step.
const QUANTILE_A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239e0];
const QUANTILE_B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
const QUANTILE_C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838e0, -2.549732539343734e0, 4.374664141464968e0, 2.938163982698783e0];
const QUANTILE_D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996e0, 3.754408661907416e0];
const QUANTILE_LOW = 0.02425;

function polynomial(coefficients, x) {
  return coefficients.reduce((sum, coefficient) => sum * x + coefficient, 0);
}

function lowerQuantile(p) {
  let x;
  if (p < QUANTILE_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = polynomial(QUANTILE_C, q) / (polynomial(QUANTILE_D, q) * q + 1);
  } else {
    const q = p - 0.5;
    const r = q * q;
    x = polynomial(QUANTILE_A, r) * q / (polynomial(QUANTILE_B, r) * r + 1);
  }
  const u = (normalCdf(x) - p) * Math.sqrt(2 * Math.PI) * Math.exp(x * x / 2);
  return x - u / (1 + x * u / 2);
}

export function normalQuantile(p) {
  if (Number.isNaN(p) || p < 0 || p > 1) {
    return NaN;
  }
  if (p === 0) {
    return -Infinity;
  }
  if (p === 1) {
    return Infinity;
  }
  return p > 0.5 ? -lowerQuantile(1 - p) : lowerQuantile(p);
}

export function modelKey(subject) {
  return subject.sex ?? 'all';
}

function flag(percentile) {
  if (percentile === null) {
    return '';
  }
  if (percentile < LOW_PERCENTILE) {
    return '<5th';
  }
  if (percentile > HIGH_PERCENTILE) {
    return '>95th';
  }
  return '';
}

export function assess(norms, volumes, subject) {
  const columns = new Set([norms.icvColumn, ...norms.structures.flatMap((entry) => entry.columns)]);
  const missing = [...columns].filter((column) => !Object.hasOwn(volumes, column)).sort();
  if (missing.length > 0) {
    throw new Error(`SynthSeg volume CSV is missing columns required by the norms: ${pyRepr(missing)}`);
  }
  const icv = volumes[norms.icvColumn];
  if (icv <= 0) {
    throw new Error('SynthSeg reported a non-positive total intracranial volume');
  }
  const logIcvRatio = Math.log(icv) - Math.log(norms.referenceIcvMm3);
  const results = norms.structures.map((entry) => {
    const normModel = entry.models[modelKey(subject)];
    const volume = entry.columns.reduce((sum, column) => sum + volumes[column], 0);
    if (volume <= 0) {
      throw new Error(`SynthSeg reported no volume for ${entry.title}`);
    }
    const adjustedLog = Math.log(volume) - normModel.icvSlope * logIcvRatio;
    let z = null;
    if (subject.age !== null) {
      const a = scaledAge(norms, subject.age);
      z = (adjustedLog - location(normModel, a)) / scale(normModel, a);
    }
    const percentile = z === null ? null : 100 * normalCdf(z);
    return {
      id: entry.id,
      title: entry.title,
      volumeMm3: volume,
      adjustedMm3: Math.exp(adjustedLog),
      z,
      percentile,
      flag: flag(percentile),
    };
  });
  const { ageMin, ageMax } = norms.reference;
  const outsideReferenceAge = subject.age !== null && !(ageMin <= subject.age && subject.age <= ageMax);
  return { icvMm3: icv, subject, results, outsideReferenceAge };
}

function roundHalfEven(value) {
  const floor = Math.floor(value);
  if (value - floor !== 0.5) {
    return Math.round(value);
  }
  return floor % 2 === 0 ? floor : floor + 1;
}

export function percentileText(percentile) {
  if (percentile === null) {
    return 'n/a';
  }
  if (percentile < 1) {
    return '<1st';
  }
  if (percentile > 99) {
    return '>99th';
  }
  const value = roundHalfEven(percentile);
  const ordinal = { 1: 'st', 2: 'nd', 3: 'rd' };
  const suffix = value % 100 >= 10 && value % 100 <= 20 ? 'th' : (ordinal[value % 10] ?? 'th');
  return `${value}${suffix}`;
}

// Python's format(value, 'g') for the plain-notation range ages fall in.
function formatG(value) {
  return String(Number(value.toPrecision(6)));
}

function ml(mm3) {
  return mm3 / 1000;
}

function licenseText(spdx) {
  const parts = spdx.split('-');
  if (parts[0] === 'CC' && parts.length >= 3) {
    return `CC ${parts.slice(1, -1).join('-')} ${parts.at(-1)}`;
  }
  return spdx;
}

function ageRange(reference) {
  return `${formatG(reference.ageMin)}-${formatG(reference.ageMax)} y`;
}

export function headerLines(report, norms) {
  const { reference } = norms;
  const { age, sex } = report.subject;
  const ageText = age === null ? 'unknown age' : `${age} y`;
  const lines = [`Patient: ${ageText}, ${sex ?? 'unknown sex'}.  Total intracranial volume ${ml(report.icvMm3).toFixed(0)} mL.`];
  if (sex === null) {
    lines.push('Sex unknown: compared with the combined female and male reference.');
  }
  lines.push(
    `Reference: ${reference.cohort}${reference.fieldStrength ? ` ${reference.fieldStrength}` : ''} (n=${reference.subjects}, ${reference.female} F / ${reference.male} M, age ${ageRange(reference)}, ${licenseText(reference.license)}), ${reference.synthseg}.`,
  );
  lines.push('Research use only. Not for diagnostic use.');
  return lines;
}

export function footerLines(report, norms, footnotes = []) {
  const lines = [...footnotes];
  if (report.outsideReferenceAge) {
    lines.push(
      `Patient age ${report.subject.age} y is outside the reference age range ${ageRange(norms.reference)}; the curves are extrapolated.`,
    );
  }
  lines.push(
    `Adjusted volume: scaled to the reference total intracranial volume of ${ml(norms.referenceIcvMm3).toFixed(0)} mL. Bands: 5th-95th and 25th-75th percentiles; line: median.`,
  );
  return lines;
}

function sidecarDate(value) {
  const match = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(String(value ?? '').trim());
  if (!match) {
    return null;
  }
  const [year, month, day] = match.slice(1).map(Number);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

function beforeOrSame(first, second) {
  if (first.year !== second.year) {
    return first.year < second.year;
  }
  if (first.month !== second.month) {
    return first.month < second.month;
  }
  return first.day <= second.day;
}

// Dates are { year, month, day } with a 1-based month.
export function wholeYears(birth, on) {
  const beforeBirthday = on.month < birth.month || (on.month === birth.month && on.day < birth.day);
  return on.year - birth.year - (beforeBirthday ? 1 : 0);
}

function sidecarAge(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
  }
  const match = /^(\d{3})Y$/.exec(String(value ?? '').trim().toUpperCase());
  return match ? Number(match[1]) : null;
}

// Scanner field strength in tesla from a dcm2niix BIDS sidecar, or null when it is not recorded.
export function fieldStrengthFromSidecar(json) {
  const value = json.MagneticFieldStrength;
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * The reference norms for a choice of 'auto' or a cohort id and the run's SynthSeg mode, and the reason
 * for the report. Auto follows brainquant.py's select_norms: AHEAD from 5 T, IXI below or when the field
 * strength is unknown. Normal mode measures some structures several percent differently from fast mode,
 * so each mode has its own norms, keyed `<cohort>-<mode>` in the manifest.
 */
export function selectReference(choice, fieldStrengthT, fast) {
  // The app calls normal mode (flip averaging and topology) "default", so the reason does too.
  const ran = `SynthSeg ran in ${fast ? 'fast' : 'default'} mode`;
  let cohort = choice;
  let why = 'it was selected manually';
  if (choice === 'auto') {
    cohort = fieldStrengthT !== null && fieldStrengthT >= ULTRA_HIGH_FIELD_T ? 'ahead' : 'ixi';
    why = fieldStrengthT === null ? 'the scanner field strength is unknown' : `the scanner field strength is ${formatG(fieldStrengthT)} T`;
  }
  return { id: `${cohort}-${fast ? 'fast' : 'normal'}`, cohort, reason: `${why} and ${ran}` };
}

export function referenceNote(norms, reason) {
  return `The ${norms.reference.cohort} reference was chosen because ${reason}.`;
}

// Age and sex from a dcm2niix BIDS sidecar of a non-anonymised series.
export function subjectFromSidecar(json) {
  let age = sidecarAge(json.PatientAge);
  if (age === null) {
    const birth = sidecarDate(json.PatientBirthDate);
    const on = [json.AcquisitionDateTime, json.AcquisitionDate, json.StudyDate].map(sidecarDate).find((date) => date !== null) ?? null;
    age = birth !== null && on !== null && beforeOrSame(birth, on) ? wholeYears(birth, on) : null;
  }
  const sex = HEADER_SEX[String(json.PatientSex ?? '').trim().toUpperCase()] ?? null;
  return { age, sex };
}
