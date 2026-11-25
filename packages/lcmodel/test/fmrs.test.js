import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  analyzeFmrsWindows,
  buildFmrsBins,
  buildFmrsReport,
  classifyWindowQc,
  conditionForInterval,
  fitDynamicSpectralGlm,
  fmrsStatsCsv,
  fmrsTimeCourseCsvLong,
  fmrsTimeCourseCsvWide,
  fmrsTransientsCsv,
  parseEventsText,
  studentTwoTailedP,
} from "../src/fmrs.js";
import { qcTimeCourseSvg, timeCourseSvg, transientDriftSvg } from "../src/fmrs-plot.js";
import { buildControl, FILES } from "../src/lcmodel-io.js";
import { hasBasisMacromolecules, parseBasisHeader } from "../src/basis-select.js";
import { fitFmrsDataset, fidaInput, fmrsResultTexts, reportVersions, resultTexts, settingsFrom } from "../src/pipeline.js";
import { basisLibrary } from "../src/library.js";
import { loadLcmodel } from "../src/wasm.js";

const manifest = JSON.parse(await readFile(new URL("../model.manifest.json", import.meta.url), "utf8"));
const library = basisLibrary(manifest);
const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);
const nativeTable = await readFile(new URL("native.table", native), "utf8");
const nativeCoord = await readFile(new URL("native.coord", native), "utf8");

// Capsaicin inhalation paradigm (matching brainstorming_stimulus_presentation_30Sep2026.xlsx):
// 6 cycles of 32 s pre-inhale + 32 s CAP inhale (= 384 s), then 256 s Complete rest (= 640 s, 80 averages @ TR=8 s).
const CAPSAICIN_TSV = [
  "onset\tduration\ttrial_type",
  "0\t32\tPre_inhale",
  "32\t32\tCAP_inhale",
  "64\t32\tPre_inhale",
  "96\t32\tCAP_inhale",
  "128\t32\tPre_inhale",
  "160\t32\tCAP_inhale",
  "192\t32\tPre_inhale",
  "224\t32\tCAP_inhale",
  "256\t32\tPre_inhale",
  "288\t32\tCAP_inhale",
  "320\t32\tPre_inhale",
  "352\t32\tCAP_inhale",
  "384\t256\tComplete_rest",
].join("\n");

test("parseEventsText reads BIDS TSV/CSV (including negative onsets and zero-duration impulses) and rejects blank/malformed cells", () => {
  const events = parseEventsText(CAPSAICIN_TSV);
  assert.equal(events.length, 13);
  assert.deepEqual(events[0], { onset: 0, duration: 32, condition: "Pre_inhale" });
  assert.deepEqual(events[12], { onset: 384, duration: 256, condition: "Complete_rest" });

  const csv = parseEventsText("onset,duration,condition\n-4,64,Rest\n64,0,\"Pain, flash\"\n");
  assert.equal(csv.length, 2);
  assert.deepEqual(csv[0], { onset: -4, duration: 64, condition: "Rest" });
  assert.deepEqual(csv[1], { onset: 64, duration: 0, condition: "Pain, flash" });

  // Implicit rest competes against brief overlap; zero-duration impulse matches containing interval.
  assert.equal(conditionForInterval([{ onset: 31, duration: 2, condition: "Stim" }], 0, 32, "Rest"), "Rest");
  assert.equal(conditionForInterval([{ onset: 10, duration: 0, condition: "Flash" }], 8, 16, "Rest"), "Flash");

  assert.throws(() => parseEventsText("onset\tduration\n0\t10\n"), /trial_type/);
  assert.throws(() => parseEventsText("onset\tduration\ttrial_type\n\t10\tRest\n"), /onset/);
  assert.throws(() => parseEventsText("onset\tduration\ttrial_type\n0\t\tRest\n"), /duration/);
  assert.throws(() => parseEventsText("onset\tduration\ttrial_type\n0\t-1\tRest\n"), /non-negative/);
});

test("buildFmrsBins creates sliding windows, event blocks, and condition-pooled bins", () => {
  const events = parseEventsText(CAPSAICIN_TSV);

  // 80 averages @ TR=8 s, 4-avg non-overlapping windows -> 20 windows (matching qc_report.html)
  const sliding = buildFmrsBins({ mode: "sliding", averages: 80, trS: 8, windowSize: 4, stepSize: 4, events });
  assert.equal(sliding.length, 20);
  assert.equal(sliding[0].condition, "Pre_inhale");
  assert.equal(sliding[1].condition, "CAP_inhale");
  assert.equal(sliding[12].condition, "Complete_rest");
  assert.deepEqual(sliding[1].indices, [4, 5, 6, 7]);

  // Sliding step = 2 -> overlapping windows
  const overlap = buildFmrsBins({ mode: "sliding", averages: 12, trS: 8, windowSize: 4, stepSize: 2 });
  assert.equal(overlap.length, 5);
  assert.deepEqual(overlap[1].indices, [2, 3, 4, 5]);

  // Event blocks -> 13 contiguous blocks
  const blocks = buildFmrsBins({ mode: "blocks", averages: 80, trS: 8, events });
  assert.equal(blocks.length, 13);
  assert.equal(blocks[12].indices.length, 32);

  // Condition pooling -> 3 high-SNR pooled spectra (24 Pre_inhale, 24 CAP_inhale, 32 Complete_rest)
  const pooled = buildFmrsBins({ mode: "conditions", averages: 80, trS: 8, events });
  assert.equal(pooled.length, 3);
  assert.equal(pooled.find((b) => b.condition === "Pre_inhale").indices.length, 24);
  assert.equal(pooled.find((b) => b.condition === "CAP_inhale").indices.length, 24);
  assert.equal(pooled.find((b) => b.condition === "Complete_rest").indices.length, 32);

  assert.throws(() => buildFmrsBins({ mode: "conditions", averages: 80, trS: 8, events: [] }), /events file/);
});

test("classifyWindowQc flags FWHM, S/N, shift, phase, and linewidth outliers and summarizes by condition", () => {
  const windows = [
    { label: "W1", condition: "Rest", status: "fitted", fwhmPpm: 0.04, lcmSnr: 25, shiftPpm: 0.01, phase0Deg: 5, phase1DegPerPpm: 2, metabolites: [{ name: "NAA+NAAG", concentration: 12 }, { name: "Cr+PCr", concentration: 8 }] },
    { label: "W2", condition: "Cap", status: "fitted", fwhmPpm: 0.08, lcmSnr: 14, shiftPpm: 0.02, phase0Deg: -45, phase1DegPerPpm: -12, metabolites: [{ name: "NAA+NAAG", concentration: 11 }, { name: "Cr+PCr", concentration: 8 }] },
    { label: "W3", condition: "Cap", status: "fitted", fwhmPpm: 0.11, lcmSnr: 8, shiftPpm: 0.12, phase0Deg: 0, phase1DegPerPpm: 0, metabolites: [{ name: "NAA+NAAG", concentration: 10 }, { name: "Cr+PCr", concentration: 8 }] },
  ];
  const qc = classifyWindowQc(windows, { hzpppm: 297.2 });
  assert.equal(qc.baselineCondition, "Rest");
  assert.equal(qc.windows[0].qc.status, "PASS");
  assert.equal(qc.windows[1].qc.status, "WARN");
  assert.equal(qc.windows[2].qc.status, "FAIL");
  assert.ok(qc.windows[2].qc.reasons.some((r) => /FWHM/.test(r)));
  assert.ok(qc.windows[2].qc.reasons.some((r) => /S\/N/.test(r)));
  const capSummary = qc.conditionSummary.find((c) => c.condition === "Cap");
  assert.equal(capSummary.n, 2);
  assert.equal(capSummary.warn, 1);
  assert.equal(capSummary.fail, 1);
  assert.ok(capSummary.deltaLwVsRefHz > 10);
});

