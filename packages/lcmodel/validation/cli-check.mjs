#!/usr/bin/env node
// The lcmodel command line's release check. Three references, none of them
// the command line's own code path:
//
// 1. The web app in a browser (browser-reference.json, recorded by
//    apps/lcmodel/e2e/reference.spec.js): every bundled example with the
//    app's defaults and with each option. Every file the app downloads must
//    come out of the command line byte for byte (the report without its
//    program-and-time line).
// 2. Native gfortran LCModel 6.3-1N on LCModel's own test case
//    (exes/lcmodel/tests/data/test_lcm): the concentration, misc and
//    diagnostics tables must be identical under LCModel's line-broadening prior.
// 3. Pinned results of independent checks: the GABA+ fit of the Siemens
//    MEGA-PRESS example (packages/lcmodel/wasm/src/session.rs,
//    mega_tests, native Rust) and the synthetic water-scaling truth
//    (synthetic.mjs, test/water-scaling.test.js).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import manifest from "../model.manifest.json" with { type: "json" };
import { CASES, cliArguments, compare, documents, exampleFiles, headline, readOutputs, readReference, summarize } from "./reference.mjs";
import { assessSynthetic, syntheticSpectrum, tableConcentration } from "./synthetic.mjs";

// mega_tests in packages/lcmodel/wasm/src/session.rs: ratio to NAA+NAAG and
// its tolerance, fitted natively with the library's TE 68 ms difference basis
// and no water reference. Change both together. Only the Siemens example is
// fitted the same way by the app: the Philips example has a water reference,
// so the app adds water scaling and eddy-current correction, which the Philips
// pins were not measured with.
const MEGA_PINS = Object.freeze({
  "siemens-megapress": { "GABA+MM3co": [0.291, 0.01], GABA: [0.075, 0.01], MM3co: [0.216, 0.01] },
});

// --case ID (repeatable) runs only those cases; "synthetic" names the water-scaling check.
const { values } = parseArgs({ options: { executable: { type: "string" }, case: { type: "string", multiple: true } } });
const selected = (id) => !values.case || values.case.includes(id);
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/lcmodel.js", import.meta.url))];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [];
function check(passed, line) {
  if (!passed) failures.push(line);
  console.log(`${passed ? "PASS" : "FAIL"} ${line}`);
}

