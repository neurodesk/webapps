import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { buildControl, parseCoord, parseTable, concentrationsCsv, presentRows, FILES, LINE_BROADENING } from "../src/lcmodel-io.js";
import { spectrumSvg, fitSeries, metaboliteSeries, visibleIndices, tickStep, splitAtGaps } from "../src/spectrum-plot.js";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);

test("control file names the inputs and enables water scaling only with water", () => {
  const plain = buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, teMs: 30 });
  assert.match(plain, /^ \$LCMODL\n/);
  assert.match(plain, /nunfil=2048\n/);
  assert.match(plain, new RegExp(`filraw='${FILES.raw}'`));
  assert.match(plain, /lps=0/);
  assert.doesNotMatch(plain, /dows/);
  assert.match(plain, / \$END\n$/);
  const water = buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, water: true, title: "Mary's scan" });
  assert.match(water, /dows=T/);
  assert.match(water, /doecc=T/);
  assert.match(water, /title='Mary''s scan'/);
  assert.match(buildControl({ nunfil: 2048, deltat: 2.5e-4, hzpppm: 123, water: true, ecc: false }), /doecc=F/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: Number.NaN, hzpppm: 123 }), /finite/);
  const mega = buildControl({ nunfil: 2080, deltat: 4.167e-4, hzpppm: 123.247, sptype: "mega-press-3", ppmStart: 4.2, ppmEnd: 1.95 });
  assert.match(mega, /\n sptype='mega-press-3'\n/);
  assert.match(mega, /ppmend=1\.95/);
  assert.doesNotMatch(plain, /sptype/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: 2e-4, hzpppm: 123, ppmStart: 0.2, ppmEnd: 4 }), /fit range/);
});

test("the line-broadening prior is widened by default and LCModel's own on request", () => {
  const options = { nunfil: 2048, deltat: 2.5e-4, hzpppm: 123.247, water: true };
  const widened = buildControl(options);
  assert.match(widened, /\n desdt2=2\n rfwbas=80\n/);
  assert.equal(buildControl({ ...options, lineBroadening: "widened" }), widened);
  const lcmodel = buildControl({ ...options, lineBroadening: "lcmodel" });
  assert.doesNotMatch(lcmodel, /desdt2|rfwbas/);
  assert.equal(lcmodel, widened.replace(" desdt2=2\n rfwbas=80\n", ""), "nothing else changes");
  assert.deepEqual(Object.keys(LINE_BROADENING), ["widened", "lcmodel"]);
  assert.throws(() => buildControl({ ...options, lineBroadening: "wide" }), /line-broadening/);
});