test("studentTwoTailedP matches reference critical values", () => {
  // t(df=10) = 2.2281 -> p = 0.05
  assert.ok(Math.abs(studentTwoTailedP(2.22813885, 10) - 0.05) < 1e-4);
  // t(df=30) = 2.7500 -> p = 0.01
  assert.ok(Math.abs(studentTwoTailedP(2.74999565, 30) - 0.01) < 1e-4);
  assert.equal(studentTwoTailedP(0, 15), 1);
});

test("analyzeFmrsWindows recovers stimulus effect while controlling for linear drift and linewidth", () => {
  // True model: Glu = 10.0 + 0.8 * I(Stim) + 0.002 * t + 0.05 * (LW - 12)
  const windows = [];
  for (let i = 0; i < 20; i += 1) {
    const stim = i % 2 === 1;
    const t = i * 32 + 16;
    const lw = 12 + (i % 3) - 1; // varies independently of stim
    const noise = ((i * 7) % 5 - 2) * 0.01;
    const glu = 10.0 + (stim ? 0.8 : 0.0) + 0.002 * t + 0.05 * (lw - 12) + noise;
    windows.push({
      label: `W${i + 1}`,
      condition: stim ? "Stim" : "Rest",
      midTimeS: t,
      status: "fitted",
      lwHz: lw,
      metabolites: [{ name: "Glu", concentration: glu, sdPercent: 4, ratio: glu / 8 }],
    });
  }
  const stats = analyzeFmrsWindows(windows, { baselineCondition: "Rest" });
  assert.equal(stats.baseline, "Rest");
  const glu = stats.metabolites.find((m) => m.name === "Glu");
  assert.equal(glu.contrasts.length, 1);
  const c = glu.contrasts[0];
  assert.ok(Math.abs(c.beta - 0.8) < 0.03, `expected beta ~0.8, got ${c.beta}`);
  assert.ok(c.pValue < 1e-6, `expected highly significant p, got ${c.pValue}`);
  assert.deepEqual(c.covariates, ["drift", "linewidth"]);
});

test("fitDynamicSpectralGlm recovers metabolite modulation and BOLD linewidth change on synthetic 2D transients", () => {
  // Synthetic 64-point ppm grid from 4.0 down to 0.5 ppm
  const F = 64;
  const ppm = Array.from({ length: F }, (_, i) => 4.0 - (i / (F - 1)) * 3.5);
  const peak = (center, width) => ppm.map((p) => 1 / (1 + ((p - center) / width) ** 2));
  const mGlu = peak(2.35, 0.08);
  const mNaa = peak(2.01, 0.05);
  const mCr = peak(3.03, 0.05);
  const bg = ppm.map((p) => 0.15 * Math.exp(-(((p - 1.5) / 0.8) ** 2)));
  // Synthetic BOLD derivative (narrowing sharpens NAA peak: positive center, negative wings)
  const boldDeriv = ppm.map((p) => {
    const d = (p - 2.01) / 0.05;
    return -0.2 * (1 - d * d) / ((1 + d * d) ** 2);
  });
  const freqDeriv = ppm.map((p) => {
    const d = (p - 2.01) / 0.05;
    return 0.1 * d / ((1 + d * d) ** 2);
  });

  const T = 32;
  const trS = 8;
  const events = [
    { onset: 0, duration: 64, condition: "Rest" },
    { onset: 64, duration: 64, condition: "CAP_inhale" },
    { onset: 128, duration: 64, condition: "Rest" },
    { onset: 192, duration: 64, condition: "CAP_inhale" },
  ];
  const spectra = [];
  const timesS = [];
  for (let t = 0; t < T; t += 1) {
    const ts = t * trS;
    timesS.push(ts);
    const stim = (ts >= 64 && ts < 128) || (ts >= 192 && ts < 256);
    const cGlu = 10.0 + (stim ? 1.0 : 0.0); // +10% Glu during CAP_inhale
    const cNaa = 12.0;
    const cCr = 8.0;
    const dBold = stim ? -0.8 : 0.0; // -0.8 Hz BOLD linewidth narrowing
    spectra.push(ppm.map((_, i) => {
      const n = (((t * 37 + i * 19) % 23) - 11) * 1e-4;
      return cGlu * mGlu[i] + cNaa * mNaa[i] + cCr * mCr[i] + bg[i] + dBold * boldDeriv[i] + n;
    }));
  }
  const meanSpectrum = ppm.map((_, i) => spectra.reduce((s, row) => s + row[i], 0) / T);
  const grandCoord = {
    ppm,
    data: meanSpectrum,
    background: bg,
    metabolites: [
      { name: "Glu", concentration: 10.5, curve: ppm.map((_, i) => bg[i] + 10.5 * mGlu[i]) },
      { name: "NAA", concentration: 12.0, curve: ppm.map((_, i) => bg[i] + 12.0 * mNaa[i]) },
      { name: "Cr", concentration: 8.0, curve: ppm.map((_, i) => bg[i] + 8.0 * mCr[i]) },
    ],
  };
  const dyn = fitDynamicSpectralGlm({
    dynamic: { ppm, indices: Array.from({ length: T }, (_, i) => i), timesS, spectra, meanSpectrum, boldLinewidthDeriv: boldDeriv, freqShiftDeriv: freqDeriv },
    grandCoord,
    events,
    trS,
    baselineCondition: "Rest",
  });
  assert.ok(dyn);
  assert.equal(dyn.transientsUsed, 32);
  const glu = dyn.metabolites.find((m) => m.name === "Glu").contrasts[0];
  assert.ok(Math.abs(glu.beta - 1.0) < 0.05, `Glu beta=${glu.beta}`);
  assert.ok(glu.pValue < 1e-6, `Glu p=${glu.pValue}`);
  const bold = dyn.boldLinewidth.contrasts[0];
  assert.ok(Math.abs(bold.beta - -0.8) < 0.05, `BOLD LW beta=${bold.beta}`);
  assert.ok(bold.pValue < 1e-6, `BOLD p=${bold.pValue}`);
});

