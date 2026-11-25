import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARAMETERS, downloadModels, fit, optionName, parseParameters, readInputs } from "../src/node.js";
import { sortInputs } from "../src/inputs.js";

const automation = JSON.parse(await readFile(new URL("../../../apps/lcmodel/automation.json", import.meta.url), "utf8"));
const bin = fileURLToPath(new URL("../bin/lcmodel.js", import.meta.url));
const native = fileURLToPath(new URL("../../../exes/lcmodel/tests/data/test_lcm/", import.meta.url));
const testCase = ["data.raw", "control.file"].map((name) => join(native, name));

async function scratch(t) {
  const directory = await mkdtemp(join(tmpdir(), "lcmodel-node-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: "utf8", env: { ...process.env, NEURODESK_OFFLINE: "1" } });

test("the options are the app's fit parameters, and fit-group's are a subset", () => {
  assert.deepEqual(automation.operations.fit.parameters, PARAMETERS);
  const fields = ({ type, enum: choices, minimum, maximum, default: fallback }) => ({ type, choices, minimum, maximum, fallback });
  for (const [key, field] of Object.entries(automation.operations["fit-group"].parameters)) {
    assert.deepEqual(fields(field), fields(PARAMETERS[key]), key);
  }
  assert.equal(optionName("frequencyMHz"), "frequency-mhz");
  assert.equal(optionName("fractionCSF"), "fraction-csf");
  assert.equal(optionName("basisSet"), "basis-set");
});

test("settings are checked against the automation contract", () => {
  assert.deepEqual(parseParameters({ "basis-set": "press-3t-te35", "ppm-end": "0.5", "drift-correction": false }), { basisSet: "press-3t-te35", ppmEnd: 0.5, driftCorrection: false });
  assert.throws(() => parseParameters({ "basis-set": "press-9t" }), /--basis-set must be one of auto, /);
  assert.throws(() => parseParameters({ "line-broadening": "wide" }), /--line-broadening must be one of widened, lcmodel/);
  assert.throws(() => parseParameters({ "bad-average-sd": "0.5" }), /--bad-average-sd must be from 1 to 10/);
  assert.throws(() => parseParameters({ "ppm-start": "high" }), /--ppm-start must be a number/);
  assert.throws(() => parseParameters({ "ppm-start": "" }), /--ppm-start must be a number/);
  assert.throws(() => parseParameters({ "fraction-gm": "0.6", "fraction-wm": "0.3" }), /all three tissue fractions/);
});

test("the executable rejects unknown options, missing arguments, a missing T1 and two basis sets", async (t) => {
  const unknown = run("in.dat", "out", "--threshold", "3");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option '--threshold'/);
  const missing = run("out");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /spectroscopy files and a new output directory/);
  const directory = await scratch(t);
  const t1 = run(...testCase, join(directory, "out"), "--t1", "t1.nii.gz");
  assert.equal(t1.status, 1);
  assert.match(t1.stderr, /Input t1.nii.gz does not exist/);
  const mixed = run(...testCase, join(directory, "out"), "--t1", "t1.nii.gz", "--fraction-gm", "0.6", "--fraction-wm", "0.3", "--fraction-csf", "0.1");
  assert.match(mixed.stderr, /Give either a T1 image or tissue fractions/);
  const both = run(...testCase, join(directory, "out"), "--basis", "a.basis", "--basis-set", "press-3t-te35");
  assert.match(both.stderr, /Give --basis or --basis-set, not both/);
  assert.match(run("--help").stdout, /--\[no-\]drift-correction/);
});

test("the output directory must be new or empty", async (t) => {
  const directory = await scratch(t);
  await writeFile(join(directory, "keep.txt"), "");
  await assert.rejects(fit({ inputs: testCase, output: directory, offline: true }), /is not empty/);
  assert.deepEqual(await readdir(directory), ["keep.txt"]);
});

test("offline, a missing library basis set fails and names the remedy", async (t) => {
  const directory = await scratch(t);
  const models = join(directory, "models");
  await assert.rejects(
    fit({ inputs: testCase, output: join(directory, "out"), parameters: { basisSet: "press-3t-te35" }, cacheDir: models, offline: true }),
    /basis\/press-3t-te35\.basis\.gz is missing from the offline model directory .*download-models/,
  );
  await assert.rejects(downloadModels({ cacheDir: models, offline: true }), /is missing from the offline model directory/);
});

test("a library basis set that fails its checksum is refused", async (t) => {
  const directory = await scratch(t);
  const models = join(directory, "models");
  await mkdir(join(models, "basis"), { recursive: true });
  await writeFile(join(models, "basis", "press-3t-te35.basis.gz"), "not the pinned basis set");
  await assert.rejects(
    fit({ inputs: testCase, output: join(directory, "out"), parameters: { basisSet: "press-3t-te35" }, cacheDir: models, offline: true }),
    /Cached basis\/press-3t-te35\.basis\.gz failed checksum verification/,
  );
});

test("LCModel's test case with its own basis set reproduces native LCModel and writes the app's downloads", async (t) => {
  const directory = await scratch(t);
  const output = join(directory, "out");
  const result = await fit({ inputs: testCase, output, basis: join(native, "3t.basis"), parameters: { lineBroadening: "lcmodel" }, offline: true });
  assert.deepEqual(result.files.sort(), ["data.RAW", "data.control", "data.coord", "data.table", "data_concentrations.csv", "data_report.html"]);
  assert.deepEqual((await readdir(output)).sort(), result.files);
  const table = await readFile(join(output, "data.table"), "utf8");
  const nativeTable = await readFile(join(native, "native.table"), "utf8");
  const results = (text) => text.slice(text.indexOf("$$CONC"), text.indexOf("$$INPU"));
  assert.equal(results(table), results(nativeTable));
  assert.match(await readFile(join(output, "data_concentrations.csv"), "utf8"), /\nNAA,0.00000191,5,1.047\n/);
  assert.equal(result.provenance.basisSet, "3t.basis");
  assert.match(result.provenance.basisFile.sha256, /^[0-9a-f]{64}$/);
  assert.equal(result.provenance.lineBroadening, "lcmodel");
  assert.deepEqual(result.provenance.parameters, { lineBroadening: "lcmodel" });
  await assert.rejects(fit({ inputs: testCase, output, basis: join(native, "3t.basis"), offline: true }), /is not empty/);
});

test("several .RAW files, or a .RAW with scanner files, are refused rather than partly fitted", async (t) => {
  const directory = await scratch(t);
  const second = join(directory, "second");
  await mkdir(second);
  await writeFile(join(second, "data.raw"), await readFile(testCase[0]));
  await assert.rejects(fit({ inputs: [...testCase, second], output: join(directory, "out"), offline: true }), /Give one LCModel .RAW/);
  await writeFile(join(directory, "meas.dat"), "not a .RAW");
  await assert.rejects(fit({ inputs: [...testCase, join(directory, "meas.dat")], output: join(directory, "out"), offline: true }), /an LCModel .RAW or scanner files, not both: meas.dat/);
});

test("tissue fractions need a header and water-scaled concentrations", async (t) => {
  const directory = await scratch(t);
  const parameters = { fractionGM: 0.6, fractionWM: 0.3, fractionCSF: 0.1 };
  await assert.rejects(
    fit({ inputs: testCase, output: join(directory, "out"), basis: join(native, "3t.basis"), parameters, offline: true }),
    /Tissue correction needs water-scaled concentrations/,
  );
});

test("RAW fits log effective acquisition overrides and preserve the input bytes", async (t) => {
  const directory = await scratch(t);
  const raw = " $SEQPAR\n HZPPPM=100\n ECHOT=35\n DWELLTIME=0.001\n SEQ='PRESS'\n $END\n" + await readFile(join(native, "data.raw"), "utf8");
  const source = join(directory, "sample.raw");
  await writeFile(source, raw);
  const logs = [];
  const output = join(directory, "out");
  await fit({
    inputs: [source], output, basis: join(native, "3t.basis"), offline: true,
    parameters: { frequencyMHz: 127.786142, dwellTimeMs: 0.5, lineBroadening: "lcmodel" },
    log: (text, level) => logs.push({ text, level }),
  });
  assert.deepEqual(logs[0], {
    text: "sample.raw: sequence PRESS, 127.786142 MHz, TE 35 ms, dwell time 0.5 ms",
    level: "info",
  });
  assert.equal(await readFile(join(output, "sample.RAW"), "utf8"), raw);
  const control = await readFile(join(output, "sample.control"), "utf8");
  assert.match(control, /hzpppm=127\.786142/i);
  assert.match(control, /deltat=0\.0005/i);
});

test("RAW acquisition diagnostics retain known values when required values are missing", async (t) => {
  const directory = await scratch(t);
  const source = join(directory, "incomplete.raw");
  await writeFile(source, " $SEQPAR\n ECHOT=35\n SEQ='PRESS'\n $END\n" + await readFile(join(native, "data.raw"), "utf8"));
  const logs = [];
  await assert.rejects(fit({
    inputs: [source], output: join(directory, "out"), offline: true,
    log: (text, level) => logs.push({ text, level }),
  }), /records no spectrometer frequency/);
  assert.deepEqual(logs, [{ text: "incomplete.raw: sequence PRESS, TE 35 ms", level: "info" }]);
});

test("CLI rejects invalid fMRS flag combinations and unsupported inputs", async (t) => {
  const directory = await scratch(t);
  const raw = join(native, "data.raw");
  const eventsFile = join(directory, "events.tsv");
  await writeFile(eventsFile, "onset\tduration\ttrial_type\n0\t16\tRest\n16\t16\tStim\n");

  const withoutMode = run(raw, join(directory, "out1"), "--events", eventsFile);
  assert.equal(withoutMode.status, 1);
  assert.match(withoutMode.stderr, /require --fmrs-mode/);

  const badMode = run(raw, join(directory, "out2"), "--fmrs-mode", "bogus");
  assert.equal(badMode.status, 1);
  assert.match(badMode.stderr, /--fmrs-mode must be one of/);

  const badWin = run(raw, join(directory, "out3"), "--fmrs-mode", "sliding", "--fmrs-window", "0");
  assert.equal(badWin.status, 1);
  assert.match(badWin.stderr, /positive integer/);

  const withFractions = run(
    raw, join(directory, "out4"), "--fmrs-mode", "sliding",
    "--fraction-gm", "0.4", "--fraction-wm", "0.5", "--fraction-csf", "0.1",
  );
  assert.equal(withFractions.status, 1);
  assert.match(withFractions.stderr, /Tissue correction.*not supported with --fmrs-mode/);

  const onRaw = run(raw, join(directory, "out5"), "--fmrs-mode", "sliding", "--frequency-mhz", "127.7", "--dwell-time-ms", "0.5");
  assert.equal(onRaw.status, 1);
  assert.match(onRaw.stderr, /multi-transient/);
});

test("readInputs preserves parent folder paths when individual CLI file arguments span different folders", async (t) => {
  const directory = await scratch(t);
  const sub1 = join(directory, "sub-01");
  const sub2 = join(directory, "sub-02");
  await mkdir(sub1);
  await mkdir(sub2);
  const f1 = join(sub1, "svs_steam.dat");
  const f2 = join(sub2, "svs_steam_onlyrfoff.dat");
  const f3 = join(sub1, "svs_steam_w.dat");
  await writeFile(f1, "metab");
  await writeFile(f2, "water-other-subject");
  await writeFile(f3, "water-same-subject");

  // Individual files from different folders preserve relative paths from their common ancestor
  const cross = await readInputs([f1, f2]);
  assert.deepEqual(cross.map((f) => f.name), ["sub-01/svs_steam.dat", "sub-02/svs_steam_onlyrfoff.dat"]);

  // Individual files from the same folder keep plain basenames
  const same = await readInputs([f1, f3]);
  assert.deepEqual(same.map((f) => f.name), ["svs_steam.dat", "svs_steam_w.dat"]);

  // Pass 9 High-1: Mixed directory + loose file arguments share one common-ancestor root
  const sub1Sess = join(sub1, "session");
  const topSess = join(directory, "session");
  await mkdir(sub1Sess);
  await mkdir(topSess);
  const sdat = join(sub1Sess, "scan.sdat");
  const spar = join(topSess, "scan.spar");
  await writeFile(sdat, "sdat");
  await writeFile(spar, "spar");
  const mixed = await readInputs([sub1Sess, spar]);
  assert.deepEqual(mixed.map((f) => f.name), ["sub-01/session/scan.sdat", "session/scan.spar"]);

  // Pass 9 Medium-4: Parent folder names never misclassify a .RAW file as water
  const rawHead = " $NMID\n $END\n 1.0 0.0\n";
  const sorted = sortInputs([{ name: "scan-water-suppressed/data.raw", head: rawHead }]);
  assert.equal(sorted.raw.length, 1);
  assert.equal(sorted.water.length, 0);
});
