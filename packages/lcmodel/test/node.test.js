import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { PARAMETERS, T1_UNSUPPORTED, downloadModels, fit, optionName, parseParameters } from "../src/node.js";

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

test("the executable rejects unknown options, missing arguments, a T1 and two basis sets", async (t) => {
  const unknown = run("in.dat", "out", "--threshold", "3");
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown option '--threshold'/);
  const missing = run("out");
  assert.equal(missing.status, 1);
  assert.match(missing.stderr, /spectroscopy files and a new output directory/);
  const directory = await scratch(t);
  const t1 = run(...testCase, join(directory, "out"), "--t1", "t1.nii.gz");
  assert.equal(t1.status, 1);
  assert.equal(t1.stderr.trim(), T1_UNSUPPORTED);
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

test("tissue fractions need a header and water-scaled concentrations", async (t) => {
  const directory = await scratch(t);
  const parameters = { fractionGM: 0.6, fractionWM: 0.3, fractionCSF: 0.1 };
  await assert.rejects(
    fit({ inputs: testCase, output: join(directory, "out"), basis: join(native, "3t.basis"), parameters, offline: true }),
    /Tissue correction needs water-scaled concentrations/,
  );
});