test("buildControl supports nsimul=0 (empirical MM) and dkntmn (baseline stiffness), and parseBasisHeader flags MM bases", () => {
  const control = buildControl({
    nunfil: 1024,
    deltat: 0.00025,
    hzpppm: 297.2,
    teMs: 6,
    simulateMacromolecules: false,
    baselineStiffness: 0.5,
  });
  assert.match(control, /\n nsimul=0\n/);
  assert.match(control, /\n dkntmn=0\.5\n/);

  const defaultCtrl = buildControl({ nunfil: 1024, deltat: 0.00025, hzpppm: 297.2 });
  assert.doesNotMatch(defaultCtrl, /nsimul=0|dkntmn=/);

  const mmHeader = parseBasisHeader(" $SEQPAR\n HZPPPM=297.2\n ECHOT=6\n SEQ='STEAM'\n $END\n $BASIS\n METABO='Glu'\n $END\n $BASIS\n METABO='Mac'\n $END\n");
  assert.equal(hasBasisMacromolecules(mmHeader), true);
  const plainHeader = parseBasisHeader(" $SEQPAR\n HZPPPM=297.2\n ECHOT=6\n SEQ='STEAM'\n $END\n $BASIS\n METABO='Glu'\n $END\n");
  assert.equal(hasBasisMacromolecules(plainHeader), false);
});

test("fitFmrsDataset orchestrates processFmrs, LCModel fits, QC, GLMs, CSVs, SVGs, and HTML report", async () => {
  const raw = " $NMID\n $END\n" + "  1.0E+00  0.0E+00\n".repeat(1024);
  const lcmBlock = { raw, h2o: raw, nunfil: 1024, deltat: 0.0005, hzpppm: 297.2, teMs: 6, edited: false, warnings: [] };
  const requests = [];
  const engine = {
    async processFmrs(k, options) {
      requests.push({ processFmrs: k, options });
      return {
        report: {
          pipeline: "fmrs",
          trS: 8,
          averagesRaw: 16,
          averagesKept: 15,
          matchLinewidth: options.matchLinewidth,
          targetLinewidthHz: 14.5,
          transients: Array.from({ length: 16 }, (_, idx) => ({
            index: idx,
            timeS: idx * 8,
            kept: idx !== 3,
            removed: idx === 3,
            metric: idx === 3 ? 9.5 : 1.0,
            freqHz: idx === 3 ? null : idx * 0.2,
            phaseDeg: idx === 3 ? null : idx * 0.5,
          })),
          warnings: [],
        },
        header: { hzpppm: 297.2, teMs: 6, trMs: 8000, sequence: "STEAM", family: "STEAM", averages: 16 },
        grandMean: { spectrum: { ppm: [4, 2, 0], real: [0, 1, 0] }, unprocessed: { ppm: [4, 2, 0], real: [0, 0.9, 0] }, lcmodel: lcmBlock },
        bins: options.bins.map((b) => ({
          ...b,
          midTimeS: 0.5 * (b.startTimeS + b.endTimeS),
          averagesTotal: b.indices.length,
          averagesKept: b.indices.filter((i) => i !== 3).length,
          averagesRemoved: b.indices.includes(3) ? 1 : 0,
          keptIndices: b.indices.filter((i) => i !== 3),
          snrBefore: 18,
          snrAfter: 17,
          linewidthBeforeHz: 13.0,
          linewidthAfterHz: 14.5,
          broadeningAppliedHz: options.matchLinewidth ? 1.5 : 0,
          excludedFromLwTarget: false,
          emptyReason: null,
          spectrum: { ppm: [4, 2, 0], real: [0, 1, 0] },
          lcmodel: lcmBlock,
        })),
        dynamic: null,
      };
    },
    async fit(request) {
      requests.push({ fit: request.control });
      return { outputs: { [FILES.table]: nativeTable, [FILES.coord]: nativeCoord } };
    },
  };

  const events = parseEventsText("onset\tduration\ttrial_type\n0\t64\tRest\n64\t64\tCAP_inhale\n");
  const input = fidaInput({
    datasets: [{ name: "cap_run", path: "cap_run.dat", format: "Siemens twix (.dat)", water: "OnlyRFoff", header: { family: "STEAM", sequence: "eja_svs_steam", hzpppm: 297.2, teMs: 6, trMs: 8000, averages: 16 } }],
    errors: [],
  });
  const result = await fitFmrsDataset(engine, {
    input,
    index: 0,
    choice: "steam-7t-te8",
    range: [4.0, 0.2],
    settings: settingsFrom({ simulateMacromolecules: false, baselineStiffness: 0.5 }),
    bases: { library, custom: null },
    fmrs: { mode: "sliding", windowSize: 4, stepSize: 4, events, matchLinewidth: true, dynamicGlm: false },
  });

  assert.equal(result.windows.length, 4);
  assert.equal(result.windows[0].averagesRemoved, 1);
  assert.equal(result.windows[0].broadeningAppliedHz, 1.5);
  assert.match(requests[1].fit, /nsimul=0/);
  assert.match(requests[1].fit, /dkntmn=0\.5/);

  const texts = fmrsResultTexts(result, reportVersions("test 1.0"));
  assert.deepEqual(Object.keys(texts).sort(), ["fmrsReport", "fmrsStats", "fmrsTimeCourse", "fmrsTimeCourseWide", "fmrsTransients"]);
  assert.match(texts.fmrsTimeCourse.body, /^window,label,condition,/);
  assert.match(texts.fmrsTimeCourseWide.body, /broadening_applied_hz/);
  assert.match(texts.fmrsTransients.body, /^transient,time_s,condition,kept,removed/);
  assert.match(texts.fmrsStats.body, /^model,metabolite,condition,/);
  const html = texts.fmrsReport.make();
  assert.match(html, /<svg class="lcm-plot"/);
  assert.match(html, /BOLD LW matching: on/);

  // SVG builders directly
  assert.match(timeCourseSvg({ points: [{ x: 16, y: 10, err: 0.5 }, { x: 48, y: 11, err: 0.6 }], events }), /^<svg /);
  assert.match(qcTimeCourseSvg({ windows: result.windows, events }), /^<svg /);
  assert.match(transientDriftSvg({ transients: result.transients, events }), /^<svg /);
});

test("classifyWindowQc flags missing FWHM/SNR as WARN and distinguishes single-peak NAA/Cr fallback", () => {
  const qc = classifyWindowQc([
    { label: "W1", condition: "Rest", status: "fitted", fwhmPpm: null, lcmSnr: null, metabolites: [{ name: "NAA", concentration: 10 }, { name: "Cr", concentration: 8 }] },
  ], { hzpppm: 297.2 });
  assert.equal(qc.windows[0].qc.status, "WARN");
  assert.ok(qc.windows[0].qc.reasons.some((r) => /FWHM unavailable/.test(r)));
  assert.ok(qc.windows[0].qc.reasons.some((r) => /S\/N unavailable/.test(r)));
  assert.equal(qc.windows[0].qc.tNaaToTCrBasis, "NAA/Cr");
});

