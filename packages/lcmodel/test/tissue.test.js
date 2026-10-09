import test from "node:test";
import assert from "node:assert/strict";
import { correctConcentrations, correctedCsv, metaboliteRelaxation, normalizeFractions, fieldKey } from "../src/tissue.js";

// Osprey's own quantTiss and quantAlpha (OspreyQuantify.m at 98b2e354,
// extracted verbatim) run in GNU Octave 8 on these inputs, LCModel output
// entering as Osprey reads it: amplMets = concentration, amplWater =
// WCONC * ATTMET / ATTH2O = 35880 / 0.7.
const NAMES = ["NAA", "Cr", "GPC", "mI", "Glu", "GABA", "Gln", "Glx", "tNAA", "Lac", "Unknown", "GABAplus"];
const CONC = [10.5, 8.2, 1.9, 6.3, 9.1, 1.2, 3.3, 12.4, 12.0, 0.4, 1.0, 1.5];
const FRACTIONS = { gm: 0.6, wm: 0.27, csf: 0.13 };
const OSPREY = {
  "3T TR 2000 TE 35": [10.8781998894, 9.28201685121, 1.89627117475, 6.30854885747, 10.4127103596, 1.59115641724, 3.7335645983, 14.0997762462, 12.6215878899, 0.459075030654, 1.10365972799, 1.65548959198],
  "3T TR 3000/10000 TE 68/30": [14.7504242303, 14.0343995575, 2.72991513499, 9.39895158016, 16.8283491749, 2.84118508222, 5.85335496311, 22.429602041, 17.9025457935, 0.729497371355, 1.69027567186, 2.53541350779],
  "7T TR 2000 TE 35": [8.49231870315, 7.23941480588, 1.36424826839, 4.6539571989, 7.72515981276, 0.9985120404, 2.85144795723, 10.6183827198, 8.66008451753, 0.285193845521, 0.774069724043, 1.16110458606],
};
const rows = NAMES.map((name, k) => ({ name, concentration: CONC[k] }));

