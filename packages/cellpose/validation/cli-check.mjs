#!/usr/bin/env node
// Portable release validation for @neurodesk/cellpose.
// Uses only Node built-ins (no package imports). Prefetches pinned examples from
// apps/cellpose/examples.json into tmpdir(), runs the packaged CLI offline (under
// unshare -rn on Linux when available), and compares emitted label masks and CSV
// measurements against Python Cellpose 3.1.1.1 reference masks in
// apps/cellpose/validation/reference.json (IoU >= 0.90, F1 = 1.0, mean IoU > 0.99).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { inflateSync } from "node:zlib";

const examples = JSON.parse(await readFile(new URL("../../../apps/cellpose/examples.json", import.meta.url), "utf8"));
const reference = JSON.parse(await readFile(new URL("../../../apps/cellpose/validation/reference.json", import.meta.url), "utf8"));

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

/** Independent pure-Node reader for uncompressed multi-page integer label TIFFs. */
function readLabelTiff(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const byteOrder = String.fromCharCode(bytes[0], bytes[1]);
  if (byteOrder !== "II" && byteOrder !== "MM") throw new Error(`Invalid TIFF byte order: ${byteOrder}`);
  const le = byteOrder === "II";
  if (view.getUint16(2, le) !== 42) throw new Error("Unsupported TIFF magic (expected classic TIFF 42).");

  const readTagValues = (type, count, valueOffset) => {
    const typeSize = type === 1 || type === 2 ? 1 : type === 3 ? 2 : type === 4 ? 4 : 0;
    if (!typeSize) return [];
    const totalBytes = count * typeSize;
    const base = totalBytes <= 4 ? valueOffset : view.getUint32(valueOffset, le);
    const out = [];
    for (let i = 0; i < count; i += 1) {
      const off = base + i * typeSize;
      if (type === 1) out.push(view.getUint8(off));
      else if (type === 3) out.push(view.getUint16(off, le));
      else if (type === 4) out.push(view.getUint32(off, le));
    }
    return out;
  };

  const pages = [];
  let ifdOffset = view.getUint32(4, le);
  while (ifdOffset !== 0) {
    const count = view.getUint16(ifdOffset, le);
    const tags = new Map();
    for (let i = 0; i < count; i += 1) {
      const entry = ifdOffset + 2 + i * 12;
      const tag = view.getUint16(entry, le);
      const type = view.getUint16(entry + 2, le);
      const n = view.getUint32(entry + 4, le);
      tags.set(tag, readTagValues(type, n, entry + 8));
    }
    const width = tags.get(256)?.[0];
    const height = tags.get(257)?.[0];
    const bps = tags.get(258)?.[0];
    const compression = tags.get(259)?.[0] ?? 1;
    const stripOffsets = tags.get(273) ?? [];
    const stripByteCounts = tags.get(279) ?? [];
    const sampleFormat = tags.get(339)?.[0] ?? 1;
    if (compression !== 1) throw new Error(`Unsupported TIFF compression ${compression}.`);
    if (!width || !height) throw new Error("Missing TIFF dimensions.");
    const page = new Int32Array(width * height);
    const bytesPerSample = bps / 8;
    let dst = 0;
    for (let s = 0; s < stripOffsets.length; s += 1) {
      const off = stripOffsets[s];
      const len = stripByteCounts[s];
      const samples = Math.min(Math.floor(len / bytesPerSample), page.length - dst);
      for (let k = 0; k < samples; k += 1) {
        const p = off + k * bytesPerSample;
        if (bps === 8) page[dst] = sampleFormat === 2 ? view.getInt8(p) : view.getUint8(p);
        else if (bps === 16) page[dst] = sampleFormat === 2 ? view.getInt16(p, le) : view.getUint16(p, le);
        else if (bps === 32) page[dst] = sampleFormat === 2 ? view.getInt32(p, le) : view.getUint32(p, le);
        else throw new Error(`Unsupported label TIFF bit depth ${bps}.`);
        dst += 1;
      }
    }
    pages.push({ width, height, data: page });
    ifdOffset = view.getUint32(ifdOffset + 2 + count * 12, le);
  }
  if (pages.length === 0) throw new Error("Label TIFF contains no pages.");
  const { width, height } = pages[0];
  const depth = pages.length;
  const plane = width * height;
  const labels = new Int32Array(depth * plane);
  for (let z = 0; z < depth; z += 1) labels.set(pages[z].data, z * plane);
  return { width, height, depth, labels };
}

