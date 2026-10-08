// Tissue-corrected, water-scaled concentrations: Gasparovic et al., Magn
// Reson Med 55:1219-1226 (2006), as Osprey applies it to LCModel output
// (OspreyQuantify.m quantTiss and quantAlpha, Osprey 98b2e354, MIT; same
// constants and relaxation tables). Pure and Node-tested against Osprey's
// own code run in GNU Octave (test/tissue.test.js).
//
// LCModel scales to water as if the voxel were pure white matter:
//   c_LCM = (S_M / S_W) * WCONC * ATTH2O / ATTMET
// with WCONC = 35880 mM, ATTH2O = 0.7, ATTMET = 1 (its defaults). The ratio
// S_M / S_W is recovered and rescaled with the voxel's own water:
//   c = (S_M / S_W) * 55510 * sum_t(m_t * Rw_t) / R_M / (1 - m_CSF)   [mmol/kg]
// m_t are molal water fractions, f_t * [W]_t / sum(f * [W]) with the water
// content of each tissue (Ernst et al. 1993: 0.78, 0.65 and 0.97 of pure
// water), Rw_t = (1 - exp(-TR/T1_t)) exp(-TE/T2_t) the water attenuation in
// tissue t and R_M the metabolite's, with T1/T2 averaged over GM and WM.

export const LCMODEL_WATER = Object.freeze({ wconc: 35880, atth2o: 0.7, attmet: 1 });

/** Water concentration per tissue and of pure water, mmol/kg (Osprey). */
export const WATER_CONCENTRATION = Object.freeze({ gm: 43300, wm: 36080, csf: 53840, pure: 55510 });

/**
 * Water T1 and T2 in s per tissue. 3 T: Wansapura et al. 1999 (GM, WM), Lu et
 * al. 2005 (CSF T1), Piechnik et al. 2009 (CSF T2). 7 T: Rooney et al. 2007
 * (T1), Bartha et al. 2002 (T2).
 */
export const WATER_RELAXATION = Object.freeze({
  3: { gm: { t1: 1.331, t2: 0.110 }, wm: { t1: 0.832, t2: 0.0792 }, csf: { t1: 3.817, t2: 0.503 } },
  7: { gm: { t1: 2.130, t2: 0.055 }, wm: { t1: 1.220, t2: 0.050 }, csf: { t1: 4.425, t2: 0.141 } },
});

/**
 * Metabolite [T1 GM, T1 WM, T2 GM, T2 WM] in ms (Osprey's lookUpRelaxTimes).
 * 3 T: T1 Mlynarik et al. 2001, GABA T1 Puts et al. 2013, T2 Wyss et al. 2018.
 * 7 T: Marjanska et al. 2012 and Mlynarik et al. 2012, GABA Andreychenko et al. 2012.
 */
