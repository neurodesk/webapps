// The shared fit workflow with a fake engine: the control file each dataset
// gets, the basis choice and the downloads. The app and the command line both
// run these functions; the user-decided defaults (AGENTS.md, lcmodel) are
// pinned here.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { basisLibrary } from "../src/library.js";
import {
  CUSTOM,
  chooseBasis,
  fidaInput,
  fitPlanned,
  parseCustomBasis,
  planGroup,
  rawAcquisition,
  rawInput,
  reportVersions,
  resultTexts,
  settingsFrom,
} from "../src/pipeline.js";
import { FILES } from "../src/lcmodel-io.js";

const manifest = JSON.parse(await readFile(new URL("../model.manifest.json", import.meta.url), "utf8"));
const library = basisLibrary(manifest);
const native = new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url);
const nativeTable = await readFile(new URL("native.table", native), "utf8");
const nativeCoord = await readFile(new URL("native.coord", native), "utf8");

const PRESS = { family: "PRESS", sequence: "PRESS", hzpppm: 127.73, teMs: 35, fieldT: 3, trMs: 2000 };
const MEGA = { family: "MEGA-PRESS", sequence: "MEGA-PRESS", hzpppm: 123.2, teMs: 68, fieldT: 2.89, trMs: 2000 };
const raw = " $NMID\n $END\n" + "  1.0E+00  0.0E+00\n".repeat(1024);

/** FID-A's result for one dataset, as the module returns it. */
function processed(edited) {
  return {
    lcmodel: { raw, h2o: raw, nunfil: 1024, deltat: 0.0005, hzpppm: 127.73, teMs: 35, edited, editOff: edited ? raw : undefined },
    report: { pipeline: edited ? "MEGA-PRESS" : "PRESS", warnings: [] },
  };
}

/** An engine that records each request and answers with LCModel's native test output. */
function fakeEngine() {
  const requests = [];
  return {
    requests,
    async process(k, options) {
      requests.push({ process: k, options });
      return processed(options.edited ?? this.edited ?? false);
    },
    async fit(request) {
      requests.push(request);
      return { outputs: { [FILES.table]: nativeTable, [FILES.coord]: nativeCoord } };
    },
  };
}

const input = (header, extra = {}) => fidaInput({ datasets: [{ name: "data", path: "data", format: "test", header, water: "w", ...extra }], errors: [] });
const bases = (custom = null) => ({ library, custom });

async function fitWith(header, settings = settingsFrom(), basisId) {
  const engine = fakeEngine();
  engine.edited = header.family === "MEGA-PRESS";
  const data = input(header);
  const choice = basisId ?? chooseBasis(data, 0, { bases: bases(), acquisition: null });
  const entry = await fitPlanned(engine, { input: data, index: 0, basisId: choice, settings, bases: bases(), acquisition: null });
  return { entry, engine, control: entry.fit.control };
}

test("unedited fits get the widened line-broadening prior by default, and LCModel's on request", async () => {
  const widened = await fitWith(PRESS);
  assert.match(widened.control, /\n desdt2=2\n rfwbas=80\n/);
  assert.equal(widened.entry.fit.lineBroadening, "widened");
  assert.match(widened.control, /\n ppmst=4\n ppmend=0.2\n/);
  const lcmodel = await fitWith(PRESS, settingsFrom({ lineBroadening: "lcmodel" }));
  assert.doesNotMatch(lcmodel.control, /desdt2|rfwbas/);
});

