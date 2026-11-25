// Offline tests for @neurodesk/dermvit CLI, raster decoding, locking, self-check, and manifest sync.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import {
  checkInstallation,
  classifyFile,
  downloadModels,
  publishOutputs,
  reserveOutputDir,
  resolveThreads,
} from "../src/node.js";
import { decodeRasterBytes } from "../src/raster.js";

const BIN = fileURLToPath(new URL("../bin/dermvit.js", import.meta.url));

const PNG_SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function buildCustomPng(ihdrParams, extraChunks, rawScanlines) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(ihdrParams.width, 0);
  ihdr.writeUInt32BE(ihdrParams.height, 4);
  ihdr[8] = ihdrParams.depth;
  ihdr[9] = ihdrParams.colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = ihdrParams.interlace ?? 0;
  return Buffer.concat([
    PNG_SIG,
    pngChunk("IHDR", ihdr),
    ...extraChunks,
    pngChunk("IDAT", deflateSync(rawScanlines)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function makeFakeIccProfile(description, colorSpace = "RGB ") {
  const header = Buffer.alloc(128, 0);
  Buffer.from(colorSpace, "ascii").copy(header, 16);
  const descAscii = Buffer.from(`${description}\0`, "ascii");
  const descTag = Buffer.alloc(12 + descAscii.length, 0);
  Buffer.from("desc", "ascii").copy(descTag, 0);
  descTag.writeUInt32BE(descAscii.length, 8);
  descAscii.copy(descTag, 12);
  const tagTable = Buffer.alloc(4 + 12);
  tagTable.writeUInt32BE(1, 0);
  Buffer.from("desc", "ascii").copy(tagTable, 4);
  tagTable.writeUInt32BE(128 + tagTable.length, 8);
  tagTable.writeUInt32BE(descTag.length, 12);
  const profile = Buffer.concat([header, tagTable, descTag]);
  profile.writeUInt32BE(profile.length, 0);
  return profile;
}

function injectJpegSegment(jpegBytes, markerByte, payload) {
  const seg = Buffer.alloc(4 + payload.length);
  seg[0] = 0xff;
  seg[1] = markerByte;
  seg.writeUInt16BE(payload.length + 2, 2);
  Buffer.from(payload).copy(seg, 4);
  return Buffer.concat([Buffer.from(jpegBytes.subarray(0, 2)), seg, Buffer.from(jpegBytes.subarray(2))]);
}

function makeExifOrientationPayload(orientation, { littleEndian = false } = {}) {
  const header = Buffer.from("Exif\0\0", "ascii");
  const tiff = Buffer.alloc(26, 0);
  if (littleEndian) {
    tiff.write("II", 0, "ascii");
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
  } else {
    tiff.write("MM", 0, "ascii");
    tiff.writeUInt16BE(42, 2);
    tiff.writeUInt32BE(8, 4);
    tiff.writeUInt16BE(1, 8);
    tiff.writeUInt16BE(0x0112, 10);
    tiff.writeUInt16BE(3, 12);
    tiff.writeUInt32BE(1, 14);
    tiff.writeUInt16BE(orientation, 18);
  }
  return Buffer.concat([header, tiff]);
}

test("package model.manifest.json stays identical to models/dermvit.manifest.json", async () => {
  const pkgManifest = await readFile(new URL("../model.manifest.json", import.meta.url), "utf8");
  const repoManifest = await readFile(new URL("../../../models/dermvit.manifest.json", import.meta.url), "utf8");
  assert.equal(pkgManifest, repoManifest);
});

test("decodeRasterBytes decodes PNG (RGBA/RGB/gray) and JPEG cleanly and rejects non-images", () => {
  const rgbaPng = encodePng({
    width: 2,
    height: 2,
    channels: 4,
    depth: 8,
    data: new Uint8Array([10, 20, 30, 255, 40, 50, 60, 128, 70, 80, 90, 255, 100, 110, 120, 255]),
  });
  const decRgba = decodeRasterBytes(rgbaPng, { name: "a.png" });
  assert.equal(decRgba.format, "png");
  assert.equal(decRgba.width, 2);
  assert.equal(decRgba.height, 2);
  assert.equal(decRgba.rgba[0], 10);
  assert.equal(decRgba.rgba[7], 128);

  const grayPng = encodePng({ width: 2, height: 1, channels: 1, depth: 8, data: new Uint8Array([50, 200]) });
  const decGray = decodeRasterBytes(grayPng, { name: "g.png" });
  assert.deepEqual(Array.from(decGray.rgba), [50, 50, 50, 255, 200, 200, 200, 255]);

  const jpg = jpeg.encode(
    {
      width: 2,
      height: 2,
      data: Buffer.from([200, 100, 50, 255, 100, 150, 200, 255, 50, 50, 50, 255, 250, 250, 250, 255]),
    },
    95,
  );
  const decJpg = decodeRasterBytes(jpg.data, { name: "b.jpg" });
  assert.equal(decJpg.format, "jpeg");
  assert.equal(decJpg.width, 2);
  assert.equal(decJpg.height, 2);
  assert.equal(decJpg.rgba.length, 16);

  assert.throws(() => decodeRasterBytes(new Uint8Array([1, 2, 3, 4]), { name: "bad.bin" }), /not a PNG or JPEG/);
});

test("decodeRasterBytes handles indexed+tRNS, RGB+tRNS, gray+tRNS, 1-bit Adam7 PNGs and rejects bad IDAT CRC", () => {
  // 1. Indexed PNG + tRNS: palette[0] = red transparent (alpha 0), palette[1] = green opaque (alpha 255)
  const indexedPng = buildCustomPng(
    { width: 2, height: 1, depth: 8, colorType: 3 },
    [pngChunk("PLTE", Buffer.from([255, 0, 0, 0, 255, 0])), pngChunk("tRNS", Buffer.from([0, 255]))],
    Buffer.from([0, 0, 1]),
  );
  const decIdx = decodeRasterBytes(indexedPng, { name: "indexed-trns.png" });
  assert.deepEqual(Array.from(decIdx.rgba), [255, 0, 0, 0, 0, 255, 0, 255]);

  // 2. Truecolor RGB PNG + tRNS color key (10, 20, 30) -> transparent, (40, 50, 60) -> opaque
  const trnsRgb = Buffer.alloc(6);
  trnsRgb.writeUInt16BE(10, 0);
  trnsRgb.writeUInt16BE(20, 2);
  trnsRgb.writeUInt16BE(30, 4);
  const rgbTrnsPng = buildCustomPng(
    { width: 2, height: 1, depth: 8, colorType: 2 },
    [pngChunk("tRNS", trnsRgb)],
    Buffer.from([0, 10, 20, 30, 40, 50, 60]),
  );
  const decRgbTrns = decodeRasterBytes(rgbTrnsPng, { name: "rgb-trns.png" });
  assert.equal(decRgbTrns.rgba[3], 0);
  assert.deepEqual(Array.from(decRgbTrns.rgba.subarray(4, 8)), [40, 50, 60, 255]);

  // 3. Grayscale PNG + tRNS color key (77)
  const trnsGray = Buffer.alloc(2);
  trnsGray.writeUInt16BE(77, 0);
  const grayTrnsPng = buildCustomPng(
    { width: 2, height: 1, depth: 8, colorType: 0 },
    [pngChunk("tRNS", trnsGray)],
    Buffer.from([0, 77, 200]),
  );
  const decGrayTrns = decodeRasterBytes(grayTrnsPng, { name: "gray-trns.png" });
  assert.equal(decGrayTrns.rgba[3], 0);
  assert.deepEqual(Array.from(decGrayTrns.rgba.subarray(4, 8)), [200, 200, 200, 255]);

  // 4. 1-bit Adam7 interlaced 4x4 PNG (only passes 1, 4, 5, 6, 7 have pixels for 4x4)
  // Pattern: (0,0)=1, (2,0)=0, (0,2)=0, (2,2)=1 -> check exact coordinates
  // Pass 1 (x=0,y=0): 1x1 -> [0, 0x80]
  // Pass 2 (x=4): empty
  // Pass 3 (y=4): empty
  // Pass 4 (x=2,y=0): 1x1 -> [0, 0x00]
  // Pass 5 (x=0,2; y=2): 2x1 -> bits [0,1] = 0x40 -> [0, 0x40]
  // Pass 6 (x=1,3; y=0,2): 2x2 -> all 0 -> [0, 0x00, 0, 0x00]
  // Pass 7 (x=0..3; y=1,3): 4x2 -> all 0 -> [0, 0x00, 0, 0x00]
  const adam7Scanlines = Buffer.from([0, 0x80, 0, 0x00, 0, 0x40, 0, 0x00, 0, 0x00, 0, 0x00, 0, 0x00]);
  const adam7Png = buildCustomPng(
    { width: 4, height: 4, depth: 1, colorType: 0, interlace: 1 },
    [],
    adam7Scanlines,
  );
  const decAdam7 = decodeRasterBytes(adam7Png, { name: "adam7-1bit.png" });
  assert.equal(decAdam7.width, 4);
  assert.equal(decAdam7.height, 4);
  assert.equal(decAdam7.rgba[(0 * 4 + 0) * 4], 255);
  assert.equal(decAdam7.rgba[(0 * 4 + 2) * 4], 0);
  assert.equal(decAdam7.rgba[(2 * 4 + 0) * 4], 0);
  assert.equal(decAdam7.rgba[(2 * 4 + 2) * 4], 255);

  // 5. Corrupted IDAT CRC must be rejected
  const corrupt = Buffer.from(indexedPng);
  const idatIdx = corrupt.indexOf(Buffer.from("IDAT", "ascii"));
  const idatLen = corrupt.readUInt32BE(idatIdx - 4);
  corrupt[idatIdx + 4 + idatLen] ^= 0xff;
  assert.throws(() => decodeRasterBytes(corrupt, { name: "corrupt-crc.png" }), /CRC|crc/i);
});

test("decodeRasterBytes converts PNG linear gAMA to sRGB, rejects non-sRGB ICC, and applies JPEG EXIF orientation", () => {
  // 1. Linear gAMA (1.0 = 100000) without sRGB/iCCP raises mid-grey 128 (~0.502) to sRGB ~188
  const gamaData = Buffer.alloc(4);
  gamaData.writeUInt32BE(100000, 0);
  const linearPng = buildCustomPng(
    { width: 1, height: 1, depth: 8, colorType: 6 },
    [pngChunk("gAMA", gamaData)],
    Buffer.from([0, 128, 128, 128, 200]),
  );
  const decLin = decodeRasterBytes(linearPng, { name: "linear.png" });
  assert.equal(decLin.gammaApplied, 1);
  assert.ok(decLin.rgba[0] >= 186 && decLin.rgba[0] <= 190, `expected ~188, got ${decLin.rgba[0]}`);
  assert.equal(decLin.rgba[3], 200);

  // 2. Non-sRGB PNG iCCP (Display P3) rejected; sRGB iCCP accepted
  const p3Profile = makeFakeIccProfile("Display P3");
  const p3Iccp = Buffer.concat([Buffer.from("Display P3\0", "ascii"), Buffer.from([0]), deflateSync(p3Profile)]);
  const p3Png = buildCustomPng(
    { width: 1, height: 1, depth: 8, colorType: 2 },
    [pngChunk("iCCP", p3Iccp)],
    Buffer.from([0, 100, 100, 100]),
  );
  assert.throws(() => decodeRasterBytes(p3Png, { name: "p3.png" }), /non-sRGB ICC/);

  const srgbProfile = makeFakeIccProfile("sRGB IEC61966-2.1");
  const srgbIccp = Buffer.concat([Buffer.from("sRGB\0", "ascii"), Buffer.from([0]), deflateSync(srgbProfile)]);
  const srgbPng = buildCustomPng(
    { width: 1, height: 1, depth: 8, colorType: 2 },
    [pngChunk("iCCP", srgbIccp)],
    Buffer.from([0, 100, 100, 100]),
  );
  const decSrgb = decodeRasterBytes(srgbPng, { name: "srgb.png" });
  assert.equal(decSrgb.rgba[0], 100);

  // 3. JPEG with non-sRGB APP2 ICC_PROFILE rejected
  const baseJpg = jpeg.encode({ width: 16, height: 8, data: Buffer.alloc(16 * 8 * 4, 180) }, 95).data;
  const app2P3 = Buffer.concat([Buffer.from("ICC_PROFILE\0", "ascii"), Buffer.from([1, 1]), p3Profile]);
  const p3Jpg = injectJpegSegment(baseJpg, 0xe2, app2P3);
  assert.throws(() => decodeRasterBytes(p3Jpg, { name: "p3.jpg" }), /non-sRGB ICC/);

  // 4. JPEG with EXIF Orientation 6 (90° CW): landscape 16x8 with bright red top-left 8x8 -> portrait 8x16 with bright red top-right
  const landRgba = Buffer.alloc(16 * 8 * 4);
  for (let y = 0; y < 8; y += 1) {
    for (let x = 0; x < 16; x += 1) {
      const o = (y * 16 + x) * 4;
      const isLeft = x < 8;
      landRgba[o] = isLeft ? 240 : 20;
      landRgba[o + 1] = isLeft ? 20 : 20;
      landRgba[o + 2] = isLeft ? 20 : 240;
      landRgba[o + 3] = 255;
    }
  }
  const landJpg = jpeg.encode({ width: 16, height: 8, data: landRgba }, 98).data;
  const rotJpg = injectJpegSegment(landJpg, 0xe1, makeExifOrientationPayload(6, { littleEndian: true }));
  const decRot = decodeRasterBytes(rotJpg, { name: "rot6.jpg" });
  assert.equal(decRot.exifOrientation, 6);
  assert.equal(decRot.width, 8);
  assert.equal(decRot.height, 16);
  // Top half (y=2, x=4) came from original left half (red); bottom half (y=13, x=4) came from original right half (blue).
  const topPx = (2 * 8 + 4) * 4;
  const botPx = (13 * 8 + 4) * 4;
  assert.ok(decRot.rgba[topPx] > 180 && decRot.rgba[topPx + 2] < 80, "top half should be red after 90° CW rotation");
  assert.ok(decRot.rgba[botPx + 2] > 180 && decRot.rgba[botPx] < 80, "bottom half should be blue after 90° CW rotation");
});

test("reserveOutputDir enforces O_EXCL locking and publishOutputs rolls back on mid-commit failure", async () => {
  const work = await mkdtemp(join(tmpdir(), "dermvit-lock-"));
  try {
    const outDir = join(work, "fresh-out");
    const first = await reserveOutputDir(outDir, { overwrite: false, tool: "dermvit" });
    await assert.rejects(
      () => reserveOutputDir(outDir, { overwrite: true, tool: "dermvit" }),
      /locked by another dermvit run/,
    );
    // Lock file must still exist after rejected second contender
    await stat(first.lockPath);
    await first.release({ removeIfEmpty: true });
    // Newly created empty dir should be cleaned up on abort
    await assert.rejects(() => stat(outDir), { code: "ENOENT" });

    // Rollback test: existing file is preserved and newly created file is removed if a later rename fails
    const txDir = join(work, "tx");
    await mkdir(txDir);
    await writeFile(join(txDir, "a.txt"), "original-a");
    // Create a directory at target "b.txt" so renaming a file onto it fails with EISDIR/EPERM
    await mkdir(join(txDir, "b.txt"));
    await assert.rejects(
      () =>
        publishOutputs(
          txDir,
          [
            { name: "a.txt", bytes: Buffer.from("new-a") },
            { name: "c.txt", bytes: Buffer.from("new-c") },
            { name: "b.txt", bytes: Buffer.from("new-b") },
          ],
          { overwrite: true },
        ),
    );
    assert.equal(await readFile(join(txDir, "a.txt"), "utf8"), "original-a");
    const entries = await readdir(txDir);
    assert.deepEqual(entries.sort(), ["a.txt", "b.txt"]);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("checkInstallation executes ONNX Runtime CPU identity graph offline", async () => {
  const report = await checkInstallation();
  assert.equal(report.ok, true);
  assert.equal(report.executable, process.execPath);
  assert.equal(report.node, process.version);
  assert.equal(report.executionProvider, "cpu");
  assert.match(report.onnxRuntime, /^\d+\.\d+\.\d+/);
});

test("offline mode rejects missing or corrupted cached models and cleans up created output dir", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dermvit-offline-"));
  try {
    await assert.rejects(
      () => downloadModels({ cacheDir: dir, offline: true }),
      /missing from the offline model directory/,
    );
    await writeFile(join(dir, "model_quantized.onnx"), Buffer.from("corrupt"));
    await assert.rejects(
      () => downloadModels({ cacheDir: dir, offline: true }),
      /failed checksum verification/,
    );
    const pngPath = join(dir, "sample.png");
    const missingOut = join(dir, "out");
    await writeFile(pngPath, encodePng({ width: 4, height: 4, channels: 4, depth: 8, data: new Uint8Array(64).fill(180) }));
    await assert.rejects(
      () => classifyFile({ input: pngPath, outputDir: missingOut, cacheDir: dir, offline: true }),
      /failed checksum verification/,
    );
    await assert.rejects(() => stat(missingOut), { code: "ENOENT" });

    // self-check --cache-dir DIR must verify models in DIR offline
    const badCheck = spawnSync(process.execPath, [BIN, "self-check", "--cache-dir", dir], { encoding: "utf8" });
    assert.notEqual(badCheck.status, 0);
    assert.match(badCheck.stderr, /failed checksum verification/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI --help, self-check, per-subcommand option validation, and empty flag rejection", () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: dermvit INPUT OUTPUT_DIR/);

  const selfCheck = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(selfCheck.status, 0, selfCheck.stderr);
  const parsed = JSON.parse(selfCheck.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.executable, process.execPath);

  const badSelfFlag = spawnSync(process.execPath, [BIN, "self-check", "--saliency"], { encoding: "utf8" });
  assert.notEqual(badSelfFlag.status, 0);
  assert.match(badSelfFlag.stderr, /--saliency is not valid with self-check/);

  const emptyCache = spawnSync(process.execPath, [BIN, "self-check", "--cache-dir="], { encoding: "utf8" });
  assert.notEqual(emptyCache.status, 0);
  assert.match(emptyCache.stderr, /--cache-dir requires a non-empty value/);

  const badDlFlag = spawnSync(process.execPath, [BIN, "download-models", "--color-constancy"], { encoding: "utf8" });
  assert.notEqual(badDlFlag.status, 0);
  assert.match(badDlFlag.stderr, /--color-constancy is not valid with download-models/);

  const emptyThreads = spawnSync(process.execPath, [BIN, "a.png", "out", "--threads="], { encoding: "utf8" });
  assert.notEqual(emptyThreads.status, 0);
  assert.match(emptyThreads.stderr, /--threads requires a non-empty value/);

  assert.equal(resolveThreads("2"), 2);
  assert.throws(() => resolveThreads("0"), /positive integer/);
  assert.throws(() => resolveThreads("abc"), /positive integer/);
  assert.throws(() => resolveThreads(""), /positive integer/);
});