test("a MEGA-PRESS fit can separate GABA from co-edited MM3co", () => {
  const options = { nunfil: 2080, deltat: 4.167e-4, hzpppm: 123.247, sptype: "mega-press-3", ppmStart: 4.2, ppmEnd: 0.5 };
  const mm = buildControl({ ...options, coEditedMM: true });
  assert.match(mm, /\n nsimul=2\n/);
  assert.match(mm, /chsimu\(1\)='MM09 @ \.915 /);
  // 14 Hz at 123.247 MHz is 0.114 ppm; the minimum Gaussian width is 10.5 Hz.
  assert.match(mm, /chsimu\(2\)='MM3co @ 3\.0 \+- \.02 FWHM= 0\.085 < 0\.114 \+- \.02 AMP= 2\.'/);
  assert.match(mm, /chrato\(2\)='MM3co\/MM09 = 1\. \+- \.2'/);
  assert.match(mm, /\n ncombi=18\n chcomb\(18\)='GABA\+MM3co'\n/);
  // Osprey's GAP.diff1: the region the editing pulse hits directly is not fitted.
  assert.match(mm, /\n ppmgap\(1,1\)=1\.95\n ppmgap\(2,1\)=1\.2\n/);
  // Without the model: LCModel's mega-press-3 as before (its own MM09, no MM3co).
  const old = buildControl({ ...options, ppmEnd: 1.95, coEditedMM: false });
  assert.doesNotMatch(old, /MM3co|nsimul|chsimu|chrato|ncombi|ppmgap/);
  assert.match(old, /ppmend=1\.95/);
  assert.throws(() => buildControl({ nunfil: 2048, deltat: 2e-4, hzpppm: 123, coEditedMM: true }), /MEGA-PRESS/);
});

test("results lead with GABA+ and mark GABA and MM3co as model-dependent", () => {
  const rows = [
    { name: "GABA", concentration: 1.3e-5, sdPercent: 12, ratio: 0.131, combination: false },
    { name: "NAA", concentration: 8e-5, sdPercent: 1, ratio: 0.925, combination: false },
    { name: "MM3co", concentration: 1.5e-5, sdPercent: 12, ratio: 0.165, combination: false },
    { name: "NAA+NAAG", concentration: 8.8e-5, sdPercent: 1, ratio: 1, combination: true },
    { name: "GABA+MM3co", concentration: 2.6e-5, sdPercent: 6, ratio: 0.296, combination: true },
  ];
  const shown = presentRows(rows);
  assert.deepEqual(shown.map((r) => r.name), ["GABA+MM3co", "GABA", "MM3co", "NAA", "NAA+NAAG"]);
  assert.equal(shown[0].primary, true);
  assert.deepEqual(shown.map((r) => Boolean(r.modelDependent)), [false, true, true, false, false]);
  const csv = concentrationsCsv(shown, "NAA+NAAG").split("\n");
  assert.equal(csv[0], "Metabolite,Concentration,SD (%),/NAA+NAAG,Note");
  assert.match(csv[1], /^GABA\+MM3co,.*,GABA\+ \(GABA \+ MM3co\): primary result$/);
  assert.match(csv[2], /^GABA,.*,model-dependent: /);
  assert.match(csv[4], /^NAA,0\.00008,1,0\.925,$/);
  // Fits without the model keep LCModel's order and the four-column CSV.
  const plain = rows.filter((r) => !r.name.includes("MM3co"));
  assert.deepEqual(presentRows(plain), plain);
  assert.doesNotMatch(concentrationsCsv(plain, "NAA+NAAG"), /Note/);
});

test("parses LCModel's own .COORD and .TABLE output", async () => {
  const coord = parseCoord(await readFile(new URL("native.coord", native), "utf8"));
  assert.equal(coord.ratioTo, "Cr+PCr");
  assert.equal(coord.rows.length, 35);
  const naa = coord.rows.find((r) => r.name === "NAA");
  assert.deepEqual([naa.concentration, naa.sdPercent, naa.ratio], [1.91e-6, 5, 1.047]);
  assert.equal(coord.rows.find((r) => r.name === "PCh").sdPercent, 999);
  assert.equal(coord.ppm.length, 498);
  assert.equal(coord.data.length, 498);
  assert.equal(coord.fit.length, 498);
  assert.equal(coord.background.length, 498);
  assert.ok(coord.ppm[0] > coord.ppm[497]);
  assert.deepEqual(coord.summary, { fwhmPpm: 0.084, snr: 21, shiftPpm: 0.008, phase0Deg: 9, phase1DegPerPpm: 2.2 });
  const table = parseTable(await readFile(new URL("native.table", native), "utf8"));
  assert.deepEqual(table.rows, coord.rows);
  const csv = concentrationsCsv(table.rows, table.ratioTo);
  assert.match(csv.split("\n")[0], /^Metabolite,Concentration,SD \(%\),\/Cr\+PCr$/);
  assert.match(csv, /\nNAA,0\.00000191,5,1\.047\n/);
});

test("spectrum plot scales ppm right to left and escapes labels", async () => {
  const coord = parseCoord(await readFile(new URL("native.coord", native), "utf8"));
  const svg = spectrumSvg({ ppm: coord.ppm, series: fitSeries(coord), range: [4.2, 0.2], ariaLabel: "LCModel fit <test>" });
  assert.match(svg, /^<svg class="lcm-plot"/);
  assert.match(svg, /aria-label="LCModel fit &lt;test&gt;"/);
  assert.equal((svg.match(/<polyline/g) || []).length, 4);
  const firstX = Number(svg.match(/class="lcm-data" points="([\d.]+),/)[1]);
  assert.ok(firstX < 100, "highest ppm drawn at the left");
  const stack = metaboliteSeries({ ...coord, metabolites: [{ name: "NAA", curve: coord.fit }, { name: "<b>", curve: coord.background }] });
  assert.equal(stack.length, 1, "curves equal to the baseline are dropped");
  assert.equal(tickStep(4, 8), 0.5);
  const idx = visibleIndices([5, 4, 3, 2, 1, 0], [0, 0, 0, 0, 0, 0], 1, 4);
  assert.deepEqual(idx, [1, 2, 3, 4]);
  // A PPMGAP window is missing from the .COORD axis; no line crosses it.
  const gapped = [2.2, 2.1, 2.0, 1.9, 1.1, 1.0, 0.9];
  assert.deepEqual(splitAtGaps(gapped, [0, 1, 2, 3, 4, 5, 6]), [[0, 1, 2, 3], [4, 5, 6]]);
  const gapSvg = spectrumSvg({ ppm: gapped, series: [{ values: [0, 1, 0, 1, 0, 1, 0], kind: "data", label: "d" }], range: [2.2, 0.9], ariaLabel: "gap" });
  assert.equal((gapSvg.match(/<polyline/g) || []).length, 2);
});
