import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { checkInstallation, claimOutputDir, commitOutputs, detectSpotsFile, LOCK_NAME, parseCliOptions } from "../src/node.js";
import { syntheticImage } from "../src/synthetic.js";
import { niftiBuffer } from "../src/volumes.js";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, "../bin/spot-detection.js");

function writeUncompressedTiff(shape, dtype, data) {
  const is3d = shape.length === 3;
  const [depth, height, width] = is3d ? shape : [1, shape[0], shape[1]];
  const bitsPerSample = dtype === "uint8" ? 8 : 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleFormat = 1;
  const slicePixels = height * width;
  const sliceBytes = slicePixels * bytesPerSample;
  const numTags = 9;
  const ifdSize = 2 + numTags * 12 + 4;
  const headerSize = 8;
  const ifdsOffset = headerSize;
  const dataOffset = ifdsOffset + depth * ifdSize;
  const totalBytes = dataOffset + depth * sliceBytes;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  const u8 = new Uint8Array(buf);

  view.setUint8(0, 0x49);
  view.setUint8(1, 0x49);
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdsOffset, true);

  for (let z = 0; z < depth; z += 1) {
    let off = ifdsOffset + z * ifdSize;
    const stripOff = dataOffset + z * sliceBytes;
    view.setUint16(off, numTags, true);
    off += 2;
    const writeTag = (tag, type, count, value) => {
      view.setUint16(off, tag, true);
      view.setUint16(off + 2, type, true);
      view.setUint32(off + 4, count, true);
      if (type === 3) view.setUint16(off + 8, value, true);
      else view.setUint32(off + 8, value, true);
      off += 12;
    };
    writeTag(256, 4, 1, width);
    writeTag(257, 4, 1, height);
    writeTag(258, 3, 1, bitsPerSample);
    writeTag(259, 3, 1, 1);
    writeTag(262, 3, 1, 1);
    writeTag(273, 4, 1, stripOff);
    writeTag(277, 3, 1, 1);
    writeTag(278, 4, 1, height);
    writeTag(279, 4, 1, sliceBytes);
    const nextIfd = z + 1 < depth ? ifdsOffset + (z + 1) * ifdSize : 0;
    view.setUint32(off, nextIfd, true);

    const src = new Uint8Array(data.buffer, data.byteOffset + z * sliceBytes, sliceBytes);
    u8.set(src, stripOff);
  }
  return Buffer.from(buf);
}

test("strict CLI option validation rejects empty strings, invalid numbers, and disallowed subcommand flags", () => {
  assert.throws(() => parseCliOptions({ labels: "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ "voxel-z": "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ "voxel-z": "0" }), /greater than 0/);
  assert.throws(() => parseCliOptions({ "voxel-yx": "-10" }), /greater than 0/);
  assert.throws(() => parseCliOptions({ "radius-z": "NaN" }), /finite number/);
  assert.throws(() => parseCliOptions({ threshold: "-1" }), /at least 0/);

  const badSelfCheck = spawnSync(process.execPath, [binPath, "self-check", "--threshold", "10"], { encoding: "utf8" });
  assert.notEqual(badSelfCheck.status, 0);
  assert.match(badSelfCheck.stderr, /not allowed with self-check/);

  const emptyCache = spawnSync(process.execPath, [binPath, "self-check", "--cache-dir="], { encoding: "utf8" });
  assert.notEqual(emptyCache.status, 0);
  assert.match(emptyCache.stderr, /non-empty/);
});

