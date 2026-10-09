import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import { parseCoord, parseTable } from "../src/lcmodel-io.js";
import { buildReport, formatConc, SD_LIMIT } from "../src/report.js";
import { correctConcentrations } from "../src/tissue.js";

const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);

async function input(overrides = {}) {
  const coord = parseCoord(await readFile(new URL("native.coord", native), "utf8"));
  const table = parseTable(await readFile(new URL("native.table", native), "utf8"));
  // The native run wrote no per-metabolite curves (no NEACH); give it one.
  coord.metabolites = [{ name: "NAA", concentration: 1.91e-6, curve: coord.fit }];
  return {
    generated: "2026-10-03 12:00 UTC",
    versions: { app: "LCModel web app 0.4.20261003", lcmodel: "6.3-1N (Rust port)", fida: "Rust port 0.1.0" },
    dataset: {
      name: "sub-01 <scan>",
      file: "study/sub-01/sub-01_PRESS_35_act.sdat",
      waterFile: "study/sub-01/sub-01_PRESS_35_ref.sdat",
      format: "Philips SDAT/SPAR",
      header: { fieldT: 3, hzpppm: 127.75, teMs: 35, trMs: 2000, sequence: "PRESS PAR 35", family: "PRESS", averages: 64, coils: 1, points: 2048, spectralWidthHz: 2000 },
      edited: false,
    },
    basis: { id: "press-3t-te35", label: "PRESS, 3 T, TE 35 ms", sha256: "ab".repeat(32), file: "basis/press-3t-te35.basis.gz" },
    control: " $LCMODL\n title='sub-01 <scan>'\n $END\n",
    preprocessing: {
      pipeline: "run_pressproc_auto",
      rm_bad_averages: { nsd: 4, averages_before: 64, averages_after: 61 },
      drift: { total_freq_drift: 1.25, total_phase_drift: 3.5 },
      snr: 88.4,
      linewidth_naa: 6.2,
      warnings: ["Water <reference> is short"],
    },
    spectra: { processed: { ppm: coord.ppm, real: coord.data }, unprocessed: { real: coord.fit } },
    fit: { coord, rows: table.rows, ratioTo: table.ratioTo, unit: "mM", range: [4.2, 0.0] },
    ...overrides,
  };
}

const parse = (html) => new JSDOM(html).window.document;

