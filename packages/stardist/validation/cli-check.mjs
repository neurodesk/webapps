#!/usr/bin/env node
// Portable release validation for @neurodesk/stardist.
// Prefetches all three pinned examples from apps/stardist/examples.json into tmpdir(),
// runs the packaged CLI offline (and under unshare -rn on Linux when available), and
// verifies 2D fluorescence, 2D RGB H&E, and 3D demo outputs independently.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import examples from "../../../apps/stardist/examples.json" with { type: "json" };
import { readImage } from "../src/image-io.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/stardist.js", import.meta.url))];

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
  const dir = join(tmpdir(), "neurodesk-stardist-validation");
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

// Prefetch all three pinned examples into tmpdir() before invoking the CLI (never touch $HOME).
const examplePaths = new Map();
for (const ex of examples) {
  examplePaths.set(ex.id, await fetchPinned(ex.files[0]));
}

const work = await mkdtemp(join(tmpdir(), "stardist-cli-check-"));
try {
  // 1. self-check
  const selfCheck = runCliOffline(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(
    selfInfo.ok === true && selfInfo.executionProvider === "cpu" && Array.isArray(selfInfo.modelIds) && selfInfo.modelIds.length === 4,
    `self-check reports ok=true, CPU provider and 4 models (ORT ${selfInfo.onnxRuntime})`,
  );

  // 2. 2D fluorescence (dsb2018-nuclei, ~118 nuclei, 512x512)
  const outFluo = join(work, "fluo");
  const runFluo = runCliOffline([examplePaths.get("dsb2018-nuclei"), outFluo, "--model", "2D_versatile_fluo", "--offline"]);
  check(runFluo.status === 0, `2D_versatile_fluo: CLI exits 0${runFluo.status ? ` (${runFluo.stderr.trim()})` : ""}`);
  const fluoLabelsBuf = await readFile(join(outFluo, "dsb2018-nuclei-2d_stardist_labels.tif"));
  const fluoLabels = await readImage("labels.tif", fluoLabelsBuf.buffer.slice(fluoLabelsBuf.byteOffset, fluoLabelsBuf.byteOffset + fluoLabelsBuf.byteLength));
  const fluoCsvLines = (await readFile(join(outFluo, "dsb2018-nuclei-2d_stardist_nuclei.csv"), "utf8")).trim().split("\n");
  const fluoCount = fluoCsvLines.length - 1;
  let fluoMax = 0;
  for (const v of fluoLabels.planes[0].data) if (v > fluoMax) fluoMax = v;
  check(fluoLabels.width === 512 && fluoLabels.height === 512, `2D_versatile_fluo: label TIFF is 512x512`);
  check(fluoCount >= 100 && fluoCount <= 140 && fluoMax === fluoCount, `2D_versatile_fluo: segmented ${fluoCount} nuclei (max label ${fluoMax})`);

  // 3. 2D RGB H&E (skin-he-nuclei, ~37 nuclei, 512x512)
  const outHe = join(work, "he");
  const runHe = runCliOffline([examplePaths.get("skin-he-nuclei"), outHe, "--model", "2D_versatile_he", "--offline"]);
  check(runHe.status === 0, `2D_versatile_he: CLI exits 0${runHe.status ? ` (${runHe.stderr.trim()})` : ""}`);
  const heLabelsBuf = await readFile(join(outHe, "skin-he-nuclei-2d_stardist_labels.tif"));
  const heLabels = await readImage("labels.tif", heLabelsBuf.buffer.slice(heLabelsBuf.byteOffset, heLabelsBuf.byteOffset + heLabelsBuf.byteLength));
  const heCsvLines = (await readFile(join(outHe, "skin-he-nuclei-2d_stardist_nuclei.csv"), "utf8")).trim().split("\n");
  const heCount = heCsvLines.length - 1;
  check(heLabels.width === 512 && heLabels.height === 512 && heCount >= 20 && heCount <= 60, `2D_versatile_he: 512x512 labels with ${heCount} nuclei`);

  // 4. 3D fluorescence demo (stardist-3d-demo, ~30 nuclei, 57x61x31)
  const out3d = join(work, "demo3d");
  const run3d = runCliOffline([examplePaths.get("stardist-3d-demo"), out3d, "--model", "3D_demo", "--offline"]);
  check(run3d.status === 0, `3D_demo: CLI exits 0${run3d.status ? ` (${run3d.stderr.trim()})` : ""}`);
  const d3Buf = await readFile(join(out3d, "stardist-demo-nuclei-3d_stardist_labels.tif"));
  const d3Labels = await readImage("labels.tif", d3Buf.buffer.slice(d3Buf.byteOffset, d3Buf.byteOffset + d3Buf.byteLength));
  const d3CsvLines = (await readFile(join(out3d, "stardist-demo-nuclei-3d_stardist_nuclei.csv"), "utf8")).trim().split("\n");
  const d3Count = d3CsvLines.length - 1;
  check(d3Labels.depth === 31 && d3Labels.width === 57 && d3Labels.height === 61, `3D_demo: label stack is 57x61x31`);
  check(d3Count >= 20 && d3Count <= 45, `3D_demo: segmented ${d3Count} 3D nuclei`);
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`network_isolation=${canUnshare ? "unshare-rn" : "fallback"}`);
console.log(`\nAll @neurodesk/stardist portable CLI checks passed (${canUnshare ? "unshare -rn" : "fallback"}).`);