test("analyzeFmrsWindows excludes QC-FAIL windows, refuses collinear linewidth confounds, and suppresses overlapping window p-values", () => {
  // 1. QC-FAIL exclusion
  const withFail = Array.from({ length: 10 }, (_, i) => ({
    label: `W${i + 1}`,
    condition: i % 2 ? "Stim" : "Rest",
    midTimeS: i * 16 + 8,
    keptIndices: [i * 2, i * 2 + 1],
    status: "fitted",
    qc: { status: i === 9 ? "FAIL" : "PASS", reasons: [] },
    lwHz: 12 + (i % 3),
    metabolites: [{ name: "Glu", concentration: i === 9 ? 999 : (i % 2 ? 11 : 10), sdPercent: 4 }],
  }));
  const cleanStats = analyzeFmrsWindows(withFail, { baselineCondition: "Rest" });
  assert.equal(cleanStats.nExcludedQc, 1);
  assert.equal(cleanStats.nIncluded, 9);
  const cleanC = cleanStats.metabolites[0].contrasts[0];
  assert.ok(Math.abs(cleanC.beta - 1.0) < 0.05);

  // 2. Exact collinearity between condition and linewidth -> estimable: false, pValue: null
  const collinear = Array.from({ length: 10 }, (_, i) => {
    const stim = i % 2 === 1;
    return {
      label: `W${i + 1}`,
      condition: stim ? "Stim" : "Rest",
      midTimeS: i * 16 + 8,
      keptIndices: [i * 2, i * 2 + 1],
      status: "fitted",
      lwHz: stim ? 10.0 : 12.0, // exact function of condition!
      metabolites: [{ name: "Glu", concentration: stim ? 11.0 : 10.0, sdPercent: 4 }],
    };
  });
  const colStats = analyzeFmrsWindows(collinear, { baselineCondition: "Rest" });
  const colC = colStats.metabolites[0].contrasts[0];
  assert.equal(colC.estimable, false);
  assert.equal(colC.pValue, null);
  assert.equal(colC.beta, null);
  assert.ok(Math.abs(colC.unadjustedDiff - 1.0) < 1e-6);
  assert.match(colC.reason, /collinear with linewidth/i);

  // 3. Overlapping sliding windows -> suppress parametric inference
  const overlapping = Array.from({ length: 8 }, (_, i) => ({
    label: `W${i + 1}`,
    condition: i % 2 ? "Stim" : "Rest",
    midTimeS: i * 8 + 16,
    keptIndices: [i, i + 1, i + 2, i + 3], // overlaps!
    status: "fitted",
    lwHz: 12 + (i % 3),
    metabolites: [{ name: "Glu", concentration: i % 2 ? 11 : 10, sdPercent: 4 }],
  }));
  const ovStats = analyzeFmrsWindows(overlapping, { baselineCondition: "Rest" });
  assert.equal(ovStats.overlappingWindows, true);
  const ovC = ovStats.metabolites[0].contrasts[0];
  assert.equal(ovC.estimable, false);
  assert.equal(ovC.pValue, null);
  assert.equal(ovC.se, null);
  assert.match(ovC.reason, /Overlapping/i);
});

test("fitDynamicSpectralGlm aligns complex 90-degree phase-rotated and shifted transients and rejects misaligned spectra", () => {
  const F = 256;
  const dynPpm = Array.from({ length: F }, (_, i) => 0.1 + (i / (F - 1)) * 4.3);
  const shiftPpm = 0.08;
  const degPerPpm = 12;
  // .COORD ppm omits a PPMGAP around 1.2..1.9 ppm
  const coordPpm = Array.from({ length: 180 }, (_, i) => 4.0 - (i / 179) * 3.5).filter((p) => p < 1.2 || p > 1.9);
  const peak = (p, center, width) => {
    const x = (p - center) / width;
    // Complex Lorentzian: absorption + i * dispersion
    return [1 / (1 + x * x), -x / (1 + x * x)];
  };
  const evalComplex = (pCoord, cGlu, cNaa, cCr) => {
    const [gr, gi] = peak(pCoord, 2.35, 0.08);
    const [nr, ni] = peak(pCoord, 2.01, 0.05);
    const [cr, ci] = peak(pCoord, 3.03, 0.05);
    return [cGlu * gr + cNaa * nr + cCr * cr, cGlu * gi + cNaa * ni + cCr * ci];
  };
  const T = 24;
  const trS = 8;
  const events = [
    { onset: 0, duration: 48, condition: "Rest" },
    { onset: 48, duration: 48, condition: "Stim" },
    { onset: 96, duration: 48, condition: "Rest" },
    { onset: 144, duration: 48, condition: "Stim" },
  ];
  const timesS = Array.from({ length: T }, (_, t) => t * trS);
  // Rotate raw FID-A complex spectra by +90 deg and -ph1(p), and shift by -shiftPpm + scale by 0.25!
  const spectraRe = [];
  const spectraIm = [];
  for (let t = 0; t < T; t += 1) {
    const stim = (timesS[t] >= 48 && timesS[t] < 96) || (timesS[t] >= 144 && timesS[t] < 192);
    const cGlu = 10.0 + (stim ? 1.0 : 0.0);
    const reRow = [];
    const imRow = [];
    for (let i = 0; i < F; i += 1) {
      const pCoord = dynPpm[i] + shiftPpm;
      const [zr, zi] = evalComplex(pCoord, cGlu, 12.0, 8.0);
      // Apply inverse of ph1 and +90 deg global rotation, scaled by 0.25
      const invPh = -(degPerPpm * pCoord * Math.PI) / 180 + Math.PI / 2;
      const c = Math.cos(invPh);
      const s = Math.sin(invPh);
      const noise = (((t * 17 + i * 13) % 19) - 9) * 1e-4;
      reRow.push(0.25 * (zr * c - zi * s) + noise);
      imRow.push(0.25 * (zr * s + zi * c) - noise);
    }
    spectraRe.push(reRow);
    spectraIm.push(imRow);
  }
  const meanRe = dynPpm.map((_, i) => spectraRe.reduce((s, r) => s + r[i], 0) / T);
  const meanIm = dynPpm.map((_, i) => spectraIm.reduce((s, r) => s + r[i], 0) / T);
  const bg = coordPpm.map(() => 0);
  const coordData = coordPpm.map((p) => evalComplex(p, 10.5, 12.0, 8.0)[0]);
  const grandCoord = {
    ppm: coordPpm,
    data: coordData,
    background: bg,
    summary: { shiftPpm, phase1DegPerPpm: degPerPpm },
    metabolites: [
      { name: "Glu", concentration: 10.5, curve: coordPpm.map((p) => 10.5 * peak(p, 2.35, 0.08)[0]) },
      { name: "NAA", concentration: 12.0, curve: coordPpm.map((p) => 12.0 * peak(p, 2.01, 0.05)[0]) },
      { name: "Cr", concentration: 8.0, curve: coordPpm.map((p) => 8.0 * peak(p, 3.03, 0.05)[0]) },
    ],
  };
  const dyn = fitDynamicSpectralGlm({
    dynamic: { ppm: dynPpm, indices: Array.from({ length: T }, (_, i) => i), timesS, spectraRe, spectraIm, meanRe, meanIm, boldDerivRe: [], boldDerivIm: [], freqDerivRe: [], freqDerivIm: [], eccApplied: true },
    grandCoord,
    events,
    trS,
    baselineCondition: "Rest",
  });
  assert.ok(dyn);
  assert.equal(dyn.aligned, true);
  assert.ok(dyn.alignmentRms < 0.05, `alignmentRms=${dyn.alignmentRms}`);
  assert.equal(dyn.seMethod, "newey-west-hac");
  const glu = dyn.metabolites.find((m) => m.name === "Glu").contrasts[0];
  assert.ok(Math.abs(glu.beta - 1.0) < 0.08, `90-deg rotated Glu beta=${glu.beta}`);
  assert.ok(glu.pValue < 1e-4, `Glu p=${glu.pValue}`);

  // Misaligned data (orthogonal/corrupted coord.data) must suppress contrasts cleanly
  const bad = fitDynamicSpectralGlm({
    dynamic: { ppm: dynPpm, indices: Array.from({ length: T }, (_, i) => i), timesS, spectraRe, spectraIm, meanRe, meanIm },
    grandCoord: { ...grandCoord, data: coordPpm.map((_, i) => Math.sin(i * 1.7)) },
    events,
    trS,
    baselineCondition: "Rest",
  });
  assert.equal(bad.aligned, false);
  assert.equal(bad.metabolites.length, 0);
  assert.match(bad.error, /did not align/i);
});