function decodeReferenceLabels(caseKey) {
  const b64 = reference.cases[caseKey].labels_u32_zlib_b64;
  const raw = inflateSync(Buffer.from(b64, "base64"));
  return new Uint32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4);
}

function matchLabels(truth, pred, thresh = 0.9) {
  const overlap = new Map();
  const areaTrue = new Map();
  const areaPred = new Map();
  for (let i = 0; i < truth.length; i += 1) {
    const t = truth[i];
    const p = pred[i];
    if (t) areaTrue.set(t, (areaTrue.get(t) ?? 0) + 1);
    if (p) areaPred.set(p, (areaPred.get(p) ?? 0) + 1);
    if (t && p) overlap.set(`${t},${p}`, (overlap.get(`${t},${p}`) ?? 0) + 1);
  }
  let tp = 0;
  let iouSum = 0;
  for (const [key, inter] of overlap) {
    const [t, p] = key.split(",").map(Number);
    const iou = inter / (areaTrue.get(t) + areaPred.get(p) - inter);
    if (iou >= thresh) {
      tp += 1;
      iouSum += iou;
    }
  }
  const nTrue = areaTrue.size;
  const nPred = areaPred.size;
  return { tp, nTrue, nPred, f1: (2 * tp) / (nTrue + nPred), meanMatchedIou: tp ? iouSum / tp : 0 };
}

function measureLabels2D(labels, width, height) {
  const stats = new Map();
  for (let y = 0; y < height; y += 1) {
    const rowOff = y * width;
    for (let x = 0; x < width; x += 1) {
      const id = labels[rowOff + x];
      if (id <= 0) continue;
      let entry = stats.get(id);
      if (!entry) {
        entry = { area: 0, sumX: 0, sumY: 0 };
        stats.set(id, entry);
      }
      entry.area += 1;
      entry.sumX += x;
      entry.sumY += y;
    }
  }
  const out = new Map();
  for (const [id, s] of stats) {
    out.set(id, { area: s.area, x: s.sumX / s.area, y: s.sumY / s.area });
  }
  return out;
}

function measureLabels3D(labels, width, height, depth) {
  const stats = new Map();
  const plane = width * height;
  for (let z = 0; z < depth; z += 1) {
    const zOff = z * plane;
    for (let y = 0; y < height; y += 1) {
      const rowOff = zOff + y * width;
      for (let x = 0; x < width; x += 1) {
        const id = labels[rowOff + x];
        if (id <= 0) continue;
        let entry = stats.get(id);
        if (!entry) {
          entry = { volume: 0, sumX: 0, sumY: 0, sumZ: 0 };
          stats.set(id, entry);
        }
        entry.volume += 1;
        entry.sumX += x;
        entry.sumY += y;
        entry.sumZ += z;
      }
    }
  }
  const out = new Map();
  for (const [id, s] of stats) {
    out.set(id, { volume: s.volume, x: s.sumX / s.volume, y: s.sumY / s.volume, z: s.sumZ / s.volume });
  }
  return out;
}

function checkCsvAgainstMask2D(csvText, mask, label) {
  const expected = measureLabels2D(mask.labels, mask.width, mask.height);
  const rows = csvText.trim().split("\n");
  const headerOk = rows[0] === "id,centroid_x,centroid_y,area_px,mean_intensity";
  const countOk = rows.length - 1 === expected.size;
  const seen = new Set();
  let allMatch = headerOk && countOk;
  let maxCentroidErr = 0;
  if (allMatch) {
    for (let i = 1; i < rows.length; i += 1) {
      const cols = rows[i].split(",").map(Number);
      if (cols.length !== 5 || cols.some((v) => !Number.isFinite(v))) {
        allMatch = false;
        break;
      }
      const [id, x, y, area, mean] = cols;
      const want = expected.get(id);
      if (!want || seen.has(id) || area !== want.area || mean < 0) {
        allMatch = false;
        break;
      }
      seen.add(id);
      const err = Math.max(Math.abs(x - want.x), Math.abs(y - want.y));
      maxCentroidErr = Math.max(maxCentroidErr, err);
      if (err >= 1e-3) {
        allMatch = false;
        break;
      }
    }
    if (seen.size !== expected.size) allMatch = false;
  }
  check(
    allMatch,
    `${label}: every 2D CSV row matches verified label mask (${rows.length - 1}/${expected.size} cells, max centroid err ${maxCentroidErr.toExponential(2)})`,
  );
}