test("self-check prints valid JSON and honors --cache-dir", async () => {
  const res = await checkInstallation({ cacheDir: "/tmp/custom-cache" });
  assert.equal(res.ok, true);
  assert.equal(res.spotsRecovered, 12);
  assert.equal(res.threshold, 30);
  assert.equal(res.cacheDir, resolve("/tmp/custom-cache"));

  const cli = spawnSync(process.execPath, [binPath, "self-check", "--cache-dir", "/tmp/cache-dir"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cacheDir, resolve("/tmp/cache-dir"));
});

test("detectSpotsFile processes synthetic 3D stack with cell labels offline and writes valid outputs", async () => {
  const work = mkdtempSync(join(tmpdir(), "spot-detection-test-"));
  try {
    const synth = syntheticImage([12, 64, 72], 40, 7);
    const imagePath = join(work, "synth_3d.tif");
    writeFileSync(imagePath, writeUncompressedTiff(synth.shape, synth.dtype, synth.data));

    const labelData = new Uint16Array(64 * 72);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 72; x += 1) {
        labelData[y * 72 + x] = y < 32 ? 1 : 2;
      }
    }
    const labelsPath = join(work, "cells_2d.tif");
    writeFileSync(labelsPath, writeUncompressedTiff([64, 72], "uint16", labelData));

    const outDir = join(work, "out");
    const run = await detectSpotsFile({
      input: imagePath,
      outputDir: outDir,
      options: { labels: labelsPath, "voxel-z": "300", "voxel-yx": "103", "radius-z": "350", "radius-yx": "150" },
    });

    assert.equal(run.spots, 38);
    assert.equal(run.threshold, 10);
    const files = readdirSync(outDir).sort();
    assert.deepEqual(files, [
      "synth_3d_cell_counts.csv",
      "synth_3d_provenance.json",
      "synth_3d_spots.csv",
      "synth_3d_spots.nii.gz",
    ]);

    const cellCsv = readFileSync(join(outDir, "synth_3d_cell_counts.csv"), "utf8");
    assert.match(cellCsv, /^cell_id,spots,area_px/m);
    const cellRows = cellCsv
      .trim()
      .split("\n")
      .slice(1)
      .map((line) => line.split(",").map(Number))
      .filter((row) => row[0] > 0);
    assert.equal(cellRows.length, 2);
    assert.equal(cellRows[0][1] + cellRows[1][1], 38);

    const gz = readFileSync(join(outDir, "synth_3d_spots.nii.gz"));
    const nii = gunzipSync(gz, { maxOutputLength: 10 * 1024 * 1024 });
    const dv = new DataView(nii.buffer, nii.byteOffset, nii.byteLength);
    assert.equal(dv.getInt32(0, true), 348);
    assert.equal(dv.getInt16(42, true), 72);
    assert.equal(dv.getInt16(44, true), 64);
    assert.equal(dv.getInt16(46, true), 12);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("output directory lock prevents concurrent runs, cleans up created dirs on failure, and rolls back rename errors", async () => {
  const work = mkdtempSync(join(tmpdir(), "spot-detection-lock-"));
  try {
    const outDir = join(work, "nested", "out");
    await assert.rejects(
      () => claimOutputDir(outDir, { readdirFn: async () => { throw new Error("boom readdir"); } }),
      /boom readdir/,
    );
    assert.deepEqual(readdirSync(work), [], "newly created directories must be cleaned up on claim error");

    const reservation = await claimOutputDir(outDir);
    await assert.rejects(() => claimOutputDir(outDir), /locked by another/);
    await reservation.release({ removeCreated: false });

    writeFileSync(join(outDir, "a.csv"), "old-a");
    writeFileSync(join(outDir, "b.csv"), "old-b");
    let renameCalls = 0;
    await assert.rejects(
      () => commitOutputs(
        outDir,
        [
          { name: "a.csv", data: Buffer.from("new-a") },
          { name: "b.csv", data: Buffer.from("new-b") },
        ],
        {
          overwrite: true,
          renameFn: async (src, dst) => {
            renameCalls += 1;
            if (renameCalls === 4) throw new Error("simulated rename failure");
            const { rename } = await import("node:fs/promises");
            await rename(src, dst);
          },
        },
      ),
      /simulated rename failure/,
    );
    assert.equal(readFileSync(join(outDir, "a.csv"), "utf8"), "old-a");
    assert.equal(readFileSync(join(outDir, "b.csv"), "utf8"), "old-b");
    assert.deepEqual(readdirSync(outDir).sort(), ["a.csv", "b.csv"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("rejects float32-overflowing spacing/radii (1e46) in CLI options and niftiBuffer", () => {
  assert.throws(
    () => parseCliOptions({ "voxel-yx": "1e46", "radius-yx": "1e46" }),
    /float32/,
  );
  assert.throws(
    () => parseCliOptions({ "voxel-z": "1e-45" }),
    /float32/,
  );
  assert.throws(
    () => niftiBuffer({ shape: [1, 8, 8], data: new Uint8Array(64) }, [300, 1e46, 1e46]),
    /float32/,
  );
});

test("strict Node API validation, cross-CLI shared lock, and failed-write .partial cleanup", async () => {
  const work = mkdtempSync(join(tmpdir(), "spot-detection-strict-"));
  try {
    assert.throws(() => parseCliOptions({ bogus: "1" }), /Unknown option/);
    assert.throws(() => parseCliOptions({ overwrite: "false" }), /must be a boolean/);
    assert.throws(() => parseCliOptions({ projection: "true" }), /must be a boolean/);
    assert.throws(() => parseCliOptions({ noSubpixel: "false" }), /must be a boolean/);
    await assert.rejects(() => checkInstallation({ cacheDir: "" }), /non-empty/);
    await assert.rejects(() => checkInstallation({ extra: 1 }), /Unknown option/);

    const prevOffline = process.env.NEURODESK_OFFLINE;
    try {
      process.env.NEURODESK_OFFLINE = "1";
      assert.throws(() => parseCliOptions({ offline: false }), /NEURODESK_OFFLINE=1/);
    } finally {
      if (prevOffline === undefined) delete process.env.NEURODESK_OFFLINE;
      else process.env.NEURODESK_OFFLINE = prevOffline;
    }

    // Cross-CLI contention: if deconvolution (or another CLI) holds .neurodesk-cli.lock, spot-detection is blocked
    const { claimOutputDir: claimDeconv } = await import("../../deconvolution/src/node.js");
    const sharedDir = join(work, "shared-out");
    const deconvRes = await claimDeconv(sharedDir, { overwrite: true });
    try {
      assert.equal(LOCK_NAME, ".neurodesk-cli.lock");
      await assert.rejects(() => claimOutputDir(sharedDir, { overwrite: true }), /locked by another/);
    } finally {
      await deconvRes.release({ removeCreated: false });
    }

    // Failed write (simulated EFBIG) still unlinks .partial
    await assert.rejects(
      () => commitOutputs(sharedDir, [{ name: "out.csv", data: Buffer.from("abc") }], {
        writeFileFn: async (p) => {
          writeFileSync(p, "a");
          throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });
        },
      }),
      /EFBIG/,
    );
    assert.deepEqual(readdirSync(sharedDir), []);

    // Sol r2: non-plain options, unknown undefined keys, inherited props, null aliases, symlink refusal, TOCTOU non-overwrite
    assert.throws(() => parseCliOptions(new Date()), /plain object/);
    assert.throws(() => parseCliOptions(Object.create({ overwrite: true })), /plain object/);
    assert.throws(() => parseCliOptions({ unknownKey: undefined }), /Unknown option/);
    assert.throws(() => parseCliOptions({ "no-subpixel": null }), /must be a boolean/);
    await assert.rejects(() => checkInstallation(new Date()), /plain object/);
    await assert.rejects(() => checkInstallation({ extra: undefined }), /Unknown option/);

    const { symlinkSync, readFileSync: rfSync, mkdirSync: mdSync } = await import("node:fs");
    writeFileSync(join(work, "target.csv"), "precious");
    symlinkSync(join(work, "target.csv"), join(sharedDir, "sym.csv"));
    await assert.rejects(
      () => commitOutputs(sharedDir, [{ name: "sym.csv", data: Buffer.from("x") }], { overwrite: true }),
      /symbolic link/,
    );
    assert.equal(rfSync(join(work, "target.csv"), "utf8"), "precious");

    const raceDir = join(work, "race");
    mdSync(raceDir);
    await assert.rejects(
      () => commitOutputs(raceDir, [{ name: "out.csv", data: Buffer.from("new") }], {
        overwrite: false,
        writeFileFn: async (p, data) => {
          writeFileSync(p, data);
          writeFileSync(join(raceDir, "out.csv"), "winner");
        },
      }),
      /already exists/,
    );
    assert.equal(rfSync(join(raceDir, "out.csv"), "utf8"), "winner");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
