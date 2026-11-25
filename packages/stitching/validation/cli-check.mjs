#!/usr/bin/env node
// Portable release validation for @neurodesk/stitching.
// Prefetches all 16 pinned NIST MIST phase-contrast tiles + TileConfiguration.txt into tmpdir()
// BEFORE running any CLI invocation, runs the CLI offline (under `unshare -rn` on Linux when
// available), and verifies mosaic geometry & tile positions against Fiji's reference output.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inspectTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { maxPositionDifference } from "../src/core/pipeline.js";
import { parseTileConfiguration } from "../src/core/tile-layout.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/stitching.js", import.meta.url))];

const examples = JSON.parse(await readFile(new URL("../../../apps/stitching/examples.json", import.meta.url), "utf8"));
const fijiRefText = await readFile(new URL("../../../apps/stitching/validation/fiji/TileConfiguration.registered.txt", import.meta.url), "utf8");
const fijiRef = parseTileConfiguration(fijiRefText);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

function canUnshareNet() {
  if (process.platform !== "linux") return false;
  return spawnSync("unshare", ["-rn", "true"], { stdio: "ignore" }).status === 0;
}

const useUnshare = canUnshareNet();

function runCli(args) {
  const fullCmd = useUnshare ? ["unshare", "-rn", ...command, ...args] : [...command, ...args];
  const run = spawnSync(fullCmd[0], fullCmd.slice(1), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  return run;
}

const work = await mkdtemp(join(tmpdir(), "stitching-cli-check-"));
try {
  // Prefetch all 16 tiles + TileConfiguration.txt into tmpdir()/tiles before running CLI
  const tilesDir = join(work, "tiles");
  await mkdir(tilesDir);
  for (const file of examples[0].files) {
    const response = await fetch(file.url);
    if (!response.ok) throw new Error(`Failed to fetch ${file.url}: HTTP ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength !== file.bytes || sha256(bytes) !== file.sha256) {
      throw new Error(`${file.name}: integrity check failed`);
    }
    await writeFile(join(tilesDir, file.name), bytes);
  }

  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && selfInfo.phantom?.errorPx < 0.25, `self-check phantom verified (${selfInfo.version})`);

  // 2. Stitch NIST MIST 4x4 example offline using the auto-discovered TileConfiguration.txt
  const outDir = join(work, "out");
  const run = runCli([tilesDir, outDir, "--offline"]);
  check(run.status === 0, `nist-mist-phase-4x4 exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);

  const regText = await readFile(join(outDir, "TileConfiguration.registered.txt"), "utf8");
  const regCfg = parseTileConfiguration(regText);
  check(regCfg.entries.length === 16, `TileConfiguration.registered.txt lists all 16 tiles`);

  const fijiByName = new Map(fijiRef.entries.map((e) => [e.name, e.position]));
  const gotPositions = regCfg.entries.map((e) => e.position);
  const refPositions = regCfg.entries.map((e) => fijiByName.get(e.name));
  const maxDiff = maxPositionDifference(gotPositions, refPositions);
  check(maxDiff <= 0.35, `every tile lands within 0.35 px of Fiji Grid/Collection stitching (max diff ${maxDiff.toFixed(3)} px)`);

  const tiffBytes = await readFile(join(outDir, "img_stitched.tif"));
  const tiffInfo = await inspectTiffStack(tiffBytes.buffer.slice(tiffBytes.byteOffset, tiffBytes.byteOffset + tiffBytes.byteLength));
  check(tiffInfo.width === 4806 && tiffInfo.height === 3601, `fused TIFF dimensions are 4806 × 3601 (got ${tiffInfo.width} × ${tiffInfo.height})`);

  const prov = JSON.parse(await readFile(join(outDir, "img_stitched_provenance.json"), "utf8"));
  check(prov.summary.used === 42 && prov.summary.links === 42, `all 42 overlapping pairs used (${prov.summary.used}/${prov.summary.links})`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/stitching portable CLI checks passed${useUnshare ? " (network-isolated via unshare -rn)" : ""}.`);