function checkCsvAgainstMask3D(csvText, mask, label) {
  const expected = measureLabels3D(mask.labels, mask.width, mask.height, mask.depth);
  const rows = csvText.trim().split("\n");
  const headerOk = rows[0] === "id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity";
  const countOk = rows.length - 1 === expected.size;
  const seen = new Set();
  let allMatch = headerOk && countOk;
  let maxCentroidErr = 0;
  if (allMatch) {
    for (let i = 1; i < rows.length; i += 1) {
      const cols = rows[i].split(",").map(Number);
      if (cols.length !== 6 || cols.some((v) => !Number.isFinite(v))) {
        allMatch = false;
        break;
      }
      const [id, x, y, z, vol, mean] = cols;
      const want = expected.get(id);
      if (!want || seen.has(id) || vol !== want.volume || mean < 0) {
        allMatch = false;
        break;
      }
      seen.add(id);
      const err = Math.max(Math.abs(x - want.x), Math.abs(y - want.y), Math.abs(z - want.z));
      maxCentroidErr = Math.max(maxCentroidErr, err);
      if (err >= 1e-3) {
        allMatch = false;
        break;
      }
    }
    if (seen.size !== expected.size) allMatch = false;
  }
  check(
    allMatch,
    `${label}: every 3D CSV row matches verified label mask (${rows.length - 1}/${expected.size} cells, max centroid err ${maxCentroidErr.toExponential(2)})`,
  );
}