function closeTo(actual, expected, label) {
  assert.ok(Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs Osprey ${expected}`);
}

test("Gasparovic correction reproduces Osprey's quantTiss", () => {
  const cases = [
    ["3T TR 2000 TE 35", 3, { teMs: 35, trMs: 2000 }, { teMs: 35, trMs: 2000 }],
    ["3T TR 3000/10000 TE 68/30", 3, { teMs: 68, trMs: 3000 }, { teMs: 30, trMs: 10000 }],
    ["7T TR 2000 TE 35", 7, { teMs: 35, trMs: 2000 }, { teMs: 35, trMs: 2000 }],
  ];
  for (const [label, fieldT, metabolite, water] of cases) {
    const result = correctConcentrations(rows, { fractions: FRACTIONS, fieldT, metabolite, water });
    result.rows.forEach((r, k) => closeTo(r.corrected, OSPREY[label][k], `${label} ${r.name}`));
  }
});

test("alpha correction reproduces Osprey's quantAlpha for GABA and Glx", () => {
  // quantAlpha at 3 T, TR 2000 ms, TE 68 ms: GABA, Glu, Gln, Glx.
  const expected = { GABA: 1.50337793145, Glu: 8.8002969464, Gln: 3.07935263674, Glx: 11.7648775617 };
  const result = correctConcentrations(rows, { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 68, trMs: 2000 }, water: { teMs: 68, trMs: 2000 }, alpha: true });
  for (const [name, value] of Object.entries(expected)) closeTo(result.rows.find((r) => r.name === name).alphaCorrected, value, name);
  assert.equal(result.rows.find((r) => r.name === "NAA").alphaCorrected, undefined);
  // GABA+ under the co-edited MM model is alpha-corrected like Osprey's GABAplus.
  const plus = correctConcentrations([{ name: "GABA+MM3co", concentration: 2 }, { name: "GABAplus", concentration: 2 }], { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 68, trMs: 2000 }, water: { teMs: 68, trMs: 2000 }, alpha: true });
  assert.equal(plus.rows[0].alphaCorrected, plus.rows[1].alphaCorrected);
  assert.ok(plus.rows[0].alphaCorrected > 0);
});

test("LCModel's names map to Osprey's relaxation table", () => {
  assert.deepEqual(metaboliteRelaxation("Ins", 3), metaboliteRelaxation("mI", 3));
  assert.deepEqual(metaboliteRelaxation("NAA+NAAG", 3), metaboliteRelaxation("tNAA", 3));
  assert.deepEqual(metaboliteRelaxation("Cr+PCr", 7), metaboliteRelaxation("tCr", 7));
  assert.equal(metaboliteRelaxation("Scyllo", 7).t2, 0.105);
  assert.equal(metaboliteRelaxation("MM20", 3).known, false);
  // NAA at 3 T: T1 (1470 + 1350) / 2 ms, T2 ((253 + 263) / 2 + 343) / 2 ms.
  assert.equal(metaboliteRelaxation("NAA", 3).t1, 1.41);
  assert.equal(metaboliteRelaxation("NAA", 3).t2, 0.3005);
});

test("without metabolite relaxation the correction is the water term alone", () => {
  const base = { fractions: FRACTIONS, fieldT: 3, metabolite: { teMs: 35, trMs: 2000 }, water: { teMs: 35, trMs: 2000 } };
  const on = correctConcentrations(rows, base).rows[0];
  const off = correctConcentrations(rows, { ...base, metaboliteRelaxation: false }).rows[0];
  const rm = (1 - Math.exp(-2 / on.t1)) * Math.exp(-0.035 / on.t2);
  closeTo(off.corrected, on.corrected * rm, "NAA");
});

test("pure white matter with no relaxation leaves LCModel's water scaling (bar its water content)", () => {
  // fWM = 1: c = ratio * 55510 * Rw_WM / (R_M = 1); LCModel used 35880 * 0.7.
  const r = correctConcentrations([{ name: "NAA", concentration: 10 }], {
    fractions: { gm: 0, wm: 1, csf: 0 },
    fieldT: 3,
    metabolite: { teMs: 35, trMs: 2000 },
    water: { teMs: 35, trMs: 2000 },
    metaboliteRelaxation: false,
  }).rows[0];
  const rw = (1 - Math.exp(-2 / 0.832)) * Math.exp(-0.035 / 0.0792);
  closeTo(r.corrected, (10 * 0.7) / 35880 * 55510 * rw, "NAA");
});

test("fractions are normalised and checked", () => {
  assert.deepEqual(normalizeFractions({ gm: 2, wm: 1, csf: 1 }), { gm: 0.5, wm: 0.25, csf: 0.25 });
  assert.throws(() => normalizeFractions({ gm: 0, wm: 0, csf: 1 }), /pure CSF/);
  assert.throws(() => normalizeFractions({ gm: -1, wm: 1, csf: 0 }), /0 to 1/);
  assert.equal(fieldKey(2.89), 3);
  assert.equal(fieldKey(1.5), null);
  assert.throws(() => correctConcentrations(rows, { fractions: FRACTIONS, fieldT: 1.5, metabolite: { teMs: 30, trMs: 2000 }, water: { teMs: 30, trMs: 2000 } }), /3 T and 7 T/);
});

test("the CSV holds both values, the fractions and the constants", () => {
  const result = correctConcentrations([{ name: "NAA+NAAG", concentration: 12, sdPercent: 3, ratio: 1.4 }], {
    fractions: FRACTIONS,
    fieldT: 3,
    metabolite: { teMs: 35, trMs: 2000 },
    water: { teMs: 35, trMs: 2000 },
  });
  const [header, line] = correctedCsv(result, "Cr+PCr").trim().split("\n");
  assert.match(header, /^Metabolite,LCModel \(mM\),SD \(%\),\/Cr\+PCr,Tissue-corrected \(mmol\/kg\),fGM,fWM,fCSF,/);
  const cells = line.split(",");
  assert.equal(cells[0], "NAA+NAAG");
  assert.equal(cells[1], "12");
  assert.equal(cells[4], "12.6216");
  assert.deepEqual(cells.slice(5, 8), ["0.6", "0.27", "0.13"]);
  assert.ok(header.includes("WCONC (mM)") && line.includes("35880"));
});