export const METABOLITE_RELAXATION = Object.freeze({
  3: {
    Asc: [1340, 1190, (125 + 105) / 2, 172],
    Asp: [1340, 1190, (111 + 90) / 2, 148],
    Cr: [1460, 1240, (148 + 144) / 2, 166],
    GABA: [1310, 1310, (102 + 75) / 2, (102 + 75) / 2],
    Glc: [1340, 1190, (117 + 88) / 2, 155],
    Gln: [1340, 1190, (122 + 99) / 2, 168],
    Glu: [1270, 1170, (135 + 122) / 2, 124],
    Gly: [1340, 1190, (102 + 81) / 2, 152],
    GPC: [1300, 1080, (274 + 222) / 2, 218],
    GSH: [1340, 1190, (100 + 77) / 2, 145],
    Lac: [1340, 1190, (110 + 99) / 2, 159],
    mI: [1230, 1010, (244 + 229) / 2, 161],
    NAA: [1470, 1350, (253 + 263) / 2, 343],
    NAAG: [1340, 1190, (128 + 107) / 2, 185],
    PCh: [1300, 1080, (274 + 221) / 2, 213],
    PCr: [1460, 1240, (148 + 144) / 2, 166],
    PE: [1340, 1190, (119 + 86) / 2, 158],
    Scy: [1340, 1190, (125 + 107) / 2, 170],
    Tau: [1340, 1190, (123 + 102) / 2, (123 + 102) / 2],
    tNAA: [(1470 + 1340) / 2, (1350 + 1190) / 2, (253 + 263 + 128 + 107) / 4, (343 + 185) / 2],
    tCr: [(1460 + 1460) / 2, (1240 + 1240) / 2, (148 + 144 + 148 + 144) / 4, (166 + 166) / 2],
    tCho: [(1300 + 1080) / 2, (1080 + 1080) / 2, (274 + 222 + 274 + 221) / 4, (218 + 213) / 2],
    Glx: [(1340 + 1270) / 2, (1190 + 1170) / 2, (122 + 99 + 135 + 122) / 4, (168 + 124) / 2],
    default: [1340, 1190, 140, 169],
  },
  7: {
    Asc: [1530, 1484, 127, 128],
    Asp: [1530, 1484, 127, 128],
    Cr: [1740, 1780, 107, 107],
    GABA: [1334, 1334, 87, 87],
    Glc: [1530, 1484, 127, 128],
    Gln: [1640, 1740, 107, 107],
    Glu: [1610, 1750, 107, 117],
    Gly: [1530, 1484, 127, 128],
    GPC: [1510, 1320, 153, 153],
    GSH: [1140, 1060, 79, 79],
    Lac: [1530, 1484, 182, 182],
    mI: [1280, 1190, 111, 111],
    NAA: [1780, 1830, 155, 155],
    NAAG: [1210, 940, 155, 155],
    PCh: [1510, 1320, 153, 153],
    PCr: [1740, 1780, 107, 107],
    PE: [1310, 1320, 182, 182],
    sI: [1310, 1230, 105, 105],
    Tau: [2150, 2090, 97, 97],
    tNAA: [1495, 1385, 155, 155],
    tCr: [1740, 1780, 107, 107],
    tCho: [1510, 1320, 153, 153],
    Glx: [1625, 1745, 107, 112],
    default: [1530, 1484, 127, 128],
  },
});

// LCModel's names for Osprey's: basis names and LCModel's combinations.
const ALIASES = {
  Ins: "mI",
  "NAA+NAAG": "tNAA",
  "Cr+PCr": "tCr",
  "GPC+PCh": "tCho",
  "PCh+GPC": "tCho",
  "Glu+Gln": "Glx",
};

/** Field-strength key for the relaxation tables (Osprey: 2.8-3.1 T is 3 T). */
export function fieldKey(fieldT) {
  if (fieldT >= 2.8 && fieldT < 3.1) return 3;
  if (fieldT >= 6.5 && fieldT < 7.5) return 7;
  return null;
}

/** Metabolite T1 and T2 in s, averaged over GM and WM as Osprey does. */
export function metaboliteRelaxation(name, field) {
  const table = METABOLITE_RELAXATION[field];
  const key = name === "Scyllo" ? (field === 3 ? "Scy" : "sI") : ALIASES[name] ?? name;
  const known = Object.hasOwn(table, key) && key !== "default";
  const [t1gm, t1wm, t2gm, t2wm] = known ? table[key] : table.default;
  return { t1: (t1gm + t1wm) / 2000, t2: (t2gm + t2wm) / 2000, known };
}

const attenuation = (tr, te, t1, t2) => (1 - Math.exp(-tr / t1)) * Math.exp(-te / t2);

/** Volume fractions normalised to sum to 1. */
export function normalizeFractions({ gm, wm, csf }) {
  const values = [gm, wm, csf].map(Number);
  if (values.some((v) => !Number.isFinite(v) || v < 0)) throw new Error("Tissue fractions must be numbers from 0 to 1.");
  const sum = values[0] + values[1] + values[2];
  if (!(sum > 0)) throw new Error("The tissue fractions add up to zero.");
  const [g, w, c] = values.map((v) => v / sum);
  if (c >= 1) throw new Error("A voxel of pure CSF has no tissue to correct to.");
  return { gm: g, wm: w, csf: c };
}

