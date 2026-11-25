#!/usr/bin/env node
// Portable release validation for @neurodesk/stardist.
// Uses only Node built-ins (no package imports). Prefetches pinned examples from
// apps/stardist/examples.json into tmpdir(), runs the packaged CLI offline (under
// unshare -rn on Linux when available), and validates all 4 bundled models byte-for-byte
// against Python StarDist 0.9.1 reference masks and nucleus tables in
// apps/stardist/validation/reference.json.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const examples = JSON.parse(await readFile(new URL("../../../apps/stardist/examples.json", import.meta.url), "utf8"));
const reference = JSON.parse(await readFile(new URL("../../../apps/stardist/validation/reference.json", import.meta.url), "utf8"));

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/stardist.js", import.meta.url))];

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const labelHash = (labels) => sha256(new Uint8Array(labels.buffer, labels.byteOffset, labels.byteLength));

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
  const headerOk = rows[0] === "id,centroid_x,centroid_y,area_px,mean_intensity,probability";
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
      const [id, x, y, area, mean, prob] = cols;
      const want = expected.get(id);
      if (!want || seen.has(id) || area !== want.area || mean < 0 || prob <= 0 || prob > 1) {
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
    `${label}: every 2D CSV row matches verified label mask (${rows.length - 1}/${expected.size} nuclei, max centroid err ${maxCentroidErr.toExponential(2)})`,
  );
}

