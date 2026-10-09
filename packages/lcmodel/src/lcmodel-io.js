// LCModel's own files: the control file (NAMELIST /LCMODL/) the app writes,
// and the .COORD and .TABLE files LCModel writes back. Pure, Node-tested.
import { rawValues } from "./inputs.js";

// Names the fit reads its inputs from; the worker supplies files under these.
export const FILES = Object.freeze({
  raw: "spectrum.raw",
  h2o: "water.h2o",
  basis: "basis.basis",
  table: "result.table",
  coord: "result.coord",
  csv: "result.csv",
});

const quote = (text) => `'${String(text).replace(/'/g, "''")}'`;

function number(value) {
  if (!Number.isFinite(value)) throw new Error(`LCModel needs a finite number, got ${value}`);
  return String(value);
}

// LCModel's line-broadening prior. The library's FID-A basis sets have
// 1.5 Hz Lorentzian lines, narrower than in vivo, so the fit has to broaden
// them a lot. With LCModel's defaults it scales 8-15 % low: DESDT2 = 0.4
// keeps the extra Lorentzian broadening from following the line tails, and
// RFWBAS = 10 integrates the reference singlet (Cr, or NAA for MEGA-PRESS)
// over +-5 basis linewidths only, 92 % of a narrow Lorentzian's area.
// Synthetic spectra made from the basis are recovered exactly with DESDT2 = 2
// and RFWBAS = 80 (packages/lcmodel/test/water-scaling.test.js), and on real
// PRESS data that brings LCModel to within about 5 % of spant's ABfit with the
// same basis (PR #120). "widened" is the app's default; "lcmodel" leaves
// LCModel's own values, as LCModel's test case and other studies use them.
export const LINE_BROADENING = Object.freeze({
  widened: Object.freeze({ label: "Widened", namelist: Object.freeze([" desdt2=2", " rfwbas=80"]) }),
  lcmodel: Object.freeze({ label: "LCModel defaults", namelist: Object.freeze([]) }),
});

// Co-edited macromolecules in a GABA-edited difference spectrum, after
// Zöllner et al. (NMR Biomed 2022;35:e4618), "MM09soft": the 3.0 ppm MM
// signal that the 1.9 ppm editing pulse co-edits with GABA (MM3co, a 14 Hz,
// 2-proton Gaussian) and the non-overlapped co-edited MM at 0.915 ppm
// (MM09, 3 protons) are separate simulated components (CHSIMU), tied by a
// soft constraint on their ratio (CHRATO). A 3:2 area ratio, the composite
// model of Osprey's LCModel wrapper, is a concentration ratio of 1; the SD
// of 0.2 is the spread Zöllner et al. measured. GABA+ is GABA + MM3co
// (CHCOMB). The split rests on these priors; GABA+ does not. LCModel's
// mega-press-3 preset already sets 17 combinations and the NAAG/NAA ratio,
// so these entries follow them.
function coEditedMacromolecules(hzpppm) {
  const ppm = (hz) => (hz / hzpppm).toFixed(3);
  return [
    " nsimul=2",
    " chsimu(1)='MM09 @ .915 +- .02 FWHM= .085 < .1 +- .35 AMP= 3.'",
    ` chsimu(2)='MM3co @ 3.0 +- .02 FWHM= ${ppm(10.5)} < ${ppm(14)} +- .02 AMP= 2.'`,
    " nratio=2",
    " chrato(2)='MM3co/MM09 = 1. +- .2'",
    " ncombi=18",
    " chcomb(18)='GABA+MM3co'",
    // 1.2-1.95 ppm is left out of the fit, as in Osprey's MEGA-PRESS LCModel
    // jobs (GAP.diff1): the editing pulse hits the macromolecules there
    // directly, and no basis spectrum, MM component or baseline (the
    // mega-press-3 preset has none) models them.
    " ppmgap(1,1)=1.95",
    " ppmgap(2,1)=1.2",
  ];
}

/**
 * The control file for one fit.
 * @param {{
 *   nunfil: number, deltat: number, hzpppm: number, teMs?: number,
 *   water?: boolean, ecc?: boolean, ppmStart?: number, ppmEnd?: number,
 *   title?: string, sptype?: string, coEditedMM?: boolean,
 *   lineBroadening?: keyof typeof LINE_BROADENING,
 * }} options  `water` scales to the unsuppressed water reference (and
 *   enables eddy-current correction unless `ecc` is false). `sptype`
 *   selects one of LCModel's special analyses: "mega-press-3" fits a
 *   MEGA-PRESS difference spectrum (no baseline, NAA as the reference).
 *   `coEditedMM` adds the co-edited macromolecule model to a MEGA-PRESS
 *   fit, separating GABA from MM3co; leave it off for MM-suppressed
 *   editing, whose difference spectrum has no co-edited MM.
 *   `lineBroadening` picks the prior on line broadening (LINE_BROADENING).
 */
