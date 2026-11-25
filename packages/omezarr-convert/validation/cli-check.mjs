#!/usr/bin/env node
// Portable release validation for @neurodesk/omezarr-convert.
// Prefetches the pinned retina OME-TIFF example into tmpdir(), then runs the packaged CLI
// offline (and under unshare -rn on Linux when available) and checks the resulting OME-Zarr
// archives against validation/example-reference.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import examples from "../../../apps/omezarr-convert/examples.json" with { type: "json" };
import { archiveStore, checkExample } from "./checks.mjs";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/omezarr-convert.js", import.meta.url))];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

const canUnshare = process.platform === "linux"
  && spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0;

function runCliOffline(args) {
  const execCmd = canUnshare ? ["unshare", "-rn", ...command, ...args] : [...command, ...args];
  const run = spawnSync(execCmd[0], execCmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  if (run.error) throw run.error;
  return run;
}

async function fetchPinned(fileSpec) {
  const dir = join(tmpdir(), "neurodesk-omezarr-convert-validation");
  const target = join(dir, fileSpec.name);
  const existing = await readFile(target).catch(() => null);
  if (existing && existing.byteLength === fileSpec.bytes && sha256(existing) === fileSpec.sha256) {
    return target;
  }
  const response = await fetch(fileSpec.url);
  if (!response.ok) throw new Error(`Failed to fetch ${fileSpec.url}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength !== fileSpec.bytes || sha256(bytes) !== fileSpec.sha256) {
    throw new Error(`${fileSpec.name}: SHA-256 or byte size differs from pinned example.`);
  }
  await mkdir(dir, { recursive: true });
  const partial = `${target}.${process.pid}.partial`;
  await writeFile(partial, bytes);
  await rename(partial, target);
  return target;
}

// Prefetch pinned example into tmpdir() before invoking the CLI (never touch isolated $HOME).
const exampleFile = examples[0].files[0];
const inputPath = await fetchPinned(exampleFile);

const work = await mkdtemp(join(tmpdir(), "omezarr-convert-cli-check-"));
try {
  // 1. self-check
  const selfCheck = runCliOffline(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(
    selfInfo.ok === true && Array.isArray(selfInfo.versions) && selfInfo.versions.includes("0.5") && selfInfo.versions.includes("0.4"),
    `self-check reports ok=true and NGFF versions ${selfInfo.versions?.join(", ")} (${selfInfo.version})`,
  );

  // 2. Convert pinned retina-crop.ome.tif for NGFF 0.5 (mean) and NGFF 0.4 (nearest)
  const cases = [
    { version: "0.5", method: "mean", archive: "retina-crop.ozx" },
    { version: "0.4", method: "nearest", archive: "retina-crop.ome.zarr.zip" },
  ];
  for (const item of cases) {
    const outDir = join(work, `out-${item.version}-${item.method}`);
    const run = runCliOffline([inputPath, outDir, "--version", item.version, "--method", item.method, "--offline"]);
    check(run.status === 0, `NGFF ${item.version} ${item.method}: CLI exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);
    const archiveBytes = new Uint8Array(await readFile(join(outDir, item.archive)));
    const problems = await checkExample(archiveStore(unzipSync(archiveBytes)), item.version, item.method);
    check(problems.length === 0, `NGFF ${item.version} ${item.method}: matches example-reference.json${problems.length ? ` (${problems.join("; ")})` : ""}`);
    const summary = JSON.parse(await readFile(join(outDir, "retina-crop_summary.json"), "utf8"));
    check(
      summary.ngffVersion === item.version && summary.levels.length === 3 && summary.chunksWritten > 0,
      `NGFF ${item.version} ${item.method}: writes valid summary JSON (${summary.levels.length} levels, ${summary.chunksWritten} chunks)`,
    );
  }

  // 3. Directory output mode (--format dir)
  const dirOut = join(work, "out-dir");
  const runDir = runCliOffline([inputPath, dirOut, "--version", "0.5", "--method", "mean", "--format", "dir", "--offline"]);
  check(runDir.status === 0, `NGFF 0.5 dir: CLI exits 0`);
  const zarrJson = JSON.parse(await readFile(join(dirOut, "retina-crop.ome.zarr", "zarr.json"), "utf8"));
  check(zarrJson.zarr_format === 3 && zarrJson.attributes?.ome?.version === "0.5", "NGFF 0.5 dir: writes valid zarr.json");
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`network_isolation=${canUnshare ? "unshare-rn" : "fallback"}`);
console.log(`\nAll @neurodesk/omezarr-convert portable CLI checks passed (${canUnshare ? "unshare -rn" : "fallback"}).`);