function checkCellsCsv2D(csvText, wantCells, label) {
  const rows = csvText.trim().split("\n");
  const headerOk = rows[0] === "id,centroid_x,centroid_y,area_px,mean_intensity";
  const countOk = rows.length - 1 === wantCells.length;
  let allMatch = headerOk && countOk;
  if (allMatch) {
    const parsed = rows.slice(1).map((r) => r.split(",").map(Number));
    const used = new Set();
    for (const [, wantX, wantY, wantArea, wantMean] of wantCells) {
      let bestIdx = -1;
      let bestDist = Infinity;
      for (let i = 0; i < parsed.length; i += 1) {
        if (used.has(i)) continue;
        const d = Math.hypot(parsed[i][1] - wantX, parsed[i][2] - wantY);
        if (d < bestDist) {
          bestDist = d;
          bestIdx = i;
        }
      }
      if (bestIdx < 0) {
        allMatch = false;
        break;
      }
      used.add(bestIdx);
      const [, x, y, area, mean] = parsed[bestIdx];
      if (Math.abs(x - wantX) >= 0.5 || Math.abs(y - wantY) >= 0.5 || Math.abs(area - wantArea) > 5 || Math.abs(mean - wantMean) / wantMean >= 0.01) {
        allMatch = false;
        break;
      }
    }
  }
  check(allMatch, `${label}: CSV matches Python Cellpose 3.1.1.1 cells (${rows.length - 1}/${wantCells.length})`);
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

  // 2. 2D cyto3 (allen-cells-2d vs Python Cellpose 3.1.1.1)
  const want2d = reference.cases.cyto3_2d;
  const out2d = join(work, "cyto3-2d");
  const run2d = runCliOffline([
    examplePaths.get("allen-cells-2d"),
    out2d,
    "--model", "cyto3",
    "--channel", "1",
    "--nuclear-channel", "2",
    "--diameter", String(want2d.diameter),
    "--offline",
  ]);
  check(run2d.status === 0, `cyto3-2d: CLI exits 0${run2d.status ? ` (${run2d.stderr.trim()})` : ""}`);
  const lbl2d = readLabelTiff(await readFile(join(out2d, "allen-cells-2d_cellpose_labels.tif")));
  check(lbl2d.height === want2d.shape[0] && lbl2d.width === want2d.shape[1] && lbl2d.depth === 1, `cyto3-2d: label TIFF is ${lbl2d.width}x${lbl2d.height}`);
  const score2d = matchLabels(decodeReferenceLabels("cyto3_2d"), lbl2d.labels, 0.9);
  check(
    score2d.nPred === want2d.count && score2d.f1 === 1 && score2d.meanMatchedIou > 0.99,
    `cyto3-2d: matches Python Cellpose 3.1.1.1 (${score2d.nPred}/${score2d.nTrue} cells, F1=${score2d.f1.toFixed(4)}, meanIoU=${score2d.meanMatchedIou.toFixed(4)})`,
  );
  const csv2d = await readFile(join(out2d, "allen-cells-2d_cellpose_cells.csv"), "utf8");
  checkCellsCsv2D(csv2d, want2d.cells, "cyto3-2d");
  checkCsvAgainstMask2D(csv2d, lbl2d, "cyto3-2d");

  // 3. 2D nuclei on channel 2 (diameter 40 vs Python Cellpose 3.1.1.1)
  const wantNuc = reference.cases.nuclei_2d;
  const outNuc = join(work, "nuclei-2d");
  const runNuc = runCliOffline([
    examplePaths.get("allen-cells-2d"),
    outNuc,
    "--model", "nuclei",
    "--channel", "2",
    "--diameter", String(wantNuc.diameter),
    "--offline",
  ]);
  check(runNuc.status === 0, `nuclei-2d: CLI exits 0${runNuc.status ? ` (${runNuc.stderr.trim()})` : ""}`);
  const lblNuc = readLabelTiff(await readFile(join(outNuc, "allen-cells-2d_cellpose_labels.tif")));
  check(lblNuc.height === wantNuc.shape[0] && lblNuc.width === wantNuc.shape[1] && lblNuc.depth === 1, `nuclei-2d: label TIFF is ${lblNuc.width}x${lblNuc.height}`);
  const scoreNuc = matchLabels(decodeReferenceLabels("nuclei_2d"), lblNuc.labels, 0.9);
  check(
    scoreNuc.nPred === wantNuc.count && scoreNuc.f1 === 1 && scoreNuc.meanMatchedIou > 0.99,
    `nuclei-2d: matches Python Cellpose 3.1.1.1 (${scoreNuc.nPred}/${scoreNuc.nTrue} nuclei, F1=${scoreNuc.f1.toFixed(4)}, meanIoU=${scoreNuc.meanMatchedIou.toFixed(4)})`,
  );
  const csvNuc = await readFile(join(outNuc, "allen-cells-2d_cellpose_cells.csv"), "utf8");
  checkCellsCsv2D(csvNuc, wantNuc.cells, "nuclei-2d");
  checkCsvAgainstMask2D(csvNuc, lblNuc, "nuclei-2d");

  // 4. 3D cyto3 (allen-cells-3d vs Python Cellpose 3.1.1.1)
  const want3d = reference.cases.cyto3_3d;
  const out3d = join(work, "cyto3-3d");
  const run3d = runCliOffline([
    examplePaths.get("allen-cells-3d"),
    out3d,
    "--model", "cyto3",
    "--channel", "1",
    "--nuclear-channel", "2",
    "--diameter", String(want3d.diameter),
    "--do-3d",
    "--anisotropy", String(want3d.anisotropy),
    "--offline",
  ]);
  check(run3d.status === 0, `cyto3-3d: CLI exits 0${run3d.status ? ` (${run3d.stderr.trim()})` : ""}`);
  const lbl3d = readLabelTiff(await readFile(join(out3d, "allen-cells-3d_cellpose_labels.tif")));
  check(
    lbl3d.depth === want3d.shape[0] && lbl3d.height === want3d.shape[1] && lbl3d.width === want3d.shape[2],
    `cyto3-3d: label stack is ${lbl3d.width}x${lbl3d.height}x${lbl3d.depth}`,
  );
  const score3d = matchLabels(decodeReferenceLabels("cyto3_3d"), lbl3d.labels, 0.9);
  check(
    score3d.nPred === want3d.count && score3d.f1 === 1 && score3d.meanMatchedIou > 0.99,
    `cyto3-3d: matches Python Cellpose 3.1.1.1 (${score3d.nPred}/${score3d.nTrue} 3D cells, F1=${score3d.f1.toFixed(4)}, meanIoU=${score3d.meanMatchedIou.toFixed(4)})`,
  );
  const csv3d = await readFile(join(out3d, "allen-cells-3d_cellpose_cells.csv"), "utf8");
  const rows3d = csv3d.trim().split("\n");
  const totalVol = rows3d.slice(1).reduce((sum, row) => sum + Number(row.split(",")[4]), 0);
  check(
    rows3d[0] === "id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity"
      && rows3d.length - 1 === want3d.count
      && Math.abs(totalVol - want3d.nonzero_voxels) <= 5,
    `cyto3-3d: 3D CSV matches Python reference (${rows3d.length - 1}/${want3d.count} cells, totalVol=${totalVol} vs ${want3d.nonzero_voxels})`,
  );
  checkCsvAgainstMask3D(csv3d, lbl3d, "cyto3-3d");
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`network_isolation=${canUnshare ? "unshare-rn" : "fallback"}`);
console.log(`\nAll @neurodesk/cellpose portable CLI checks passed (${canUnshare ? "unshare -rn" : "fallback"}).`);