function checkCsvAgainstMask3D(csvText, mask, label) {
  const expected = measureLabels3D(mask.labels, mask.width, mask.height, mask.depth);
  const rows = csvText.trim().split("\n");
  const headerOk = rows[0] === "id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity,probability";
  const countOk = rows.length - 1 === expected.size;
  const seen = new Set();
  let allMatch = headerOk && countOk;
  let maxCentroidErr = 0;
  if (allMatch) {
    for (let i = 1; i < rows.length; i += 1) {
      const cols = rows[i].split(",").map(Number);
      if (cols.length !== 7 || cols.some((v) => !Number.isFinite(v))) {
        allMatch = false;
        break;
      }
      const [id, x, y, z, vol, mean, prob] = cols;
      const want = expected.get(id);
      if (!want || seen.has(id) || vol !== want.volume || mean < 0 || prob <= 0 || prob > 1) {
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
    `${label}: every 3D CSV row matches verified label mask (${rows.length - 1}/${expected.size} nuclei, max centroid err ${maxCentroidErr.toExponential(2)})`,
  );
}

function checkNucleiCsv2D(csvText, wantNuclei, label, { centroidTol = 5e-4, meanRelTol = 1e-6 } = {}) {
  const rows = csvText.trim().split("\n");
  const headerOk = rows[0] === "id,centroid_x,centroid_y,area_px,mean_intensity,probability";
  const countOk = rows.length - 1 === wantNuclei.length;
  let allMatch = headerOk && countOk;
  let maxCentroidErr = 0;
  let maxMeanRelErr = 0;
  if (allMatch) {
    for (let i = 0; i < wantNuclei.length; i += 1) {
      const [id, x, y, area, mean] = rows[i + 1].split(",").map(Number);
      const [wantId, wantX, wantY, wantArea, wantMean] = wantNuclei[i];
      const cx = Math.abs(x - wantX);
      const cy = Math.abs(y - wantY);
      const mRel = Math.abs(mean - wantMean) / wantMean;
      maxCentroidErr = Math.max(maxCentroidErr, cx, cy);
      maxMeanRelErr = Math.max(maxMeanRelErr, mRel);
      if (id !== wantId || area !== wantArea || cx >= centroidTol || cy >= centroidTol || mRel >= meanRelTol) {
        allMatch = false;
        break;
      }
    }
  }
  check(
    allMatch,
    `${label}: CSV matches Python StarDist reference (${rows.length - 1}/${wantNuclei.length} nuclei, max centroid err ${maxCentroidErr.toExponential(2)}, max mean rel err ${maxMeanRelErr.toExponential(2)})`,
  );
}

function checkNucleiCsv3D(csvText, wantNuclei, label) {
  const rows = csvText.trim().split("\n");
  const headerOk = rows[0] === "id,centroid_x,centroid_y,centroid_z,volume_vox,mean_intensity,probability";
  const countOk = rows.length - 1 === wantNuclei.length;
  let allMatch = headerOk && countOk;
  let maxCentroidErr = 0;
  let maxMeanRelErr = 0;
  if (allMatch) {
    for (let i = 0; i < wantNuclei.length; i += 1) {
      const [id, x, y, z, vol, mean] = rows[i + 1].split(",").map(Number);
      const [wantId, wantX, wantY, wantZ, wantVol, wantMean] = wantNuclei[i];
      const err = Math.max(Math.abs(x - wantX), Math.abs(y - wantY), Math.abs(z - wantZ));
      const mRel = Math.abs(mean - wantMean) / wantMean;
      maxCentroidErr = Math.max(maxCentroidErr, err);
      maxMeanRelErr = Math.max(maxMeanRelErr, mRel);
      if (id !== wantId || vol !== wantVol || err >= 5e-4 || mRel >= 1e-6) {
        allMatch = false;
        break;
      }
    }
  }
  check(
    allMatch,
    `${label}: 3D CSV matches Python StarDist3D reference (${rows.length - 1}/${wantNuclei.length} nuclei, max centroid err ${maxCentroidErr.toExponential(2)}, max mean rel err ${maxMeanRelErr.toExponential(2)})`,
  );
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

  // 2. 2D_versatile_fluo (dsb2018-nuclei, byte-exact match to Python StarDist 0.9.1)
  const outFluo = join(work, "fluo");
  const runFluo = runCliOffline([examplePaths.get("dsb2018-nuclei"), outFluo, "--model", "2D_versatile_fluo", "--offline"]);
  check(runFluo.status === 0, `2D_versatile_fluo: CLI exits 0${runFluo.status ? ` (${runFluo.stderr.trim()})` : ""}`);
  const fluo = readLabelTiff(await readFile(join(outFluo, "dsb2018-nuclei-2d_stardist_labels.tif")));
  const fluoHash = labelHash(fluo.labels);
  check(
    fluo.height === reference.shape[0] && fluo.width === reference.shape[1] && fluo.depth === 1,
    `2D_versatile_fluo: label TIFF is ${fluo.width}x${fluo.height}`,
  );
  check(
    fluoHash === reference.example["1x1"].labels_sha256,
    `2D_versatile_fluo: label mask SHA-256 matches Python StarDist 0.9.1 (${fluoHash.slice(0, 12)})`,
  );
  const fluoCsv = await readFile(join(outFluo, "dsb2018-nuclei-2d_stardist_nuclei.csv"), "utf8");
  checkNucleiCsv2D(
    fluoCsv,
    reference.example["1x1"].nuclei,
    "2D_versatile_fluo",
  );
  checkCsvAgainstMask2D(fluoCsv, fluo, "2D_versatile_fluo");

  // 3. 2D_versatile_he (skin-he-nuclei, byte-exact match to Python StarDist 0.9.1)
  const outHe = join(work, "he");
  const runHe = runCliOffline([examplePaths.get("skin-he-nuclei"), outHe, "--model", "2D_versatile_he", "--offline"]);
  check(runHe.status === 0, `2D_versatile_he: CLI exits 0${runHe.status ? ` (${runHe.stderr.trim()})` : ""}`);
  const he = readLabelTiff(await readFile(join(outHe, "skin-he-nuclei-2d_stardist_labels.tif")));
  const heHash = labelHash(he.labels);
  check(
    he.height === reference.he.shape[0] && he.width === reference.he.shape[1] && he.depth === 1,
    `2D_versatile_he: label TIFF is ${he.width}x${he.height}`,
  );
  check(
    heHash === reference.he.labels_sha256,
    `2D_versatile_he: label mask SHA-256 matches Python StarDist 0.9.1 (${heHash.slice(0, 12)})`,
  );
  const heCsv = await readFile(join(outHe, "skin-he-nuclei-2d_stardist_nuclei.csv"), "utf8");
  checkNucleiCsv2D(
    heCsv,
    reference.he.nuclei,
    "2D_versatile_he",
    { centroidTol: 6e-4, meanRelTol: 1e-5 },
  );
  checkCsvAgainstMask2D(heCsv, he, "2D_versatile_he");

  // 4. 2D_paper_dsb2018 (dsb2018-nuclei, byte-exact match to Python StarDist 0.9.1)
  const outPaper = join(work, "paper");
  const runPaper = runCliOffline([examplePaths.get("dsb2018-nuclei"), outPaper, "--model", "2D_paper_dsb2018", "--offline"]);
  check(runPaper.status === 0, `2D_paper_dsb2018: CLI exits 0${runPaper.status ? ` (${runPaper.stderr.trim()})` : ""}`);
  const paper = readLabelTiff(await readFile(join(outPaper, "dsb2018-nuclei-2d_stardist_labels.tif")));
  const paperHash = labelHash(paper.labels);
  const paperCsv = await readFile(join(outPaper, "dsb2018-nuclei-2d_stardist_nuclei.csv"), "utf8");
  const paperRows = paperCsv.trim().split("\n");
  check(
    paperHash === reference.paper_dsb2018.labels_sha256 && paperRows.length - 1 === reference.paper_dsb2018.count,
    `2D_paper_dsb2018: label mask SHA-256 (${paperHash.slice(0, 12)}) and count (${paperRows.length - 1}) match Python StarDist 0.9.1`,
  );
  checkCsvAgainstMask2D(paperCsv, paper, "2D_paper_dsb2018");

  // 5. 3D_demo (stardist-3d-demo, byte-exact match to Python StarDist3D 0.9.1)
  const out3d = join(work, "demo3d");
  const run3d = runCliOffline([examplePaths.get("stardist-3d-demo"), out3d, "--model", "3D_demo", "--offline"]);
  check(run3d.status === 0, `3D_demo: CLI exits 0${run3d.status ? ` (${run3d.stderr.trim()})` : ""}`);
  const d3 = readLabelTiff(await readFile(join(out3d, "stardist-demo-nuclei-3d_stardist_labels.tif")));
  const d3Want = reference.demo_3d.example["1x1x1"];
  const d3Hash = labelHash(d3.labels);
  check(
    d3.depth === reference.demo_3d.shape[0] && d3.height === reference.demo_3d.shape[1] && d3.width === reference.demo_3d.shape[2],
    `3D_demo: label stack is ${d3.width}x${d3.height}x${d3.depth}`,
  );
  check(
    d3Hash === d3Want.labels_sha256,
    `3D_demo: label mask SHA-256 matches Python StarDist3D 0.9.1 (${d3Hash.slice(0, 12)})`,
  );
  const d3Csv = await readFile(join(out3d, "stardist-demo-nuclei-3d_stardist_nuclei.csv"), "utf8");
  checkNucleiCsv3D(
    d3Csv,
    d3Want.nuclei,
    "3D_demo",
  );
  checkCsvAgainstMask3D(d3Csv, d3, "3D_demo");
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log(`network_isolation=${canUnshare ? "unshare-rn" : "fallback"}`);
console.log(`\nAll @neurodesk/stardist portable CLI checks passed (${canUnshare ? "unshare -rn" : "fallback"}).`);
