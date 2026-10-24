// Isolated Node/Chromium workload, external RSS sampling and checked outputs for #452.
// Example: node benchmark.mjs --data slab --host node --model trivial --workers 1
//   --cache /storage/.../hmc-bench --out /storage/.../hmc-bench-node.json --preflight
import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync, fork } from "node:child_process";
import { createServer } from "node:http";
import { cpus, freemem, loadavg, release, totalmem } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { sampleProcessMemory } from "./benchmark-memory.mjs";
import { benchmarkPins } from "./benchmark-pins.mjs";
import { benchmarkSourceHashes } from "./benchmark-sources.mjs";

const { values } = parseArgs({ options: {
  data: { type: "string", default: "slab" }, host: { type: "string", default: "node" },
  model: { type: "string", default: "trivial" }, workers: { type: "string", default: "1" },
  repeats: { type: "string", default: "5" }, cache: { type: "string" }, out: { type: "string" },
  preflight: { type: "boolean", default: false }, provision: { type: "boolean", default: false },
  trial: { type: "string" },
} });
assert.ok(["full", "slab"].includes(values.data));
assert.ok(["node", "chromium"].includes(values.host));
assert.ok(["trivial", "gp"].includes(values.model));
const workers = Number(values.workers);
const repeats = values.preflight || values.trial ? 1 : Number(values.repeats);
assert.ok([1, 2, 4].includes(workers));
assert.ok(Number.isInteger(repeats) && repeats >= (values.preflight || values.trial ? 1 : 5));
assert.ok(values.cache && values.out, "Set --cache and --out outside the source tree.");
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const cache = resolve(values.cache);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const pins = await benchmarkPins(values.data);
await mkdir(cache, { recursive: true });
const files = {};
for (const pin of pins) {
  assert.match(pin.url, /^https:\/\/huggingface\.co\/datasets\/[^/]+\/[^/]+\/resolve\/[a-f0-9]{40}\//);
  const path = join(cache, pin.name);
  let bytes = await readFile(path).catch(() => null);
  if (!bytes || bytes.length !== pin.bytes || hash(bytes) !== pin.sha256) {
    const response = await fetch(pin.url);
    if (!response.ok) throw new Error(`Pinned ${pin.role}: HTTP ${response.status}`);
    bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, pin.bytes, pin.role);
    assert.equal(hash(bytes), pin.sha256, pin.role);
    await writeFile(path, bytes);
  }
  files[pin.role] = path;
}
if (values.provision) {
  console.log(JSON.stringify({ files, pins }));
  process.exit(0);
}
const config = { files, fileName: "benchmark_dwi.nii.gz", model: values.model, workers, seed: 1234 };
let sampling;
let activeClose;
for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => {
  sampling?.stop();
  void activeClose?.();
});
function message(child) {
  return new Promise((resolve, reject) => {
    const exit = code => { child.off("message", received); reject(new Error(`Benchmark child exited ${code} before reporting`)); };
    const received = value => { child.off("exit", exit); value.stage === "error" ? reject(new Error(value.error)) : resolve(value); };
    child.once("message", received);
    child.once("exit", exit);
  });
}
async function nodeRun() {
  const child = fork(fileURLToPath(new URL("./benchmark-node.mjs", import.meta.url)), [], { stdio: ["ignore", "inherit", "inherit", "ipc"] });
  const closed = new Promise(resolve => child.once("exit", resolve));
  activeClose = () => child.kill();
  sampling = sampleProcessMemory(child.pid);
  try {
    const ready = message(child);
    child.send(config);
    assert.equal((await ready).stage, "ready");
    const preparedBytes = sampling.sample();
    const done = message(child);
    child.send("run");
    assert.equal((await done).stage, "measured");
    const memory = { ...sampling.stop(), preparedBytes };
    const checked = message(child);
    child.send("verify");
    const result = await checked;
    assert.equal(result.stage, "verified");
    return { ...result.result, memory, version: process.version };
  } finally {
    sampling?.stop();
    child.kill();
    await closed;
    activeClose = null;
  }
}
const allowed = ["packages/hmc/", "packages/hmc-registration/", "packages/components/src/file-io/", "packages/components/src/automation/"];
const mime = { ".js": "text/javascript", ".mjs": "text/javascript", ".wasm": "application/wasm" };
async function chromiumRun() {
  const { chromium } = await import("@playwright/test");
  const server = createServer((request, response) => {
    response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
    response.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
    const path = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    if (path === "/") {
      response.setHeader("Content-Type", "text/html");
      return response.end('<!doctype html><script type="importmap">{"imports":{"@neurodesk/webapp-components/file-io/nifti":"/packages/components/src/file-io/NiftiUtils.js","@neurodesk/webapp-components/file-io/bids-derivatives":"/packages/components/src/file-io/bids-derivatives.js","@neurodesk/webapp-components/file-io/hash":"/packages/components/src/file-io/hash.js"}}</script><script type="module" src="/packages/hmc/validation/benchmark-browser.js"></script>');
    }
    let file;
    if (path.startsWith("/data/")) file = files[path.slice(6)];
    else if (allowed.some(prefix => path.slice(1).startsWith(prefix))) {
      const candidate = resolve(repo, path.slice(1));
      if (allowed.some(prefix => candidate.startsWith(resolve(repo, prefix) + sep))) file = candidate;
    }
    if (!file) { response.writeHead(404).end(); return; }
    response.setHeader("Content-Type", mime[extname(file)] ?? "application/octet-stream");
    const stream = createReadStream(file);
    stream.on("error", () => { response.statusCode = 404; response.end(); });
    stream.pipe(response);
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  let browserServer;
  let browser;
  try {
    browserServer = await chromium.launchServer({ headless: true });
    activeClose = () => browserServer.close();
    sampling = sampleProcessMemory(browserServer.process().pid);
    browser = await chromium.connect(browserServer.wsEndpoint());
    const page = await browser.newPage();
    page.on("pageerror", error => console.error(error));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof window.prepareHmc === "function");
    await page.evaluate(async config => { window.benchmark = await window.prepareHmc(config); }, { ...config, files: Object.fromEntries(Object.keys(files).map(role => [role, `/data/${role}`])) });
    const preparedBytes = sampling.sample();
    await page.evaluate(() => window.benchmark.run());
    const memory = { ...sampling.stop(), preparedBytes };
    const result = await page.evaluate(() => window.benchmark.verify());
    return { ...result, memory, version: browser.version() };
  } finally {
    sampling?.stop();
    await browser?.close();
    await browserServer?.close();
    await new Promise(resolve => server.close(resolve));
    activeClose = null;
  }
}
const receipt = {
  mode: values.preflight ? "correctness preflight; contention allowed; not a benchmark" : "benchmark; reserve a quiet host",
  data: values.data, model: values.model, workers, host: values.host, seed: 1234, trial: values.trial, pins,
  scientificAcceptance: "Scientific acceptance is determined by the separate issue451 gate, not these timing measurements. Trivial software parity does not establish inference quality.",
  machine: { os: `${process.platform} ${release()}`, cpu: cpus()[0]?.model, cores: cpus().length, memoryBytes: totalmem(), freeBytes: freemem(), load: loadavg() },
  sourceCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim(),
  sourceHashes: await benchmarkSourceHashes(repo),
  timing: "Awaited correctNiFreeze, including model preparation, registration, resampling and gzip. Input loading and output verification excluded.",
  memory: "Observed process-tree RSS from host launch through input loading, decoding and completed correction, sampled every 100ms plus preparation/completion boundaries. Verification excluded. Shared Chromium pages may be counted more than once; this is not private memory or a WASM heap limit.",
  exclusions: "Uses supplied pinned masks. Automatic MindGrab mask preparation, model lifetime and the application viewer are not measured. These peaks alone cannot justify a whole-app input-size limit.",
  runs: [], errors: [],
};
for (let i = 0; i < repeats; i++) {
  try {
    assert.deepEqual(await benchmarkSourceHashes(repo), receipt.sourceHashes, "Runtime sources changed before a benchmark run");
    const result = await (values.host === "node" ? nodeRun() : chromiumRun());
    assert.deepEqual(await benchmarkSourceHashes(repo), receipt.sourceHashes, "Runtime sources changed during a benchmark run");
    if (receipt.runs.length) assert.deepEqual(result.hashes, receipt.runs[0].hashes, "Repeated benchmark outputs changed");
    receipt.runs.push(result);
    console.log(`PASS ${values.host} ${values.data} ${values.model} workers=${workers} repeat=${i + 1}`);
  } catch (error) {
    receipt.errors.push(error.stack ?? String(error));
    break;
  }
}
await mkdir(dirname(resolve(values.out)), { recursive: true });
await writeFile(values.out, `${JSON.stringify(receipt, null, 2)}\n`);
if (receipt.errors.length) throw new Error(receipt.errors.join("\n"));