test("the report is one self-contained HTML document", async () => {
  const html = buildReport(await input());
  assert.match(html, /^<!doctype html>/);
  const doc = parse(html);
  assert.equal(doc.title, "LCModel fit: sub-01 <scan>");
  assert.equal(doc.querySelectorAll("link, script, img, iframe").length, 0, "no external resources or scripts");
  assert.doesNotMatch(html, /\b(?:src|href)=/, "nothing is fetched");
  assert.doesNotMatch(html, /url\(/, "no stylesheet references");
  assert.ok(doc.querySelector("style").textContent.includes("@page"), "carries its own print styles");
  assert.equal(doc.querySelectorAll("svg").length, 3, "fit, preprocessing and metabolite plots");
  assert.equal(doc.querySelectorAll("svg .lcm-fit").length >= 1, true);
});

test("the report carries the information of LCModel's page and the app's provenance", async () => {
  const doc = parse(buildReport(await input()));
  const text = doc.body.textContent.replace(/\s+/g, " ");
  for (const expected of [
    "2026-10-03 12:00 UTC", "LCModel web app 0.4.20261003", "LCModel 6.3-1N (Rust port)", "FID-A Rust port 0.1.0",
    "study/sub-01/sub-01_PRESS_35_act.sdat", "study/sub-01/sub-01_PRESS_35_ref.sdat", "Philips SDAT/SPAR",
    "3.00 T", "35 ms / 2000 ms", "PRESS PAR 35 (PRESS)",
    "PRESS, 3 T, TE 35 ms", "press-3t-te35", "ab".repeat(32),
    "run_pressproc_auto", "3 of 64 removed (threshold 4 SD)", "1.25 Hz", "6.2 Hz (NAA)", "Water <reference> is short",
    "0.084 ppm", "S/N21", "0.008 ppm", "9 deg, 2.2 deg/ppm", "4.2 to 0 ppm",
    "title='sub-01 <scan>'", "FWHM = 0.084 ppm",
  ]) assert.ok(text.includes(expected), `report shows ${expected}`);
  const rows = [...doc.querySelectorAll("table.conc tbody tr")];
  assert.equal(rows.length, 35);
  const naa = rows.find((r) => r.lastElementChild.textContent === "NAA");
  assert.deepEqual([...naa.children].map((c) => c.textContent), ["1.91e-6", "5%", "1.05", "NAA"]);
  assert.equal(doc.querySelector("table.conc th").textContent, "Conc. (mM)");
  assert.equal(doc.querySelectorAll("table.conc th")[2].textContent, "/Cr+PCr");
});

test(`%SD above ${SD_LIMIT}% is flagged and combinations are marked`, async () => {
  const doc = parse(buildReport(await input()));
  const rows = [...doc.querySelectorAll("table.conc tbody tr")];
  const byName = (name) => rows.find((r) => r.lastElementChild.textContent === name);
  assert.ok(byName("Ala").classList.contains("uncertain"), "166% flagged");
  assert.ok(byName("PCh").classList.contains("uncertain"), "999% flagged");
  assert.ok(!byName("NAA").classList.contains("uncertain"), "5% not flagged");
  assert.ok(byName("MM14").classList.contains("uncertain"), "21% is above the limit");
  assert.ok(!byName("GSH").classList.contains("uncertain"), "12% is below it");
  assert.ok(byName("NAA+NAAG").classList.contains("combination"));
});

test("edited data show the edit-OFF spectrum; .RAW input has no preprocessing", async () => {
  const base = await input();
  const edited = parse(buildReport({
    ...base,
    dataset: { ...base.dataset, edited: true },
    spectra: { ...base.spectra, editOff: { real: base.fit.coord.background } },
    preprocessing: { ...base.preprocessing, editClassification: { contrast: 4.2, offFirst: true } },
  }));
  const text = edited.body.textContent;
  assert.ok(text.includes("MEGA-PRESS, edit-ON minus edit-OFF"));
  assert.ok(text.includes("edit-OFF (top, black)"));
  assert.ok(text.includes("NAA/Cr contrast 4.2, edit-OFF first"));
  const raw = parse(buildReport({ ...base, preprocessing: null, spectra: null, dataset: { ...base.dataset, waterFile: null } }));
  assert.ok(raw.body.textContent.includes("fitted without preprocessing"));
  assert.equal(raw.querySelectorAll("svg").length, 2);
});

test("the report states the fit settings and the tissue correction with its inputs", async () => {
  const base = await input();
  const plain = parse(buildReport({ ...base, fit: { ...base.fit, lineBroadening: "widened" } })).body.textContent.replace(/\s+/g, " ");
  assert.ok(plain.includes("Line-broadening priorwidened: DESDT2 2, RFWBAS 80"));
  assert.ok(!plain.includes("Macromolecule model"), "no MM model for unedited data");
  assert.ok(!plain.includes("Tissue correction"), "no correction, no section");
  const rows = base.fit.rows;
  const correction = {
    ...correctConcentrations(rows, { fractions: { gm: 0.55, wm: 0.35, csf: 0.1 }, fieldT: 3, metabolite: { teMs: 35, trMs: 2000 }, water: { teMs: 35, trMs: 2000 }, alpha: true }),
    source: { kind: "segmentation", backend: "cpu" },
  };
  const doc = parse(buildReport({
    ...base,
    dataset: { ...base.dataset, edited: true },
    fit: { ...base.fit, rows, correction, macromoleculeModel: "co-edited", lineBroadening: "lcmodel" },
  }));
  const text = doc.body.textContent.replace(/\s+/g, " ");
  for (const expected of [
    "Macromolecule modelco-edited MM3co tied to MM09", "Line-broadening priorLCModel defaults: DESDT2 0.4, RFWBAS 10",
    "Tissue correction", "GM 0.550, WM 0.350, CSF 0.100", "MindMap partial-volume maps of the T1 (cpu)",
    "mmol/kg tissue water", "WCONC 35880, ATTH2O 0.7", "0.5 (Harris et al. 2015)",
  ]) assert.ok(text.includes(expected), `report shows ${expected}`);
  const heads = [...doc.querySelectorAll("table.conc th")].map((th) => th.textContent);
  assert.deepEqual(heads, ["Conc. (mM)", "%SD", "/Cr+PCr", "Tissue (mmol/kg)", "Alpha", "Metabolite"]);
  const byName = (name) => [...doc.querySelectorAll("table.conc tbody tr")].find((r) => r.lastElementChild.textContent === name);
  const k = rows.findIndex((r) => r.name === "NAA");
  assert.equal(byName("NAA").children[3].textContent, formatConc(correction.rows[k].corrected));
  assert.equal(byName("NAA").children[4].textContent, "", "alpha only for GABA and Glx");
  assert.notEqual(byName("GABA").children[4].textContent, "");
});

test("concentrations are formatted as in the app", () => {
  assert.equal(formatConc(7.389), "7.39");
  assert.equal(formatConc(1.91e-6), "1.91e-6");
  assert.equal(formatConc(0), "0");
  assert.equal(formatConc(null), "");
});
