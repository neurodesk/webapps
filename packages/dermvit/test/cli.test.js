// Offline tests for @neurodesk/dermvit CLI, raster decoding, locking, self-check, and manifest sync.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import {
  SHARED_OUTPUT_LOCK,
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

const SRGB_PRIMARIES = {
  rXYZ: [0.4361, 0.2225, 0.0139],
  gXYZ: [0.3851, 0.7169, 0.0971],
  bXYZ: [0.1431, 0.0606, 0.7141],
};

const ADOBE_RGB_PRIMARIES = {
  rXYZ: [0.6097, 0.3111, 0.0195],
  gXYZ: [0.2053, 0.6257, 0.0609],
  bXYZ: [0.1492, 0.0632, 0.7446],
};

function makeXyzTag([x, y, z]) {
  const buf = Buffer.alloc(20, 0);
  Buffer.from("XYZ ", "ascii").copy(buf, 0);
  buf.writeInt32BE(Math.round(x * 65536), 8);
  buf.writeInt32BE(Math.round(y * 65536), 12);
  buf.writeInt32BE(Math.round(z * 65536), 16);
  return buf;
}

function makeSrgbParaType3Tag() {
  const buf = Buffer.alloc(32, 0);
  Buffer.from("para", "ascii").copy(buf, 0);
  buf.writeUInt16BE(3, 8);
  buf.writeInt32BE(Math.round(2.4 * 65536), 12);
  buf.writeInt32BE(Math.round((1 / 1.055) * 65536), 16);
  buf.writeInt32BE(Math.round((0.055 / 1.055) * 65536), 20);
  buf.writeInt32BE(Math.round((1 / 12.92) * 65536), 24);
  buf.writeInt32BE(Math.round(0.04045 * 65536), 28);
  return buf;
}

function makeSrgbCurvLutTag(count = 256) {
  const buf = Buffer.alloc(12 + count * 2, 0);
  Buffer.from("curv", "ascii").copy(buf, 0);
  buf.writeUInt32BE(count, 8);
  for (let i = 0; i < count; i += 1) {
    const u = i / (count - 1);
    const linear = u <= 0.04045 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4);
    buf.writeUInt16BE(Math.round(linear * 65535), 12 + i * 2);
  }
  return buf;
}

function makePureGammaCurvTag(gamma = 2.2) {
  const buf = Buffer.alloc(14, 0);
  Buffer.from("curv", "ascii").copy(buf, 0);
  buf.writeUInt32BE(1, 8);
  buf.writeUInt16BE(Math.round(gamma * 256), 12);
  return buf;
}

function makePureGammaParaType0Tag(gamma = 2.2) {
  const buf = Buffer.alloc(16, 0);
  Buffer.from("para", "ascii").copy(buf, 0);
  buf.writeUInt16BE(0, 8);
  buf.writeInt32BE(Math.round(gamma * 65536), 12);
  return buf;
}