export function buildControl(options) {
  const {
    nunfil,
    deltat,
    hzpppm,
    teMs,
    water = false,
    ecc = water,
    ppmStart = 4.0,
    ppmEnd = 0.2,
    title = "",
    sptype = "",
    coEditedMM = false,
    lineBroadening = "widened",
  } = options;
  const broadening = LINE_BROADENING[lineBroadening];
  if (!broadening) throw new Error(`Unknown line-broadening prior ${lineBroadening}`);
  if (!(nunfil >= 64)) throw new Error("The spectrum needs at least 64 points.");
  if (!(ppmStart > ppmEnd)) throw new Error("The fit range must run from a higher to a lower ppm.");
  const lines = [
    " $LCMODL",
    // LCModel 6.3's licence key, required by the released source.
    " key=210387309",
    " lps=0",
  ];
  if (sptype) lines.push(` sptype=${quote(sptype)}`);
  lines.push(
    ` nunfil=${number(nunfil)}`,
    ` deltat=${number(deltat)}`,
    ` hzpppm=${number(hzpppm)}`,
    ` filbas=${quote(FILES.basis)}`,
    ` filraw=${quote(FILES.raw)}`,
    ` ppmst=${number(ppmStart)}`,
    ` ppmend=${number(ppmEnd)}`,
    ` lcoord=9`,
    ` filcoo=${quote(FILES.coord)}`,
    ` ltable=7`,
    ` filtab=${quote(FILES.table)}`,
    ` lcsv=11`,
    ` filcsv=${quote(FILES.csv)}`,
    // Individual metabolite curves in the .COORD file.
    " neach=99",
  );
  if (coEditedMM) {
    if (!sptype.startsWith("mega-press")) throw new Error("The co-edited macromolecule model is for MEGA-PRESS difference spectra.");
    lines.push(...coEditedMacromolecules(hzpppm));
  }
  lines.push(...broadening.namelist);
  if (Number.isFinite(teMs) && teMs > 0) lines.push(` echot=${number(teMs)}`);
  if (water) {
    lines.push(` filh2o=${quote(FILES.h2o)}`, " dows=T");
    lines.push(` doecc=${ecc ? "T" : "F"}`);
  }
  if (title) lines.push(` title=${quote(title.slice(0, 120))}`);
  lines.push(" $END", "");
  return lines.join("\n");
}

function numbersAfter(lines, start, count) {
  const values = [];
  for (let k = start; k < lines.length && values.length < count; k += 1) {
    for (const token of lines[k].trim().split(/\s+/)) {
      if (token === "") continue;
      const value = Number(token);
      if (!Number.isFinite(value)) return values;
      values.push(value);
    }
  }
  return values;
}

/** One row of LCModel's concentration table. */
function parseConcentrationRow(line) {
  const m = line.match(/^\s*(\S+)\s+(\d+)%\s+(\S+)\s+(.+?)\s*$/);
  if (!m) return null;
  const concentration = Number(m[1]);
  const ratio = Number(m[3]);
  if (!Number.isFinite(concentration)) return null;
  return {
    name: m[4],
    concentration,
    sdPercent: Number(m[2]),
    ratio: Number.isFinite(ratio) ? ratio : null,
    combination: m[4].includes("+"),
  };
}

function parseConcentrations(lines, start, count) {
  const header = lines[start] ?? "";
  const ratioTo = (header.match(/\/(\S+)/) ?? [])[1] ?? null;
  const rows = [];
  for (let k = start + 1; k < start + count && k < lines.length; k += 1) {
    const row = parseConcentrationRow(lines[k]);
    if (row) rows.push(row);
  }
  // The column header is cut to seven characters ("/NAA+NA"); name it in full.
  const full = ratioTo && rows.find((r) => r.name.startsWith(ratioTo))?.name;
  return { ratioTo: full ?? ratioTo, rows };
}

/**
 * The .COORD file: concentrations, the misc table (FWHM, S/N, shift, phase),
 * the ppm axis, data, fit, background and each metabolite's curve.
 */