/**
 * Tissue-corrected concentrations for LCModel's rows.
 * @param {{name: string, concentration: number}[]} rows  water-scaled LCModel output (mM)
 * @param {{
 *   fractions: {gm: number, wm: number, csf: number},
 *   fieldT: number,
 *   metabolite: {teMs: number, trMs: number},
 *   water: {teMs: number, trMs: number},
 *   metaboliteRelaxation?: boolean,
 *   alpha?: boolean,
 *   lcmodel?: {wconc: number, atth2o: number, attmet: number},
 * }} options  `metaboliteRelaxation: false` leaves metabolite signals
 *   uncorrected (R_M = 1). `alpha` adds Harris et al.'s alpha-corrected
 *   GABA and Glx (J Magn Reson Imaging 42:1431-1440, 2015; alpha = 0.5).
 */
export function correctConcentrations(rows, options) {
  const field = fieldKey(options.fieldT);
  if (!field) throw new Error(`Relaxation constants are tabulated for 3 T and 7 T; these data are at ${Number(options.fieldT).toFixed(2)} T.`);
  const f = normalizeFractions(options.fractions);
  const lcm = { ...LCMODEL_WATER, ...options.lcmodel };
  const relaxMetabolites = options.metaboliteRelaxation !== false;
  const water = WATER_RELAXATION[field];
  const [tr, te] = [options.metabolite.trMs / 1000, options.metabolite.teMs / 1000];
  const [trW, teW] = [options.water.trMs / 1000, options.water.teMs / 1000];
  if (![tr, te, trW, teW].every((v) => v > 0)) throw new Error("Tissue correction needs the echo and repetition times of both scans.");
  const W = WATER_CONCENTRATION;
  const waterSum = f.gm * W.gm + f.wm * W.wm + f.csf * W.csf;
  const molal = { gm: (f.gm * W.gm) / waterSum, wm: (f.wm * W.wm) / waterSum, csf: (f.csf * W.csf) / waterSum };
  const rw = Object.fromEntries(["gm", "wm", "csf"].map((t) => [t, attenuation(trW, teW, water[t].t1, water[t].t2)]));
  const scale = lcm.atth2o / (lcm.wconc * lcm.attmet);
  // GABA+MM3co is GABA+ under the co-edited macromolecule model (lcmodel-io.js).
  const alphaNames = new Set(["GABA", "Glu", "Gln", "Glx", "Glu+Gln", "GABA+", "GABAplus", "GABA+MM3co"]);
  const out = rows.map((row) => {
    const relax = metaboliteRelaxation(row.name, field);
    const rm = relaxMetabolites ? attenuation(tr, te, relax.t1, relax.t2) : 1;
    const ratio = row.concentration * scale;
    const corrected = ratio * W.pure * (molal.gm * rw.gm + molal.wm * rw.wm + molal.csf * rw.csf) / rm / (1 - molal.csf);
    const result = { ...row, corrected, t1: relax.t1, t2: relax.t2, relaxationKnown: relax.known };
    if (options.alpha && alphaNames.has(row.name)) {
      // Harris 2015 as Osprey's quantAlpha: volume fractions times tissue water, no CSF division.
      const harris = ratio * (f.gm * W.gm * rw.gm + f.wm * W.wm * rw.wm + f.csf * W.csf * rw.csf) / rm;
      result.alphaCorrected = harris / (f.gm + 0.5 * f.wm);
    }
    return result;
  });
  return {
    rows: out,
    fractions: f,
    molalFractions: molal,
    field,
    waterAttenuation: rw,
    constants: {
      method: "Gasparovic et al. 2006 (Osprey quantTiss)",
      unit: "mmol/kg tissue water",
      lcmodel: lcm,
      waterConcentration: W,
      waterRelaxation: water,
      metaboliteRelaxation: relaxMetabolites,
      alpha: options.alpha ? 0.5 : null,
      metabolite: { ...options.metabolite },
      water: { ...options.water },
    },
  };
}