test("resultTexts and reportHtml on window #2 of a 1-dataset fMRS run use dataset index 0 and window id", async () => {
  const raw = " $NMID\n $END\n" + "  1.0E+00  0.0E+00\n".repeat(1024);
  const lcmBlock = { raw, nunfil: 1024, deltat: 0.0005, hzpppm: 297.2, teMs: 6, edited: false, warnings: [] };
  const engine = {
    async processFmrs(_k, options) {
      return {
        report: { pipeline: "fmrs", trS: 8, averagesRaw: 8, averagesKept: 8, matchLinewidth: false, transients: [], warnings: [] },
        header: { hzpppm: 297.2, teMs: 6, trMs: 8000, sequence: "STEAM", family: "STEAM", averages: 8 },
        waterH2o: raw,
        grandMean: { spectrum: { ppm: [4, 2, 0], real: [0, 1, 0] }, unprocessed: { ppm: [4, 2, 0], real: [0, 1, 0] }, lcmodel: lcmBlock },
        bins: options.bins.map((b) => ({
          ...b, midTimeS: 0.5 * (b.startTimeS + b.endTimeS),
          averagesTotal: b.indices.length, averagesKept: b.indices.length, averagesRemoved: 0, keptIndices: b.indices,
          linewidthMatchStatus: "off", emptyReason: null, spectrum: { ppm: [4, 2, 0], real: [0, 1, 0] }, lcmodel: lcmBlock,
        })),
        dynamic: null,
      };
    },
    async fit() {
      return { outputs: { [FILES.table]: nativeTable, [FILES.coord]: nativeCoord } };
    },
  };
  const input = fidaInput({
    datasets: [{ name: "cap_run", path: "cap_run.dat", format: "Siemens twix (.dat)", water: "OnlyRFoff", header: { family: "STEAM", sequence: "STEAM", hzpppm: 297.2, teMs: 6, trMs: 8000, averages: 8 } }],
    errors: [],
  });
  const res = await fitFmrsDataset(engine, {
    input, index: 0, choice: "steam-7t-te8", range: [4.0, 0.2],
    settings: settingsFrom({}), bases: { library, custom: null },
    fmrs: { mode: "sliding", windowSize: 4, stepSize: 4, events: [], matchLinewidth: false, dynamicGlm: false },
  });
  assert.equal(res.windows.length, 2);
  const win2 = res.windows[1].entry;
  assert.equal(win2.index, 0);
  assert.equal(win2.windowIndex, 1);
  assert.equal(win2.windowId, "win_02");
  const texts = resultTexts(win2, input, reportVersions("test 1.0"));
  assert.equal(texts.concentrations.name, "cap_run_win_02_concentrations.csv");
  assert.equal(texts.fitReport.name, "cap_run_win_02_report.html");
  assert.ok(texts.h2o, "top-level waterH2o attached to bin lcmodel");
  assert.match(texts.fitReport.make(), /Window 2/);
});

test("WASM module exports mrs_process_fmrs, returns complex dynamic spectra, and validates indices", async () => {
  const wasmBytes = await readFile(new URL("../src/lcmodel.wasm", import.meta.url));
  const lcm = await loadLcmodel(wasmBytes);
  assert.equal(typeof lcm.processFmrs, "function");
  const missing = lcm.processFmrs(0, { bins: [{ id: "w1", label: "W1", indices: [0, 1], startTimeS: 0, endTimeS: 16 }] });
  assert.match(missing.error, /No such dataset/);

  // 2^32 dataset index must NOT truncate to 0!
  const overflow = lcm.processFmrs(2 ** 32, { bins: [{ id: "w1", label: "W1", indices: [0, 1], startTimeS: 0, endTimeS: 16 }] });
  assert.match(overflow.error, /Invalid dataset index|No such dataset/);

  // Load a single-average SDAT/SPAR and verify processFmrs rejects it cleanly.
  const oneAvgSdat = new Uint8Array(128 * 8).fill(0);
  const oneAvgSpar = new TextEncoder().encode("samples : 128\nrows : 1\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n");
  lcm.addFile("single.sdat", oneAvgSdat);
  lcm.addFile("single.spar", oneAvgSpar);
  const loadedOne = lcm.load();
  assert.equal(loadedOne.datasets.length, 1);
  const singleErr = lcm.processFmrs(0, { bins: [{ id: "w1", label: "W1", indices: [0], startTimeS: 0, endTimeS: 2 }] });
  assert.match(singleErr.error, /at least 2/);

  // Load a 4-average SDAT/SPAR and check complex dynamic export + duplicate index rejection.
  const lcm2 = await loadLcmodel(wasmBytes);
  const n = 128;
  const nAvg = 4;
  const sdat = new Uint8Array(n * nAvg * 8);
  // Fill non-zero VAX floats (0x40800000 -> 1.0 in VAX F-float little-endian pairs)
  for (let i = 0; i < n * nAvg * 2; i += 1) {
    sdat[i * 4] = 0x80;
    sdat[i * 4 + 1] = 0x40;
  }
  const spar = new TextEncoder().encode(`samples : ${n}\nrows : ${nAvg}\nsynthesizer_frequency : 123250000\nsample_frequency : 2000\necho_time : 30\nrepetition_time : 2000\nscan_id : PRESS\n`);
  lcm2.addFile("multi.sdat", sdat);
  lcm2.addFile("multi.spar", spar);
  const loadedMulti = lcm2.load();
  assert.equal(loadedMulti.datasets.length, 1);
  const dupErr = lcm2.processFmrs(0, { bins: [{ id: "w1", label: "W1", indices: [0, 0], startTimeS: 0, endTimeS: 4 }] });
  assert.match(dupErr.error, /duplicate/i);
  const ok = lcm2.processFmrs(0, {
    removeBadAverages: false,
    driftCorrection: false,
    phaseAndReference: false,
    exportTransients: true,
    bins: [
      { id: "w1", label: "W1", indices: [0, 1], startTimeS: 0, endTimeS: 4 },
      { id: "w2", label: "W2", indices: [2, 3], startTimeS: 4, endTimeS: 8 },
    ],
  });
  assert.ok(!ok.error, ok.error);
  assert.equal(ok.bins.length, 2);
  assert.ok(Array.isArray(ok.dynamic.spectraRe) && ok.dynamic.spectraRe.length === 4);
  assert.ok(Array.isArray(ok.dynamic.spectraIm) && ok.dynamic.spectraIm.length === 4);
  assert.equal(ok.bins[0].linewidthMatchStatus, "off");
});