/** Run the command line; its JSON report, or an error with its messages. */
function lcmodel(args) {
  const started = performance.now();
  const run = spawnSync(command[0], [...command.slice(1), ...args], { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (run.error) throw run.error;
  if (run.status !== 0) throw new Error(`${command.join(" ")} ${args.join(" ")} exited with ${run.status}:\n${run.stderr}`);
  return { report: JSON.parse(run.stdout), seconds: (performance.now() - started) / 1000 };
}

/** A metabolite's %SD and ratio in a .TABLE file. */
function tableRow(table, name) {
  const row = table.split("\n").find((l) => l.trimEnd().endsWith(` ${name}`));
  if (!row) return null;
  const [, sd, ratio] = row.trim().split(/\s+/);
  return { sdPercent: Number(sd.replace("%", "")), ratio: Number(ratio) };
}

/** LCModel's result tables in a .TABLE file: from $$CONC to the input changes. */
const resultTables = (table) => table.slice(table.indexOf("$$CONC"), table.indexOf("$$INPU"));

function megaChecks(caseId, table) {
  for (const [name, [expected, tolerance]] of Object.entries(MEGA_PINS[caseId] ?? {})) {
    const row = tableRow(table, name);
    const ratio = row?.ratio;
    check(row !== null && Math.abs(ratio - expected) <= tolerance, `${caseId}: ${name}/NAA+NAAG ${ratio} within ${tolerance} of ${expected} (session.rs mega_tests)`);
  }
}

async function libraryBasis(id) {
  const set = manifest.basis_sets.find((b) => b.id === id);
  const asset = manifest.assets.find((a) => a.filename === set.file);
  const path = join(tmpdir(), "neurodesk-lcmodel-validation", asset.sha256, set.file.split("/").at(-1));
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || sha256(bytes) !== asset.sha256) {
    const response = await fetch(manifest.base_url + set.file);
    if (!response.ok) throw new Error(`${set.file}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== asset.sha256) throw new Error(`${set.file}: SHA-256 differs from model.manifest.json`);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(`${path}.partial`, bytes);
    await rename(`${path}.partial`, path);
  }
  return gunzipSync(bytes).toString("utf8");
}

async function syntheticChecks(work) {
  const basis = await libraryBasis("press-3t-te35");
  const spectrum = syntheticSpectrum(basis);
  const inputs = join(work, "synthetic");
  await mkdir(inputs);
  await writeFile(join(inputs, "synthetic.raw"), spectrum.raw);
  await writeFile(join(inputs, "synthetic.h2o"), spectrum.h2o);
  for (const lineBroadening of ["widened", "lcmodel"]) {
    const output = join(work, `synthetic-${lineBroadening}`);
    const options = ["--basis-set", "press-3t-te35", "--frequency-mhz", String(spectrum.hzpppm), "--dwell-time-ms", String(spectrum.deltat * 1000), "--no-eddy-current-correction"];
    if (lineBroadening === "lcmodel") options.push("--line-broadening", "lcmodel");
    lcmodel([join(inputs, "synthetic.raw"), join(inputs, "synthetic.h2o"), output, ...options]);
    const table = await readFile(join(output, "synthetic.table"), "utf8");
    const fitted = { cr: tableConcentration(table, "Cr+PCr"), naa: tableConcentration(table, "NAA+NAAG") };
    for (const [passed, line] of assessSynthetic(lineBroadening, fitted)) check(passed, `synthetic water scaling, ${line}`);
  }
}

const reference = await readReference();
console.log(`INFO reference: ${reference.browser.app}, ${reference.browser.browser}`);
const work = await mkdtemp(join(tmpdir(), "lcmodel-cli-check-"));
try {
  for (const entry of CASES.filter((c) => selected(c.id))) {
    const files = await exampleFiles(entry.example, { includeT1: entry.t1 });
    const basis = files.find((f) => f.role === "basis");
    const output = join(work, entry.id);
    const args = [...files.filter((f) => f.role !== "basis" && f.role !== "t1").map((f) => f.path), output, ...(basis ? ["--basis", basis.path] : []), ...cliArguments(entry.parameters), ...(entry.t1 ? ["--t1", files.find((f) => f.role === "t1").path] : [])];
    const { seconds } = lcmodel(args);
    const expected = reference.cases[entry.id];
    console.log(`INFO ${entry.id}: lcmodel ${cliArguments(entry.parameters).join(" ") || "(defaults)"}, ${seconds.toFixed(1)} s (web app ${expected.seconds} s)`);
    const produced = await readOutputs(output);
    for (const [passed, line] of compare(entry.id, { files: summarize(produced), headline: headline(produced), documents: documents(produced) }, expected)) check(passed, line);
    const table = [...produced].find(([name]) => name.endsWith(".table"))?.[1]?.toString("utf8") ?? "";
    megaChecks(entry.id, table);
    if (entry.id === "lcmodel-test") {
      const native = await readFile(new URL("../../../exes/lcmodel/tests/data/test_lcm/native.table", import.meta.url), "utf8");
      check(resultTables(table) === resultTables(native) && resultTables(native).length > 0, "lcmodel-test: concentration, misc and diagnostics tables identical to native gfortran LCModel 6.3-1N (native.table)");
    }
  }
  if (selected("synthetic")) await syntheticChecks(work);
} finally {
  await rm(work, { recursive: true, force: true });
}
console.log(failures.length ? `FAIL ${failures.length} LCModel command-line checks` : "PASS LCModel command line matches the web app, native LCModel and the pinned fits");
process.exitCode = failures.length ? 1 : 0;