const csvCell = (c) => (/[",\n]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c);
const number = (x, digits = 6) => (x == null || !Number.isFinite(x) ? "" : Number(x.toPrecision(digits)));

/**
 * Concentrations with the tissue correction, one row per metabolite: LCModel's
 * values, the corrected ones, and every input that produced them.
 */
export function correctedCsv(result, ratioTo) {
  const c = result.constants;
  const alpha = result.rows.some((r) => r.alphaCorrected != null);
  const header = [
    "Metabolite",
    "LCModel (mM)",
    "SD (%)",
    ratioTo ? `/${ratioTo}` : "Ratio",
    "Tissue-corrected (mmol/kg)",
    ...(alpha ? ["Alpha-corrected (mmol/kg)"] : []),
    "fGM",
    "fWM",
    "fCSF",
    "Metabolite T1 (ms)",
    "Metabolite T2 (ms)",
    "Metabolite relaxation corrected",
    "TE (ms)",
    "TR (ms)",
    "Water TE (ms)",
    "Water TR (ms)",
    "WCONC (mM)",
    "ATTH2O",
    "Method",
  ];
  const lines = result.rows.map((r) => [
    r.name,
    r.concentration,
    r.sdPercent ?? "",
    r.ratio ?? "",
    number(r.corrected),
    ...(alpha ? [number(r.alphaCorrected)] : []),
    number(result.fractions.gm, 4),
    number(result.fractions.wm, 4),
    number(result.fractions.csf, 4),
    Math.round(r.t1 * 1000),
    Math.round(r.t2 * 1000),
    c.metaboliteRelaxation ? "yes" : "no",
    c.metabolite.teMs,
    c.metabolite.trMs,
    c.water.teMs,
    c.water.trMs,
    c.lcmodel.wconc,
    c.lcmodel.atth2o,
    c.method,
  ]);
  return [header, ...lines].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

/**
 * The tissue correction of one fit, or why it does not apply.
 * @param rows LCModel's rows (presentRows)
 * @param {{
 *   fractions: {gm: number, wm: number, csf: number}|null,
 *   header: {fieldT: number, teMs: number, trMs: number, waterTeMs?: number, waterTrMs?: number}|null,
 *   waterScaled: boolean, edited: boolean, metaboliteRelaxation: boolean,
 * }} options  `header` is the spectroscopy dataset's (null for a .RAW file).
 * @returns null without fractions, `{reason}` when it does not apply, else correctConcentrations' result
 */
export function correctionFor(rows, { fractions, header, waterScaled, edited, metaboliteRelaxation }) {
  if (!fractions) return null;
  if (!waterScaled) return { reason: "Tissue correction needs water-scaled concentrations (a water reference)." };
  if (!header) return { reason: "Tissue correction needs the acquisition header (not a .RAW file)." };
  if (!fieldKey(header.fieldT)) return { reason: `Relaxation constants are tabulated for 3 T and 7 T, not ${Number(header.fieldT).toFixed(2)} T.` };
  try {
    return correctConcentrations(rows, {
      fractions,
      fieldT: header.fieldT,
      metabolite: { teMs: header.teMs, trMs: header.trMs },
      water: { teMs: header.waterTeMs ?? header.teMs, trMs: header.waterTrMs ?? header.trMs },
      metaboliteRelaxation,
      alpha: edited,
    });
  } catch (error) {
    return { reason: error.message };
  }
}

/**
 * The tissue correction's downloads: the corrected table and every input
 * behind it. `fractionSource` is "entered" or a description of the segmentation.
 */
export function tissueTexts(result, stem, ratioTo, { fractionSource = "entered", voxel = null, voxelInT1Mm3 = null } = {}) {
  const report = {
    fractions: result.fractions,
    molalFractions: result.molalFractions,
    fractionSource,
    voxel,
    voxelInT1Mm3,
    waterAttenuation: result.waterAttenuation,
    ...result.constants,
    concentrations: result.rows.map((r) => ({ name: r.name, lcmodel: r.concentration, corrected: r.corrected, alphaCorrected: r.alphaCorrected ?? null, t1Ms: r.t1 * 1000, t2Ms: r.t2 * 1000 })),
  };
  return {
    tissueConcentrations: { description: "Tissue-corrected concentrations (.csv)", name: `${stem}_tissue_corrected.csv`, type: "text/csv", body: correctedCsv(result, ratioTo), viewable: false },
    tissueReport: { description: "Tissue correction inputs (.json)", name: `${stem}_tissue_correction.json`, type: "application/json", body: JSON.stringify(report, null, 2), viewable: false },
  };
}