test("Pass 3 statistical & edge-case guards: collinear templates, missing linewidth, overlapping events, pooled IDs, ECC parity, and missing post-match LW", async () => {
  // 1. High-1: Two identical spectral templates must NOT get significant component-level p-values
  const F = 128;
  const ppm = Array.from({ length: F }, (_, i) => 4.0 - (i / (F - 1)) * 3.5);
  const shapeA = ppm.map((p) => 1 / (1 + ((p - 2.01) / 0.05) ** 2));
  const shapeCr = ppm.map((p) => 1 / (1 + ((p - 3.03) / 0.05) ** 2));
  const T = 16;
  const trS = 4;
  const timesS = Array.from({ length: T }, (_, t) => t * trS);
  const events = [
    { onset: 0, duration: 16, condition: "Rest" },
    { onset: 16, duration: 16, condition: "Stim" },
    { onset: 32, duration: 16, condition: "Rest" },
    { onset: 48, duration: 16, condition: "Stim" },
  ];
  const spectraRe = timesS.map((ts, t) => {
    const stim = (ts >= 16 && ts < 32) || (ts >= 48 && ts < 64);
    const amp = 10 + (stim ? 2 : 0);
    return ppm.map((_, i) => amp * shapeA[i] + 8 * shapeCr[i] + (((t * 11 + i * 7) % 13) - 6) * 1e-4);
  });
  const spectraIm = spectraRe.map((r) => r.map(() => 0));
  const meanRe = ppm.map((_, i) => spectraRe.reduce((s, r) => s + r[i], 0) / T);
  const meanIm = ppm.map(() => 0);
  const grandCoord = {
    ppm,
    data: meanRe,
    background: ppm.map(() => 0),
    summary: { shiftPpm: 0, phase1DegPerPpm: 0 },
    metabolites: [
      { name: "MetabA", concentration: 5, curve: shapeA.map((v) => 5 * v) },
      { name: "MetabB", concentration: 5, curve: shapeA.map((v) => 5 * v) }, // identical to MetabA!
      { name: "Cr", concentration: 8, curve: shapeCr.map((v) => 8 * v) },
    ],
  };
  const dyn = fitDynamicSpectralGlm({
    dynamic: { ppm, indices: Array.from({ length: T }, (_, i) => i), timesS, spectraRe, spectraIm, meanRe, meanIm },
    grandCoord,
    events,
    trS,
    baselineCondition: "Rest",
  });
  assert.equal(dyn.aligned, true);
  assert.equal(dyn.identifiable, false);
  for (const name of ["MetabA", "MetabB"]) {
    const c = dyn.metabolites.find((m) => m.name === name).contrasts[0];
    assert.equal(c.estimable, false, `${name} must not be estimable`);
    assert.equal(c.pValue, null, `${name} pValue must be null`);
    assert.match(c.reason, /collinear/i);
  }
  const crC = dyn.metabolites.find((m) => m.name === "Cr").contrasts[0];
  assert.equal(crC.estimable, true, "orthogonal Cr template stays estimable");

  // 2. High-5: Single missing linewidth must NOT drop linewidth covariate on a confounded contrast
  const missingOneLw = Array.from({ length: 12 }, (_, i) => {
    const stim = i % 2 === 1;
    return {
      label: `W${i + 1}`,
      condition: stim ? "Stim" : "Rest",
      midTimeS: i * 16 + 8,
      keptIndices: [i * 2, i * 2 + 1],
      status: "fitted",
      lwHz: i === 0 ? null : (stim ? 10.0 : 12.0),
      metabolites: [{ name: "Glu", concentration: stim ? 11.0 : 10.0, sdPercent: 4 }],
    };
  });
  const missingStats = analyzeFmrsWindows(missingOneLw, { baselineCondition: "Rest" });
  assert.equal(missingStats.seMethod, "reml-ar1-gls");
  const mc = missingStats.metabolites[0].contrasts[0];
  assert.equal(mc.estimable, false);
  assert.equal(mc.pValue, null);
  assert.equal(mc.nExcludedMissingLw, 1);
  assert.match(mc.reason, /collinear with linewidth/i);

  // 3. Medium-5: Overlapping same-condition annotations merge rather than double-counting
  const dupStim = [
    { onset: 0, duration: 4, condition: "Stim" },
    { onset: 0, duration: 4, condition: "Stim" },
    { onset: 0, duration: 4, condition: "Stim" },
  ];
  assert.equal(conditionForInterval(dupStim, 0, 10, "Rest"), "Rest");

  // 4. Low-1: Pooled conditions with colliding slugs get unique IDs
  const pooledBins = buildFmrsBins({
    mode: "conditions",
    averages: 4,
    trS: 2,
    events: [
      { onset: 0, duration: 4, condition: "A B" },
      { onset: 4, duration: 4, condition: "A-B" },
    ],
  });
  assert.deepEqual(pooledBins.map((b) => b.id), ["cond_a_b", "cond_a_b_2"]);

  // 5. Medium-4: QC chart never substitutes pre-match LW when post-match LW is missing
  const svgMissingPost = qcTimeCourseSvg({
    windows: [
      { label: "W1", midTimeS: 4, linewidthBeforeHz: 11.2, linewidthAfterHz: null, broadeningAppliedHz: 1.5, linewidthMatchStatus: "unmatched_missing", lwHz: 12.0, lcmSnr: 25, qc: { status: "PASS", tNaaToTCr: 1.5 } },
    ],
  });
  assert.match(svgMissingPost, /pre-match FID-A LW 11\.2 Hz/);
  assert.doesNotMatch(svgMissingPost, /post-match FID-A LW/);

  // 6. Medium-1: fitFmrsDataset passes eddyCurrentCorrection=false when waterScaling is false
  const seenOpts = [];
  const raw = " $NMID\n $END\n" + "  1.0E+00  0.0E+00\n".repeat(1024);
  const lcmBlock = { raw, nunfil: 1024, deltat: 0.0005, hzpppm: 297.2, teMs: 6, edited: false, warnings: [] };
  const input = fidaInput({
    datasets: [{ name: "cap", path: "cap.dat", format: "Siemens twix (.dat)", water: "OnlyRFoff", header: { family: "STEAM", sequence: "STEAM", hzpppm: 297.2, teMs: 6, trMs: 8000, averages: 8 } }],
    errors: [],
  });
  await fitFmrsDataset({
    async processFmrs(_k, opts) {
      seenOpts.push(opts);
      return {
        report: { pipeline: "fmrs", trS: 8, averagesRaw: 8, averagesKept: 8, matchLinewidth: false, transients: [], warnings: [] },
        header: input.datasets[0].header,
        waterH2o: raw,
        grandMean: { spectrum: { ppm: [4, 2, 0], real: [0, 1, 0] }, unprocessed: { ppm: [4, 2, 0], real: [0, 1, 0] }, lcmodel: lcmBlock },
        bins: opts.bins.map((b) => ({
          ...b, midTimeS: 0.5 * (b.startTimeS + b.endTimeS),
          averagesTotal: b.indices.length, averagesKept: b.indices.length, averagesRemoved: 0, keptIndices: b.indices,
          linewidthMatchStatus: "off", emptyReason: null, spectrum: { ppm: [4, 2, 0], real: [0, 1, 0] }, lcmodel: lcmBlock,
        })),
        dynamic: null,
      };
    },
    async fit() {
      return { outputs: { [FILES.table]: nativeTable, [FILES.coord]: nativeCoord } };
    },
  }, {
    input, index: 0, choice: "steam-7t-te8", range: [4.0, 0.2],
    settings: settingsFrom({ waterScaling: false, eddyCurrentCorrection: true }),
    bases: { library, custom: null },
    fmrs: { mode: "sliding", windowSize: 4, stepSize: 4, events: [], matchLinewidth: false, dynamicGlm: false },
  });
  assert.equal(seenOpts[0].eddyCurrentCorrection, false);
});

