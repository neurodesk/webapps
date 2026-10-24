// Five alternating trials per configuration, serialized on a reserved host. Timings from
// --preflight are never accepted here. Profiling runs are separate from this matrix.
//   node benchmark-matrix.mjs CACHE OUTDIR [--resume]
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { cpus, loadavg, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { benchmarkSourceHashes } from "./benchmark-sources.mjs";
import { benchmarkPins } from "./benchmark-pins.mjs";
import { validateBenchmarkReceipt } from "./benchmark-receipts.mjs";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { resume: { type: "boolean", default: false } } });
const [cache, destination] = positionals;
if (!cache || !destination || positionals.length !== 2) throw new Error("Usage: benchmark-matrix.mjs CACHE OUTDIR [--resume]");
if (loadavg()[0] > cpus().length / 2) throw new Error("Reserve a quiet host before the benchmark matrix; use --preflight for correctness under contention.");
const out = resolve(destination);
await mkdir(out, { recursive: true });
const existing = await readdir(out);
assert.ok(values.resume || !existing.some(name => name === "matrix.json" || /^(node|chromium)-(full|slab)-(trivial|gp)-[124]-[1-5]\.json$/.test(name)), "Existing trial receipts will not be overwritten; use --resume to validate and reuse them");
const sourceHashes = await benchmarkSourceHashes();
const pins = Object.fromEntries(await Promise.all(["full", "slab"].map(async data => [data, await benchmarkPins(data)])));
const machine = { os: `${process.platform} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem() };
const run = promisify(execFile);
const controller = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => controller.abort());
const schedules = [[1, 2, 4], [2, 4, 1], [4, 1, 2], [1, 4, 2], [2, 1, 4]];
const receipts = [];
const versions = new Map();
for (const host of ["node", "chromium"]) for (const data of ["full", "slab"]) for (const model of ["trivial", "gp"]) {
  for (let trial = 0; trial < schedules.length; trial++) for (const workers of schedules[trial]) {
    const file = join(out, `${host}-${data}-${model}-${workers}-${trial + 1}.json`);
    assert.deepEqual(await benchmarkSourceHashes(), sourceHashes, "Runtime sources changed during the matrix");
    const saved = await readFile(file, "utf8").catch(error => { if (error.code === "ENOENT") return null; throw error; });
    if (saved === null) {
      console.log(`Running ${host} ${data} ${model} workers=${workers} trial=${trial + 1}`);
      await run(process.execPath, [fileURLToPath(new URL("./benchmark.mjs", import.meta.url)),
        "--host", host, "--data", data, "--model", model, "--workers", String(workers),
        "--cache", resolve(cache), "--out", file, "--trial", String(trial + 1)], { maxBuffer: 1024 * 1024, signal: controller.signal });
    } else {
      assert.ok(values.resume, "Existing trial receipts will not be overwritten");
      console.log(`Validating completed receipt ${file}`);
    }
    const receipt = validateBenchmarkReceipt(JSON.parse(saved ?? await readFile(file, "utf8")), {
      host, data, model, workers, trial: String(trial + 1), sourceHashes, pins: pins[data], machine,
    });
    const version = receipt.runs[0].version;
    assert.ok(typeof version === "string" && version.length);
    if (versions.has(host)) assert.equal(version, versions.get(host), `${host} runtime changed during the matrix`);
    else versions.set(host, version);
    receipts.push(receipt);
  }
}
const summarize = values => {
  const sorted = values.toSorted((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], minimum: sorted[0], maximum: sorted.at(-1) };
};
const rows = [];
for (const data of ["full", "slab"]) for (const model of ["trivial", "gp"]) {
  const comparable = receipts.filter(row => row.data === data && row.model === model);
  for (const receipt of comparable) {
    assert.deepEqual(receipt.runs[0].hashes, comparable[0].runs[0].hashes, "Worker count or host changed scientific outputs");
    assert.deepEqual(receipt.sourceHashes, comparable[0].sourceHashes, "Sources changed during the matrix");
  }
  for (const host of ["node", "chromium"]) for (const workers of [1, 2, 4]) {
    const group = comparable.filter(row => row.host === host && row.workers === workers);
    assert.equal(group.length, 5);
    const runs = group.map(row => row.runs[0]);
    rows.push({ host, data, model, workers, repeats: 5,
      seconds: summarize(runs.map(row => row.seconds)),
      secondsPerRegisteredVolume: summarize(runs.map(row => row.seconds / row.expectedRegistrations)),
      observedPeakRSSBytes: summarize(runs.map(row => row.memory.peakBytes)),
    });
  }
}
await writeFile(join(out, "matrix.json"), `${JSON.stringify({
  sourceHashes, machine, pins,
  rows,
  interpretation: "Summaries only. Inspect variation and untimed profiles before selecting workers or input limits. Performance results do not establish scientific accuracy.",
}, null, 2)}\n`);