export function parseCoord(text) {
  const lines = text.split(/\r?\n/);
  const result = { ratioTo: null, rows: [], misc: [], ppm: [], data: [], fit: [], background: [], metabolites: [], diagnostics: [] };
  for (let k = 0; k < lines.length; k += 1) {
    const line = lines[k];
    let m;
    if ((m = line.match(/^\s*(\d+) lines in following concentration table/))) {
      const table = parseConcentrations(lines, k + 1, Number(m[1]));
      result.ratioTo = table.ratioTo;
      result.rows = table.rows;
    } else if ((m = line.match(/^\s*(\d+) lines in following misc\. output table/))) {
      result.misc = lines.slice(k + 1, k + 1 + Number(m[1])).map((l) => l.trim());
    } else if ((m = line.match(/^\s*(\d+) lines in following diagnostic table/))) {
      result.diagnostics = lines.slice(k + 1, k + 1 + Number(m[1])).map((l) => l.trim()).filter(Boolean);
    } else if ((m = line.match(/^\s*(\d+) points on ppm-axis = NY/))) {
      result.ppm = numbersAfter(lines, k + 1, Number(m[1]));
    } else if (/NY phased data points follow/.test(line)) {
      result.data = numbersAfter(lines, k + 1, result.ppm.length);
    } else if (/NY points of the fit to the data follow/.test(line)) {
      result.fit = numbersAfter(lines, k + 1, result.ppm.length);
    } else if (/NY background values follow/.test(line)) {
      result.background = numbersAfter(lines, k + 1, result.ppm.length);
    } else if ((m = line.match(/^\s*(\S+)\s+Conc\. =\s*(\S+)/))) {
      result.metabolites.push({ name: m[1], concentration: Number(m[2]), curve: numbersAfter(lines, k + 1, result.ppm.length) });
    }
  }
  result.summary = summarizeMisc(result.misc);
  result.gaps = coordGaps(result.ppm);
  return result;
}

/**
 * Windows LCModel left out of the fit (PPMGAP). The .COORD file has no
 * points there, so its ppm axis jumps across each one.
 * @returns {{hi: number, lo: number}[]}  the last point before and the first after
 */
export function coordGaps(ppm) {
  const steps = [];
  for (let k = 1; k < ppm.length; k += 1) steps.push(Math.abs(ppm[k] - ppm[k - 1]));
  const typical = [...steps].sort((a, b) => a - b)[Math.floor(steps.length / 2)] ?? 0;
  const gaps = [];
  steps.forEach((step, k) => {
    if (step > 5 * typical) gaps.push({ hi: ppm[k], lo: ppm[k + 1] });
  });
  return gaps;
}

// LCModel's ppm axis is centred on PPMCEN, which the app leaves at its default.
const PPM_CENTRE = 4.65;

/**
 * `coord.gaps` with the data inside each window, so the plot can show what
 * the fit left out. LCModel writes nothing there; the spectrum is rebuilt
 * from the .RAW file it fitted, on the .COORD grid (twice zero-filled).
 * LCModel's referencing shift and first-order phase come from its summary.
 * Its data scaling and its zero-order phase (printed to the nearest degree)
 * are fitted to the .COORD data by least squares. If the rebuilt spectrum
 * misses that data by more than `tolerance` (relative RMS), the windows
 * stay empty rather than show a trace that does not line up.
 * @param {{deltat: number, hzpppm: number}} acquisition
 * @returns {{hi: number, lo: number, ppm?: number[], data?: number[]}[]}
 */
export function fillGaps(coord, raw, { deltat, hzpppm }, { tolerance = 0.1 } = {}) {
  const gaps = coord.gaps ?? [];
  if (!gaps.length) return gaps;
  const values = rawValues(raw);
  const n = values.length >> 1;
  if (!n || !(deltat > 0) || !(hzpppm > 0)) return gaps;
  const shift = coord.summary?.shiftPpm ?? 0;
  const degPerPpm = coord.summary?.phase1DegPerPpm ?? 0;
  // The spectrum at `ppm`, with LCModel's first-order phase applied.
  const spectrum = (ppm) => {
    const hz = (PPM_CENTRE - ppm + shift) * hzpppm;
    const wr = Math.cos(-2 * Math.PI * hz * deltat);
    const wi = Math.sin(-2 * Math.PI * hz * deltat);
    let zr = 1;
    let zi = 0;
    let sr = 0;
    let si = 0;
    for (let k = 0; k < n; k += 1) {
      const re = values[2 * k];
      const im = values[2 * k + 1];
      sr += re * zr - im * zi;
      si += re * zi + im * zr;
      [zr, zi] = [zr * wr - zi * wi, zr * wi + zi * wr];
    }
    const phase = (degPerPpm * ppm * Math.PI) / 180;
    return [sr * Math.cos(phase) - si * Math.sin(phase), sr * Math.sin(phase) + si * Math.cos(phase)];
  };
  // data ≈ a·Re(S) − b·Im(S): the complex factor a + ib, by least squares.
  let uu = 0;
  let uv = 0;
  let vv = 0;
  let ud = 0;
  let vd = 0;
  const rebuilt = coord.ppm.map((p, k) => {
    const [u, v] = spectrum(p);
    const d = coord.data[k];
    uu += u * u;
    uv += u * v;
    vv += v * v;
    ud += u * d;
    vd += v * d;
    return [u, v];
  });
  const det = uu * vv - uv * uv;
  if (!(Math.abs(det) > 0)) return gaps;
  const a = (ud * vv - vd * uv) / det;
  const b = (ud * uv - vd * uu) / det;
  const real = ([u, v]) => a * u - b * v;
  let miss = 0;
  let total = 0;
  rebuilt.forEach((s, k) => {
    miss += (real(s) - coord.data[k]) ** 2;
    total += coord.data[k] ** 2;
  });
  if (!(Math.sqrt(miss / total) <= tolerance)) return gaps;
  const step = Math.abs(coord.ppm[1] - coord.ppm[0]);
  return gaps.map(({ hi, lo }) => {
    const ppm = [];
    for (let p = hi - step; p > lo + step / 2; p -= step) ppm.push(p);
    return { hi, lo, ppm, data: ppm.map((p) => real(spectrum(p))) };
  });
}