test("Pass 4 regressions: CAR(1) REML df guard, gap decay, and complete-case trend linewidth", () => {
  // 1. High-3a: 8 windows with 7 columns (intercept + 4 non-base conditions + drift + lw)
  // has df_reml = 8 - 7 - 1 = 0, so it MUST NOT silently fall back to OLS df = 1.
  const conds = ["Rest", "A", "B", "C", "D", "Rest", "A", "B"];
  const tightWindows = conds.map((cond, i) => ({
    label: `W${i + 1}`,
    condition: cond,
    midTimeS: i * 10 + 5,
    keptIndices: [i * 2, i * 2 + 1],
    status: "fitted",
    lwHz: 10.0 + (i % 3) * 0.6 + (i === 7 ? 0.2 : 0),
    metabolites: [{ name: "Glu", concentration: 10 + (cond === "A" ? 2.0 : cond === "B" ? 1.0 : 0) + (i % 2) * 0.1, sdPercent: 4 }],
  }));
  const tightStats = analyzeFmrsWindows(tightWindows, { baselineCondition: "Rest" });
  const tightContrasts = tightStats.metabolites[0].contrasts;
  assert.equal(tightContrasts.length, 4);
  for (const c of tightContrasts) {
    assert.equal(c.estimable, false, `8-window 7-column contrast ${c.condition} must not be estimable`);
    assert.equal(c.pValue, null);
    assert.equal(c.se, null);
    assert.equal(c.df, null);
    assert.match(c.reason, /residual degrees of freedom/i);
  }

  // 2. High-3b: Continuous-time AR(1) REML must decay correlation across a large time gap.
  // Construct 16 windows with two moderately autocorrelated halves separated by an abrupt sign
  // flip between windows 7 and 8. Under equal spacing, the sign flip drags the lag-1 correlation
  // down; with a 60-window gap inserted between windows 7 and 8, CAR(1) treats the two halves
  // as nearly independent (r = rho^60 ~ 0), changing the estimated ar1Rho, SE, and p-value.
  const errors = [0.9, 0.55, 0.75, 0.3, 0.6, 0.15, 0.45, 0.1, -0.95, -0.5, -0.8, -0.35, -0.65, -0.2, -0.5, -0.15];
  const buildSeries = (gapSteps) => errors.map((e, i) => {
    const stim = i % 2 === 1;
    const t = (i < 8 ? i : i + gapSteps) * 10 + 5;
    return {
      label: `W${i + 1}`,
      condition: stim ? "Stim" : "Rest",
      midTimeS: t,
      keptIndices: [i * 2, i * 2 + 1],
      status: "fitted",
      lwHz: 11.0,
      metabolites: [{ name: "Glu", concentration: 10.0 + (stim ? 0.5 : 0) + e, sdPercent: 4 }],
    };
  });
  const equalStats = analyzeFmrsWindows(buildSeries(0), { baselineCondition: "Rest", includeDrift: false, includeLinewidth: false });
  const gappedStats = analyzeFmrsWindows(buildSeries(60), { baselineCondition: "Rest", includeDrift: false, includeLinewidth: false });
  const eqC = equalStats.metabolites[0].contrasts[0];
  const gapC = gappedStats.metabolites[0].contrasts[0];
  assert.equal(eqC.estimable, true);
  assert.equal(gapC.estimable, true);
  assert.ok(eqC.ar1Rho <= 0.95 && gapC.ar1Rho <= 0.95);
  assert.ok(
    Math.abs(eqC.se - gapC.se) > 1e-3 && Math.abs(eqC.pValue - gapC.pValue) > 1e-4,
    `60-window gap must affect CAR(1) REML SE and p-value (equal rho=${eqC.ar1Rho} se=${eqC.se} p=${eqC.pValue}, gapped rho=${gapC.ar1Rho} se=${gapC.se} p=${gapC.pValue})`,
  );
  assert.ok(
    gapC.ar1Rho > eqC.ar1Rho,
    `60-window gap should recover higher within-block rho (${gapC.ar1Rho} vs ${eqC.ar1Rho})`,
  );

  // 3. High-3c: No-condition linear time trend must apply complete-case linewidth handling
  // instead of dropping linewidth when one window has missing lwHz.
  const lwDrivenTrend = Array.from({ length: 12 }, (_, i) => {
    const lw = 10.0 + i * 0.25 + (i % 2 === 0 ? 0.35 : -0.35);
    return {
      label: `W${i + 1}`,
      condition: null,
      midTimeS: i * 10 + 5,
      keptIndices: [i * 2, i * 2 + 1],
      status: "fitted",
      lwHz: i === 5 ? null : lw,
      metabolites: [{ name: "Glu", concentration: 8.0 + 0.8 * lw + (i % 3 - 1) * 0.02, sdPercent: 4 }],
    };
  });
  const trendStats = analyzeFmrsWindows(lwDrivenTrend);
  const tc = trendStats.metabolites[0].contrasts[0];
  assert.equal(tc.condition, "Linear trend (/min)");
  assert.equal(tc.nExcludedMissingLw, 1);
  assert.deepEqual(tc.covariates, ["time", "linewidth"]);
  assert.equal(tc.estimable, true);
  assert.ok(tc.pValue > 0.1, `linewidth-adjusted time trend should not be spurious (got p=${tc.pValue}, beta=${tc.beta})`);

  // 4. Pass 5 High-1: Constant / zero-residual-variance series must NEVER produce spurious p-values
  const constantSeries = Array.from({ length: 12 }, (_, i) => ({
    label: `W${i + 1}`,
    condition: null,
    midTimeS: i * 10 + 5,
    keptIndices: [i * 2, i * 2 + 1],
    status: "fitted",
    lwHz: 11.0,
    metabolites: [{ name: "Glu", concentration: 10.0, sdPercent: 4 }],
  }));
  const constStats = analyzeFmrsWindows(constantSeries);
  const cc = constStats.metabolites[0].contrasts[0];
  assert.equal(cc.estimable, false, "constant series must suppress parametric inference");
  assert.equal(cc.pValue, null);
  assert.equal(cc.se, null);
  assert.equal(cc.tStat, null);
  assert.match(cc.reason, /residual variance is numerically zero/i);

  const exactConditionSeries = Array.from({ length: 12 }, (_, i) => ({
    label: `W${i + 1}`,
    condition: i % 2 === 1 ? "Stim" : "Rest",
    midTimeS: i * 10 + 5,
    keptIndices: [i * 2, i * 2 + 1],
    status: "fitted",
    lwHz: 11.0,
    metabolites: [{ name: "Glu", concentration: i % 2 === 1 ? 11.0 : 10.0, sdPercent: 4 }],
  }));
  const exactCondStats = analyzeFmrsWindows(exactConditionSeries, { baselineCondition: "Rest" });
  const ec = exactCondStats.metabolites[0].contrasts[0];
  assert.equal(ec.estimable, false, "noiseless zero-variance contrast must suppress parametric inference");
  assert.equal(ec.pValue, null);
  assert.equal(ec.se, null);
  assert.match(ec.reason, /residual variance is numerically zero/i);

  // 5. Pass 6 High-2 & Low: Dynamic GLM with 1 stimulus transient suppresses inference AND exports reason in CSV
  const F = 64;
  const ppm = Array.from({ length: F }, (_, i) => 4.0 - (i / (F - 1)) * 3.5);
  const mGlu = ppm.map((p) => 1 / (1 + ((p - 2.35) / 0.08) ** 2));
  const mCr = ppm.map((p) => 1 / (1 + ((p - 3.03) / 0.05) ** 2));
  const bg = ppm.map(() => 0.1);
  const T = 16;
  const trS = 2;
  const spectraSingle = Array.from({ length: T }, (_, t) => {
    const noise = t === 8 ? 1.5 : (((t * 17) % 11) - 5) * 0.02;
    return ppm.map((_, i) => (10 + noise) * mGlu[i] + 8 * mCr[i] + bg[i]);
  });
  const meanSingle = ppm.map((_, i) => spectraSingle.reduce((s, r) => s + r[i], 0) / T);
  const singleDyn = fitDynamicSpectralGlm({
    dynamic: {
      ppm,
      indices: Array.from({ length: T }, (_, i) => i),
      timesS: Array.from({ length: T }, (_, i) => i * trS),
      spectra: spectraSingle,
      meanSpectrum: meanSingle,
      boldLinewidthDeriv: [],
      freqShiftDeriv: [],
    },
    grandCoord: {
      ppm,
      data: meanSingle,
      background: bg,
      metabolites: [
        { name: "Glu", concentration: 10, curve: ppm.map((_, i) => bg[i] + 10 * mGlu[i]) },
        { name: "Cr", concentration: 8, curve: ppm.map((_, i) => bg[i] + 8 * mCr[i]) },
      ],
    },
    events: [{ onset: 16, duration: 2, condition: "Stim" }],
    trS,
    baselineCondition: "Rest",
  });
  const gluSingle = singleDyn.metabolites.find((m) => m.name === "Glu").contrasts[0];
  assert.equal(gluSingle.nCondition, 1);
  assert.equal(gluSingle.estimable, false, "single stimulus transient must suppress parametric inference");
  assert.equal(gluSingle.pValue, null);
  assert.equal(gluSingle.se, null);
  assert.match(gluSingle.reason, /at least 2 transients/i);
  const dynCsv = fmrsStatsCsv({ windowedStats: null, dynamicGlm: singleDyn });
  assert.match(dynCsv, /at least 2 transients/i, "dynamic CSV note must include suppression reason");
});