function makeFakeIccProfile(
  description,
  { colorSpace = "RGB ", primaries = SRGB_PRIMARIES, trcTag = makeSrgbParaType3Tag() } = {},
) {
  const header = Buffer.alloc(128, 0);
  Buffer.from(colorSpace, "ascii").copy(header, 16);
  Buffer.from("acsp", "ascii").copy(header, 36);

  const descAscii = Buffer.from(`${description}\0`, "ascii");
  const descTag = Buffer.alloc(12 + descAscii.length, 0);
  Buffer.from("desc", "ascii").copy(descTag, 0);
  descTag.writeUInt32BE(descAscii.length, 8);
  descAscii.copy(descTag, 12);

  const tagEntries = [["desc", descTag]];
  if (primaries) {
    tagEntries.push(["rXYZ", makeXyzTag(primaries.rXYZ)]);
    tagEntries.push(["gXYZ", makeXyzTag(primaries.gXYZ)]);
    tagEntries.push(["bXYZ", makeXyzTag(primaries.bXYZ)]);
  }
  if (trcTag) {
    if (colorSpace === "GRAY") {
      tagEntries.push(["kTRC", trcTag]);
    } else {
      tagEntries.push(["rTRC", trcTag]);
      tagEntries.push(["gTRC", trcTag]);
      tagEntries.push(["bTRC", trcTag]);
    }
  }

  const tagTable = Buffer.alloc(4 + tagEntries.length * 12);
  tagTable.writeUInt32BE(tagEntries.length, 0);
  let offset = 128 + tagTable.length;
  const tagBuffers = [];
  for (let i = 0; i < tagEntries.length; i += 1) {
    const [sig, buf] = tagEntries[i];
    const row = 4 + i * 12;
    Buffer.from(sig, "ascii").copy(tagTable, row);
    tagTable.writeUInt32BE(offset, row + 4);
    tagTable.writeUInt32BE(buf.length, row + 8);
    tagBuffers.push(buf);
    offset += buf.length;
  }

  const profile = Buffer.concat([header, tagTable, ...tagBuffers]);
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

test("decodeRasterBytes converts PNG gAMA (linear and 45455) to sRGB, validates ICC/cHRM strictly, and applies JPEG EXIF", () => {
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

  // 1b. gAMA = 45455 (pure 1/2.2 gamma without sRGB/iCCP) must STILL convert dark tones: sample 16 -> 7
  const gama45455 = Buffer.alloc(4);
  gama45455.writeUInt32BE(45455, 0);
  const darkGammaPng = buildCustomPng(
    { width: 1, height: 1, depth: 8, colorType: 6 },
    [pngChunk("gAMA", gama45455)],
    Buffer.from([0, 16, 16, 16, 255]),
  );
  const decDarkGamma = decodeRasterBytes(darkGammaPng, { name: "gamma45455.png" });
  assert.equal(decDarkGamma.gammaApplied, 0.45455);
  assert.equal(decDarkGamma.rgba[0], 7);
  assert.equal(decDarkGamma.rgba[3], 255);

  // 1c. 16-bit linear PNG (gAMA = 100000) with sample 128 must preserve 16-bit precision before 8-bit quantization -> 6 (not 0)
  const row16 = Buffer.alloc(1 + 8);
  row16[0] = 0;
  row16.writeUInt16BE(128, 1);
  row16.writeUInt16BE(128, 3);
  row16.writeUInt16BE(128, 5);
  row16.writeUInt16BE(65535, 7);
  const linear16Png = buildCustomPng(
    { width: 1, height: 1, depth: 16, colorType: 6 },
    [pngChunk("gAMA", gamaData)],
    row16,
  );
  const decLin16 = decodeRasterBytes(linear16Png, { name: "linear16.png" });
  assert.equal(decLin16.gammaApplied, 1);
  assert.equal(decLin16.rgba[0], 6);
  assert.equal(decLin16.rgba[3], 255);

  // 2. Non-sRGB PNG iCCP rejected even when disguised under iCCP keyword "sRGB" (Adobe RGB primaries)
  const makeIccpPng = (keyword, profile, { colorType = 2, scanline = Buffer.from([0, 100, 100, 100]) } = {}) =>
    buildCustomPng(
      { width: 1, height: 1, depth: 8, colorType },
      [pngChunk("iCCP", Buffer.concat([Buffer.from(`${keyword}\0`, "ascii"), Buffer.from([0]), deflateSync(profile)]))],
      scanline,
    );
  const makeGrayIccpPng = (keyword, profile) =>
    makeIccpPng(keyword, profile, { colorType: 0, scanline: Buffer.from([0, 100]) });

  const disguisedAdobeProfile = makeFakeIccProfile("sRGB", { primaries: ADOBE_RGB_PRIMARIES });
  assert.throws(() => decodeRasterBytes(makeIccpPng("sRGB", disguisedAdobeProfile), { name: "disguised-adobe.png" }), /non-sRGB ICC/);

  // 2b. sRGB primaries with missing TRC tags, pure gamma 2.2 curv (count=1), or para type 0 are ALL rejected
  const missingTrcProfile = makeFakeIccProfile("sRGB IEC61966-2.1", { primaries: SRGB_PRIMARIES, trcTag: null });
  assert.throws(() => decodeRasterBytes(makeIccpPng("sRGB", missingTrcProfile), { name: "missing-trc.png" }), /transfer curve/);

  const pureCurvProfile = makeFakeIccProfile("sRGB IEC61966-2.1", {
    primaries: SRGB_PRIMARIES,
    trcTag: makePureGammaCurvTag(2.2),
  });
  assert.throws(() => decodeRasterBytes(makeIccpPng("sRGB", pureCurvProfile), { name: "pure-curv.png" }), /transfer curve/);

  const pureParaProfile = makeFakeIccProfile("sRGB IEC61966-2.1", {
    primaries: SRGB_PRIMARIES,
    trcTag: makePureGammaParaType0Tag(2.2),
  });
  assert.throws(() => decodeRasterBytes(makeIccpPng("sRGB", pureParaProfile), { name: "pure-para.png" }), /transfer curve/);

  // 2-entry [0, 65535] curv LUT interpolates linearly (0.5 -> 0.5, not sRGB 0.214) and must be rejected.
  const linear2CurvTag = Buffer.alloc(16);
  linear2CurvTag.write("curv", 0, "ascii");
  linear2CurvTag.writeUInt32BE(2, 8);
  linear2CurvTag.writeUInt16BE(0, 12);
  linear2CurvTag.writeUInt16BE(65535, 14);
  const linear2RgbProfile = makeFakeIccProfile("sRGB IEC61966-2.1", {
    primaries: SRGB_PRIMARIES,
    trcTag: linear2CurvTag,
  });
  assert.throws(() => decodeRasterBytes(makeIccpPng("sRGB", linear2RgbProfile), { name: "linear2-rgb.png" }), /transfer curve/);
  const linear2GrayProfile = makeFakeIccProfile("sRGB Gray", {
    colorSpace: "GRAY",
    primaries: null,
    trcTag: linear2CurvTag,
  });
  assert.throws(() => decodeRasterBytes(makeGrayIccpPng("sRGB", linear2GrayProfile), { name: "linear2-gray.png" }), /non-sRGB ICC/);
  const srgbGrayProfile = makeFakeIccProfile("sRGB Gray", {
    colorSpace: "GRAY",
    primaries: null,
    trcTag: makeSrgbParaType3Tag(),
  });
  const decSrgbGray = decodeRasterBytes(makeGrayIccpPng("sRGB", srgbGrayProfile), { name: "srgb-gray.png" });
  assert.deepEqual([...decSrgbGray.rgba], [100, 100, 100, 255]);

  // 2c. Display P3 iCCP rejected; genuine sRGB ICC with para type 3 AND curv LUT both accepted
  const p3Profile = makeFakeIccProfile("Display P3", { primaries: ADOBE_RGB_PRIMARIES });
  assert.throws(() => decodeRasterBytes(makeIccpPng("Display P3", p3Profile), { name: "p3.png" }), /non-sRGB ICC/);

  const srgbParaProfile = makeFakeIccProfile("sRGB IEC61966-2.1", {
    primaries: SRGB_PRIMARIES,
    trcTag: makeSrgbParaType3Tag(),
  });
  assert.equal(decodeRasterBytes(makeIccpPng("sRGB", srgbParaProfile), { name: "srgb-para.png" }).rgba[0], 100);

  const srgbCurvProfile = makeFakeIccProfile("sRGB IEC61966-2.1", {
    primaries: SRGB_PRIMARIES,
    trcTag: makeSrgbCurvLutTag(256),
  });
  assert.equal(decodeRasterBytes(makeIccpPng("sRGB", srgbCurvProfile), { name: "srgb-curv.png" }).rgba[0], 100);

  // 2c. SMPTE-C cHRM rejected (outside 0.005 tolerance); sRGB cHRM accepted
  const makeChrm = (vals) => {
    const buf = Buffer.alloc(32);
    vals.forEach((v, i) => buf.writeUInt32BE(Math.round(v * 100000), i * 4));
    return buf;
  };
  const smpteCPng = buildCustomPng(
    { width: 1, height: 1, depth: 8, colorType: 2 },
    [pngChunk("cHRM", makeChrm([0.3127, 0.329, 0.63, 0.34, 0.31, 0.595, 0.155, 0.07]))],
    Buffer.from([0, 100, 100, 100]),
  );
  assert.throws(() => decodeRasterBytes(smpteCPng, { name: "smpte-c.png" }), /non-sRGB chromaticities/);

  const srgbChrmPng = buildCustomPng(
    { width: 1, height: 1, depth: 8, colorType: 2 },
    [pngChunk("cHRM", makeChrm([0.3127, 0.329, 0.64, 0.33, 0.3, 0.6, 0.15, 0.06]))],
    Buffer.from([0, 100, 100, 100]),
  );
  assert.equal(decodeRasterBytes(srgbChrmPng, { name: "srgb-chrm.png" }).rgba[0], 100);

  // 3. JPEG with non-sRGB APP2 ICC_PROFILE rejected
  const baseJpg = jpeg.encode({ width: 16, height: 8, data: Buffer.alloc(16 * 8 * 4, 180) }, 95).data;
  const app2P3 = Buffer.concat([Buffer.from("ICC_PROFILE\0", "ascii"), Buffer.from([1, 1]), p3Profile]);
  const p3Jpg = injectJpegSegment(baseJpg, 0xe2, app2P3);
  assert.throws(() => decodeRasterBytes(p3Jpg, { name: "p3.jpg" }), /non-sRGB ICC/);

  // 4. JPEG with EXIF Orientation 6 (90° CW): landscape 16x8 with bright red left half -> portrait 8x16 with bright red top half
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
  const topPx = (2 * 8 + 4) * 4;
  const botPx = (13 * 8 + 4) * 4;
  assert.ok(decRot.rgba[topPx] > 180 && decRot.rgba[topPx + 2] < 80, "top half should be red after 90° CW rotation");
  assert.ok(decRot.rgba[botPx + 2] > 180 && decRot.rgba[botPx] < 80, "bottom half should be blue after 90° CW rotation");
});

test("reserveOutputDir uses shared .neurodesk-cli.lock and publishOutputs cleans partials and preserves dangling symlinks", async () => {
  const work = await mkdtemp(join(tmpdir(), "dermvit-lock-"));
  try {
    const outDir = join(work, "fresh-out");
    const first = await reserveOutputDir(outDir, { overwrite: false, tool: "dermvit" });
    assert.equal(first.lockPath, join(outDir, SHARED_OUTPUT_LOCK));
    await assert.rejects(
      () => reserveOutputDir(outDir, { overwrite: true, tool: "dermoscope" }),
      /\.neurodesk-cli\.lock/,
    );
    // Lock file must still exist after rejected second contender
    await stat(first.lockPath);
    await first.release({ removeIfEmpty: true });
    // Newly created empty dir should be cleaned up on abort
    await assert.rejects(() => stat(outDir), { code: "ENOENT" });

    // Failed writeFile cleanup: partial created before EFBIG must be deleted
    const stageDir = join(work, "stage-fail");
    await mkdir(stageDir);
    let callCount = 0;
    await assert.rejects(
      () =>
        publishOutputs(
          stageDir,
          [
            { name: "first.txt", bytes: Buffer.from("ok") },
            { name: "second.txt", bytes: Buffer.from("boom") },
          ],
          {
            overwrite: true,
            writeFileImpl: async (p, data, opts) => {
              callCount += 1;
              await writeFile(p, data, opts);
              if (callCount === 2) {
                const err = new Error("simulated EFBIG during write");
                err.code = "EFBIG";
                throw err;
              }
            },
          },
        ),
      /EFBIG/,
    );
    assert.deepEqual(await readdir(stageDir), []);

    // Rollback test: existing file AND pre-existing dangling symlink are both preserved on mid-commit failure
    const txDir = join(work, "tx");
    await mkdir(txDir);
    await writeFile(join(txDir, "a.txt"), "original-a");
    await symlink("/nonexistent-neurodesk-target", join(txDir, "dangling.txt"));
    await mkdir(join(txDir, "b.txt"));
    await assert.rejects(() =>
      publishOutputs(
        txDir,
        [
          { name: "a.txt", bytes: Buffer.from("new-a") },
          { name: "dangling.txt", bytes: Buffer.from("new-dangling") },
          { name: "c.txt", bytes: Buffer.from("new-c") },
          { name: "b.txt", bytes: Buffer.from("new-b") },
        ],
        { overwrite: true },
      ),
    );
    assert.equal(await readFile(join(txDir, "a.txt"), "utf8"), "original-a");
    assert.equal((await lstat(join(txDir, "dangling.txt"))).isSymbolicLink(), true);
    assert.equal(await readlink(join(txDir, "dangling.txt")), "/nonexistent-neurodesk-target");
    const entries = await readdir(txDir);
    assert.deepEqual(entries.sort(), ["a.txt", "b.txt", "dangling.txt"]);
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