test("MEGA-PRESS gets the co-edited MM model and LCModel's prior, whatever the line-broadening setting", async () => {
  const { control, entry } = await fitWith(MEGA, settingsFrom({ lineBroadening: "widened" }));
  assert.equal(entry.basis.id, "megapress-3t-te68-diff");
  assert.match(control, /sptype='mega-press-3'/);
  assert.match(control, /chsimu\(2\)='MM3co @ 3.0/);
  assert.match(control, /\n ppmst=4.2\n ppmend=0.5\n/);
  assert.doesNotMatch(control, /desdt2|rfwbas/);
  assert.equal(entry.fit.macromoleculeModel, "co-edited");
  assert.equal(entry.fit.lineBroadening, "lcmodel");
  const none = await fitWith(MEGA, settingsFrom({ macromoleculeModel: "none" }));
  assert.doesNotMatch(none.control, /MM3co/);
  assert.match(none.control, /\n ppmst=4.2\n ppmend=1.95\n/);
});

test("an MM-suppressed basis set always fits without the co-edited MM model", async () => {
  const header = { ...MEGA, hzpppm: 127.73, teMs: 80 };
  const { control, entry } = await fitWith(header, settingsFrom({ macromoleculeModel: "co-edited" }), "megapress-3t-te80-mmsup-diff");
  assert.equal(entry.fit.macromoleculeModel, "none");
  assert.doesNotMatch(control, /MM3co/);
});

test("a given fit range replaces only the end it sets", async () => {
  const { control } = await fitWith(PRESS, settingsFrom({ ppmEnd: 0.5 }));
  assert.match(control, /\n ppmst=4\n ppmend=0.5\n/);
});

test("preprocessing options and the editing override reach FID-A", async () => {
  const engine = fakeEngine();
  const data = input({ ...PRESS, editing: { detected: true, contrast: 3 } });
  data.datasets[0].editOverride = false;
  const settings = settingsFrom({ removeBadAverages: false, badAverageSd: 2.5, driftCorrection: false, phaseAndReference: false });
  await fitPlanned(engine, { input: data, index: 0, basisId: "press-3t-te35", settings, bases: bases(), acquisition: null });
  assert.deepEqual(engine.requests[0].options, { removeBadAverages: false, badAverageSd: 2.5, driftCorrection: false, phaseAndReference: false, edited: false });
});

test("water scaling and eddy-current correction follow the settings", async () => {
  const off = await fitWith(PRESS, settingsFrom({ waterScaling: false }));
  assert.doesNotMatch(off.control, /filh2o|dows/);
  assert.equal(off.entry.fit.unit, "a.u.");
  const noEcc = await fitWith(PRESS, settingsFrom({ eddyCurrentCorrection: false }));
  assert.match(noEcc.control, /dows=T/);
  assert.doesNotMatch(noEcc.control, /doecc=T/);
});

test("the basis set: the user's own, the requested one, or the recommendation; a mismatch is refused", () => {
  const data = input(PRESS);
  assert.equal(chooseBasis(data, 0, { bases: bases(), acquisition: null }), "press-3t-te35-shaped");
  assert.equal(chooseBasis(data, 0, { basisSet: "press-3t-te35", bases: bases(), acquisition: null }), "press-3t-te35");
  assert.throws(() => chooseBasis(data, 0, { basisSet: "slaser-7t-te28", bases: bases(), acquisition: null }), /does not fit these data/);
  const custom = parseCustomBasis("3t.basis", " $SEQPAR\n HZPPPM=127.8\n ECHOT=35\n $END\n $BASIS\n METABO='NAA'\n $END\n");
  assert.equal(chooseBasis(data, 0, { bases: bases(custom), acquisition: null }), CUSTOM);
  assert.throws(() => parseCustomBasis("x.basis", "no basis here"), /not an LCModel .BASIS file/);
});

test("a .RAW takes the given frequency and dwell time over its own, and keeps its dwell time to six digits", () => {
  const data = rawInput({ name: "a.raw", text: " $SEQPAR\n hzpppm=123.2\n dwellTime=0.000166666666\n $END\n $NMID\n $END\n 1 0\n 1 0\n" });
  assert.deepEqual(rawAcquisition(data), { hzpppm: 123.2, deltat: 0.000166667 });
  assert.deepEqual(rawAcquisition(data, { frequencyMHz: 127.7, dwellTimeMs: 0.25 }), { hzpppm: 127.7, deltat: 0.00025 });
});

test("a group run fits each dataset with its recommended basis unless a choice suits them all", () => {
  const data = fidaInput({ datasets: [{ name: "a", header: PRESS }, { name: "b", header: { ...PRESS, teMs: 144 } }], errors: [] });
  const recommended = planGroup(data, { choice: "press-3t-te35-shaped", explicit: false, bases: bases(), acquisition: null });
  assert.deepEqual(recommended.bases, ["press-3t-te35-shaped", "press-3t-te144-shaped"]);
  assert.equal(recommended.mode, "recommended");
});

test("the downloads carry the app's names, and the report names the program", async () => {
  const { entry } = await fitWith(PRESS);
  const data = input(PRESS);
  const texts = resultTexts(entry, data, reportVersions("lcmodel command line 1.2.3"));
  assert.deepEqual(Object.fromEntries(Object.entries(texts).map(([role, t]) => [role, t.name])), {
    concentrations: "data_concentrations.csv",
    fitReport: "data_report.html",
    table: "data.table",
    coord: "data.coord",
    raw: "data.RAW",
    control: "data.control",
    h2o: "data.H2O",
    preprocessing: "data_fida.json",
  });
  assert.match(texts.fitReport.make(), /lcmodel command line 1\.2\.3 · LCModel 6\.3-1N, Rust port/);
  assert.equal(texts.table.body, nativeTable);
});