test("fitFmrsDataset preserves per-transient QC and preprocessing when every window fit fails", async () => {
  const input = fidaInput({
    datasets: [{
      index: 0,
      label: "P00001.7",
      path: "P00001.7",
      format: "GE P-file",
      header: { points: 1024, averages: 8, hzpppm: 127.7, deltat: 0.0005, teMs: 30, trMs: 2000, sequence: "PRESS" },
      water: false,
      edited: false,
    }],
    errors: [],
    images: [],
  });
  const warnings = [];
  const localBases = {
    library,
    custom: { name: "broken.basis", text: "$BASIS\n", header: { hzpppm: 127.7, teMs: 30, sequence: "PRESS" } },
  };
  const engine = {
    async processFmrs(_k, opts) {
      return {
        header: input.datasets[0].header,
        report: {
          averagesRaw: 8,
          averagesKept: 7,
          averagesRemoved: 1,
          trS: 2,
          matchLinewidth: false,
          targetLinewidthHz: null,
          warnings: [],
          transients: Array.from({ length: 8 }, (_, i) => ({
            index: i,
            timeS: i * 2,
            kept: i !== 3,
            removed: i === 3,
            metric: i === 3 ? 4.8 : 0.4,
            freqHz: (i - 4) * 0.5,
            phaseDeg: (i - 4) * 2.0,
          })),
        },
        grandMean: {
          spectrum: { ppm: [4.0, 3.0, 2.0], real: [0.1, 1.0, 0.2] },
          unprocessed: { ppm: [4.0, 3.0, 2.0], real: [0.1, 0.9, 0.2] },
          lcmodel: { raw: "RAW", hzpppm: 127.7, deltat: 0.0005, teMs: 30, nunfil: 1024 },
        },
        bins: opts.bins.map((b, i) => ({
          ...b,
          midTimeS: (b.startTimeS + b.endTimeS) / 2,
          averagesTotal: b.indices.length,
          averagesKept: i === 0 ? 3 : 4,
          averagesRemoved: i === 0 ? 1 : 0,
          keptIndices: b.indices.filter((idx) => idx !== 3),
          linewidthBeforeHz: 8.2,
          linewidthAfterHz: 8.2,
          broadeningAppliedHz: 0,
          linewidthMatchStatus: "off",
          spectrum: { ppm: [4.0, 3.0, 2.0], real: [0.1, 1.0, 0.2] },
          lcmodel: { raw: "RAW", hzpppm: 127.7, deltat: 0.0005, teMs: 30, nunfil: 1024 },
        })),
      };
    },
    async fit() {
      throw new Error("Simulated LCModel convergence failure");
    },
  };
  const result = await fitFmrsDataset(engine, {
    input,
    index: 0,
    choice: "custom",
    settings: settingsFrom({}),
    bases: localBases,
    fmrs: { mode: "sliding", windowSize: 4, stepSize: 4, events: [{ onset: 0, duration: 0, condition: "Cue" }], matchLinewidth: false, dynamicGlm: false },
    log: (msg, level) => { if (level === "warning") warnings.push(msg); },
  });
  assert.equal(warnings.some((w) => /outside the fixed-TR scan window/i.test(w)), false, `impulse at onset=0 must not warn out-of-range: ${warnings.join("; ")}`);
  assert.equal(result.fittedCount, 0);
  assert.equal(result.windows.length, 2);
  assert.equal(result.transients.length, 8);
  assert.equal(result.transients.filter((t) => !t.kept).length, 1);
  assert.ok(result.grandProcessed?.spectrum?.ppm?.length === 3);
  assert.equal(result.windows[0].status, "failed");
  assert.match(result.windows[0].error, /convergence failure/i);
  const texts = fmrsResultTexts(result, reportVersions("0.1.0", "0.1.0"));
  assert.match(texts.fmrsReport.make(), /Simulated LCModel convergence failure/);
  assert.match(texts.fmrsTransients.body, /4\.8/);
});