/** FWHM, S/N, data shift and phases from LCModel's misc table. */
export function summarizeMisc(misc) {
  const text = misc.join("\n");
  const get = (re) => {
    const m = text.match(re);
    return m ? Number(m[1]) : null;
  };
  return {
    fwhmPpm: get(/FWHM\s*=\s*([-\d.]+)\s*ppm/),
    snr: get(/S\/N\s*=\s*([-\d.]+)/),
    shiftPpm: get(/Data shift\s*=\s*([-\d.]+)/),
    phase0Deg: get(/Ph:\s*([-\d.]+)\s*deg/),
    phase1DegPerPpm: get(/deg\s+([-\d.]+)\s*deg\/ppm/),
  };
}

/** The concentration section of a .TABLE file. */
export function parseTable(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^\$\$CONC/.test(l));
  if (start < 0) return { ratioTo: null, rows: [] };
  const count = Number((lines[start].match(/\$\$CONC\s*(\d+)/) ?? [])[1] ?? 0);
  return parseConcentrations(lines, start + 1, count);
}

/** The metabolite table as CSV (the app's own download). */
export function concentrationsCsv(rows, ratioTo) {
  const notes = rows.some((r) => r.note);
  const header = ["Metabolite", "Concentration", "SD (%)", ratioTo ? `/${ratioTo}` : "Ratio", ...(notes ? ["Note"] : [])];
  const cells = rows.map((r) => [r.name, r.concentration, r.sdPercent, r.ratio ?? "", ...(notes ? [r.note ?? ""] : [])]);
  return [header, ...cells].map((row) => row.map((c) => (/[",]/.test(String(c)) ? `"${String(c).replace(/"/g, '""')}"` : c)).join(",")).join("\n") + "\n";
}

/** LCModel's stop code ("FATAL ERROR MYBASI 3") as a message, naming the common ones. */
export function lcmodelError(code, outputs) {
  const hints = {
    "MYBASI 9": "The basis set was simulated for a different field strength.",
    "MYBASI 2": "The basis set's bandwidth is too narrow for these data.",
    "MYDATA 1": "The spectrum file could not be read.",
    "INITIA 4": "The fit range lies outside the spectrum.",
  };
  const key = Object.keys(hints).find((k) => code.includes(k));
  const detail = key ? ` ${hints[key]}` : "";
  const diag = Object.entries(outputs ?? {}).find(([name]) => name.endsWith(".table"))?.[1]?.split("$$DIAG")[1]?.split("$$")[0]?.trim();
  return `LCModel stopped (${code}).${detail}${diag ? ` Diagnostics: ${diag.replace(/\s+/g, " ")}` : ""}`;
}

const GABA_PLUS = "GABA+MM3co";
export const MODEL_NOTES = Object.freeze({
  [GABA_PLUS]: "GABA+ (GABA + MM3co): primary result",
  GABA: "model-dependent: split from MM3co by the macromolecule model",
  MM3co: "model-dependent: co-edited macromolecules under GABA at 3.0 ppm",
});

/**
 * Rows in the order to show them. A fit with the co-edited macromolecule
 * model leads with GABA+, then GABA and MM3co, which carry a note because
 * they rest on the model's assumptions; the rest keep LCModel's order.
 */
export function presentRows(rows) {
  const plus = rows.find((r) => r.name === GABA_PLUS);
  if (!plus) return rows;
  const lead = [GABA_PLUS, "GABA", "MM3co"].map((name) => rows.find((r) => r.name === name)).filter(Boolean);
  const rest = rows.filter((r) => !lead.includes(r));
  return [...lead.map((r) => ({ ...r, note: MODEL_NOTES[r.name], primary: r.name === GABA_PLUS, modelDependent: r.name !== GABA_PLUS })), ...rest];
}
