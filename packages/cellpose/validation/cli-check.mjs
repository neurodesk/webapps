#!/usr/bin/env node
// Portable release validation for @neurodesk/cellpose.
// Prefetches both pinned examples from apps/cellpose/examples.json into tmpdir(),
// runs the packaged CLI offline (and under unshare -rn on Linux when available),
// and verifies 2D cyto3, 2D nuclei, and 3D ortho-plane outputs independently.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import examples from "../../../apps/cellpose/examples.json" with { type: "json" };
import { readImage } from "../src/image-io.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/cellpose.js", import.meta.url))];

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
  const dir = join(tmpdir(), "neurodesk-cellpose-validation");
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

// Prefetch both pinned examples into tmpdir() before invoking the CLI (never touch $HOME).
const examplePaths = new Map();
for (const ex of examples) {
  examplePaths.set(ex.id, await fetchPinned(ex.files[0]));
}

const work = await mkdtemp(join(tmpdir(), "cellpose-cli-check-"));
try {
  // 1. self-check
  const selfCheck = runCliOffline(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(
    selfInfo.ok === true && selfInfo.executionProvider === "cpu" && Array.isArray(selfInfo.modelIds) && selfInfo.modelIds.length === 2,
    `self-check reports ok=true, CPU provider and 2 models (ORT ${selfInfo.onnxRuntime})`,
  );

  // 2. 2D cyto3 (allen-cells-2d, ~24 cells, 256x256)
  const out2d = join(work, "cyto3-2d");
  const run2d = runCliOffline([
    examplePaths.get("allen-cells-2d"),
    out2d,
    "--model", "cyto3",
    "--channel", "1",
    "--nuclear-channel", "2",
    "--diameter", "60",
    "--offline",
  ]);
  check(run2d.status === 0, `cyto3-2d: CLI exits 0${run2d.status ? ` (${run2d.stderr.trim()})` : ""}`);
  const buf2d = await readFile(join(out2d, "allen-cells-2d_cellpose_labels.tif"));
  const lbl2d = await readImage("labels.tif", buf2d.buffer.slice(buf2d.byteOffset, buf2d.byteOffset + buf2d.byteLength));
  const csv2d = (await readFile(join(out2d, "allen-cells-2d_cellpose_cells.csv"), "utf8")).trim().split("\n");
  const count2d = csv2d.length - 1;
  let max2d = 0;
  for (const v of lbl2d.planes[0].data) if (v > max2d) max2d = v;
  check(lbl2d.width === 256 && lbl2d.height === 256, "cyto3-2d: label TIFF is 256x256");
  check(count2d >= 15 && count2d <= 35 && max2d === count2d, `cyto3-2d: segmented ${count2d} cells (max label ${max2d})`);

  // 3. 2D nuclei on channel 2 (~21 nuclei)
  const outNuc = join(work, "nuclei-2d");
  const runNuc = runCliOffline([
    examplePaths.get("allen-cells-2d"),
    outNuc,
    "--model", "nuclei",
    "--channel", "2",
    "--diameter", "30",
    "--offline",
  ]);
  check(runNuc.status === 0, `nuclei-2d: CLI exits 0${runNuc.status ? ` (${runNuc.stderr.trim()})` : ""}`);
  const csvNuc = (await readFile(join(outNuc, "allen-cells-2d_cellpose_cells.csv"), "utf8")).trim().split("\n");
  const countNuc = csvNuc.length - 1;
  check(countNuc >= 12 && countNuc <= 35, `nuclei-2d: segmented ${countNuc} nuclei`);

  // 4. 3D cyto3 (allen-cells-3d, 64x64x10, ~18 cells)
  const out3d = join(work, "cyto3-3d");
  const run3d = runCliOffline([
    examplePaths.get("allen-cells-3d"),
    out3d,
    "--model", "cyto3",
    "--channel", "1",
    "--nuclear-channel", "2",
    "--diameter", "30",
    "--do-3d",
    "--anisotropy", "1",
    "--offline",
  ]);
  check(run3d.status === 0, `cyto3-3d: CLI exits 0${run3d.status ? ` (${run3d.stderr.trim()})` : ""}`);
  const buf3d = await readFile(join(out3d, "allen-cells-3d_cellpose_labels.tif"));
  const lbl3d = await readImage("labels.tif", buf3d.buffer.slice(buf3d.byteOffset, buf3d.byteOffset + buf3d.byteLength));
  const csv3d = (await readFile(join(out3d, "allen-cells-3d_cellpose_cells.csv"), "utf8")).trim().split("\n");
  const count3d = csv3d.length - 1;
  check(lbl3d.depth === 10 && lbl3d.width === 64 && lbl3d.height === 64, "cyto3-3d: label stack is 64x64x10");
  check(count3d >= 8 && count3d <= 35, `cyto3-3d: segmented ${count3d} 3D cells`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`\nAll @neurodesk/cellpose portable CLI checks passed${canUnshare ? " (unshare -rn)" : ""}.`);
