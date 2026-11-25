import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { crc32, deflateSync, gunzipSync, gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";
import { decode as decodePng, encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import {
  analyseStructureTensorFile,
  boundedGunzip,
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  decodePngGreyscale,
  extractNibabelAffine,
  LOCK_NAME,
  parseCliOptions,
  readImageFile,
  toCheckedFloat32,
} from "../src/node.js";

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, "../bin/structure-tensor.js");

function makeGrating2d(n, degrees) {
  const data = new Uint8Array(n * n);
  const theta = (degrees * Math.PI) / 180;
  const freq = (2 * Math.PI) / 6;
  for (let y = 0; y < n; y += 1) {
    for (let x = 0; x < n; x += 1) {
      const v = Math.cos(freq * (x * Math.sin(theta) + y * Math.cos(theta)));
      data[x + n * y] = Math.round(127.5 + 100 * v);
    }
  }
  return data;
}

test("strict CLI option validation rejects empty values, out-of-range numbers, and disallowed subcommand flags", () => {
  assert.throws(() => parseCliOptions({ sigma: "" }), /non-empty/);
  assert.throws(() => parseCliOptions({ sigma: "0.1" }), /between 0\.5 and 20/);
  assert.throws(() => parseCliOptions({ rho: "100" }), /between 0\.5 and 50/);
  assert.throws(() => parseCliOptions({ "min-coherency": "-0.1" }), /between 0 and 1/);
  assert.throws(() => parseCliOptions({ "min-energy": "1.5" }), /between 0 and 1/);

  const badFlag = spawnSync(process.execPath, [binPath, "self-check", "--sigma", "2"], { encoding: "utf8" });
  assert.notEqual(badFlag.status, 0);
  assert.match(badFlag.stderr, /not allowed with self-check/);

  const emptyCache = spawnSync(process.execPath, [binPath, "self-check", "--cache-dir="], { encoding: "utf8" });
  assert.notEqual(emptyCache.status, 0);
  assert.match(emptyCache.stderr, /non-empty/);
});

test("self-check prints valid JSON and honors --cache-dir", async () => {
  const info = await checkInstallation({ cacheDir: "/tmp/st-cache" });
  assert.equal(info.ok, true);
  assert.ok(Math.abs(info.testAngleDeg - 45) < 1e-3);
  assert.equal(info.cacheDir, resolve("/tmp/st-cache"));

  const cli = spawnSync(process.execPath, [binPath, "self-check", "--cache-dir", "/tmp/st-cache"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
  const parsed = JSON.parse(cli.stdout);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.cacheDir, resolve("/tmp/st-cache"));
});

test("extractNibabelAffine follows sform > qform > LAS-centered fallback precedence and boundedGunzip caps output", () => {
  // 1. Both sform_code=0 and qform_code=0 => LAS-centered fallback
  const baseHdr = new ArrayBuffer(352);
  const dv = new DataView(baseHdr);
  dv.setInt32(0, 348, true);
  dv.setInt16(40, 3, true);
  dv.setInt16(42, 10, true);
  dv.setInt16(44, 12, true);
  dv.setInt16(46, 8, true);
  dv.setFloat32(76, 1, true);
  dv.setFloat32(80, 2, true);
  dv.setFloat32(84, 3, true);
  dv.setFloat32(88, 4, true);
  dv.setFloat32(108, 352, true);
  const fallback = extractNibabelAffine(baseHdr);
  assert.deepEqual(fallback, [
    [-2, 0, 0, 9],
    [0, 3, 0, -16.5],
    [0, 0, 4, -14],
    [0, 0, 0, 1],
  ]);

  // 2. qform_code > 0 takes precedence over fallback
  dv.setInt16(252, 1, true);
  dv.setFloat32(268, 10, true);
  dv.setFloat32(272, 20, true);
  dv.setFloat32(276, 30, true);
  const fromQform = extractNibabelAffine(baseHdr);
  assert.deepEqual(fromQform[0], [2, 0, 0, 10]);
  assert.deepEqual(fromQform[1], [0, 3, 0, 20]);
  assert.deepEqual(fromQform[2], [0, 0, 4, 30]);

  // 3. sform_code > 0 takes precedence over qform
  dv.setInt16(254, 1, true);
  dv.setFloat32(280, 5, true);
  dv.setFloat32(292, 100, true);
  dv.setFloat32(300, 6, true);
  dv.setFloat32(308, 200, true);
  dv.setFloat32(320, 7, true);
  dv.setFloat32(324, 300, true);
  const fromSform = extractNibabelAffine(baseHdr);
  assert.deepEqual(fromSform[0], [5, 0, 0, 100]);
  assert.deepEqual(fromSform[1], [0, 6, 0, 200]);
  assert.deepEqual(fromSform[2], [0, 0, 7, 300]);

  // Bounded gunzip rejects decompressed payload larger than limit
  const big = gzipSync(Buffer.alloc(4096, 0x41));
  assert.throws(() => boundedGunzip(big, 1024), /Decompressed input too large/);

  // Float32 narrowing overflow check
  assert.throws(() => toCheckedFloat32(new Float64Array([1e40]), "test"), /non-finite float32/);
});

test("analyseStructureTensorFile processes 2D PNG and 3D NIfTI (.nii.gz) preserving both qform and sform", async () => {
  const work = mkdtempSync(join(tmpdir(), "structure-tensor-test-"));
  try {
    // 1. 2D PNG grating at 30°
    const pngPath = join(work, "grating30.png");
    const pngBytes = encodePng({ width: 32, height: 32, data: makeGrating2d(32, 30), channels: 1, depth: 8 });
    writeFileSync(pngPath, pngBytes);

    const outPng = join(work, "out-png");
    const run2d = await analyseStructureTensorFile({ inputs: [pngPath], outputDir: outPng });
    assert.equal(run2d.dimensions, 2);
    assert.ok(Math.abs(run2d.dominant.orientation - 30) < 1.5);
    const hsb = decodePng(readFileSync(join(outPng, "grating30_hsb.png")));
    assert.equal(hsb.width, 32);
    assert.equal(hsb.height, 32);

    // 2. 3D NIfTI (.nii.gz) with explicit qform AND sform; verify both are preserved in output
    const dims = [16, 16, 12];
    const hdr = createNiftiHeaderFromVolume({
      hdr: {
        dims: [3, ...dims, 1, 1, 1, 1],
        pixDims: [1, 1, 1, 1, 1, 1, 1, 1],
        affine: [[1, 0, 0, 12], [0, 1, 0, 24], [0, 0, 1, 36], [0, 0, 0, 1]],
      },
    });
    const hdv = new DataView(hdr);
    hdv.setInt16(252, 1, true);
    hdv.setFloat32(268, 12, true);
    hdv.setFloat32(272, 24, true);
    hdv.setFloat32(276, 36, true);
    hdv.setInt16(254, 2, true);
    hdv.setFloat32(280, 1, true);
    hdv.setFloat32(292, 50, true);
    hdv.setFloat32(300, 1, true);
    hdv.setFloat32(308, 60, true);
    hdv.setFloat32(320, 1, true);
    hdv.setFloat32(324, 70, true);

    const voxels = new Float32Array(dims[0] * dims[1] * dims[2]);
    for (let z = 0; z < dims[2]; z += 1) {
      for (let y = 0; y < dims[1]; y += 1) {
        for (let x = 0; x < dims[0]; x += 1) {
          voxels[x + dims[0] * (y + dims[1] * z)] = Math.cos((2 * Math.PI * y) / 4);
        }
      }
    }
    const niiPath = join(work, "vol.nii.gz");
    writeFileSync(niiPath, gzipSync(new Uint8Array(createNiftiFromData(voxels, hdr, { dims }))));

    const outNii = join(work, "out-nii");
    const run3d = await analyseStructureTensorFile({ inputs: [niiPath], outputDir: outNii });
    assert.equal(run3d.dimensions, 3);

    const outCoh = gunzipSync(readFileSync(join(outNii, "vol_coherency.nii.gz")));
    const odv = new DataView(outCoh.buffer, outCoh.byteOffset, outCoh.byteLength);
    assert.equal(odv.getInt16(252, true), 1, "qform_code preserved");
    assert.equal(odv.getFloat32(268, true), 12, "qoffset_x preserved");
    assert.equal(odv.getInt16(254, true), 2, "sform_code preserved");
    assert.equal(odv.getFloat32(292, true), 50, "srow_x[3] preserved");

    // 3. Reject Float64 NIfTI whose values overflow Float32 after narrowing
    const bigF64 = new Float64Array(dims[0] * dims[1] * dims[2]).fill(1e40);
    const badNiiPath = join(work, "overflow.nii.gz");
    writeFileSync(badNiiPath, gzipSync(new Uint8Array(createNiftiFromData(bigF64, hdr, { dims }))));
    await assert.rejects(
      () => analyseStructureTensorFile({ inputs: [badNiiPath], outputDir: join(work, "out-bad") }),
      /non-finite float32/,
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("output directory lock prevents concurrent runs, cleans up created dirs on failure, and rolls back rename errors", async () => {
  const work = mkdtempSync(join(tmpdir(), "structure-tensor-lock-"));
  try {
    const outDir = join(work, "a", "b");
    await assert.rejects(
      () => claimOutputDir(outDir, { readdirFn: async () => { throw new Error("readdir fail"); } }),
      /readdir fail/,
    );
    assert.deepEqual(readdirSync(work), [], "newly created directories must be cleaned up on claim error");

    const reservation = await claimOutputDir(outDir);
    await assert.rejects(() => claimOutputDir(outDir), /locked by another/);
    await reservation.release({ removeCreated: false });

    writeFileSync(join(outDir, "one.tif"), "old1");
    writeFileSync(join(outDir, "two.tif"), "old2");
    let calls = 0;
    await assert.rejects(
      () => commitOutputs(
        outDir,
        [
          { name: "one.tif", data: Buffer.from("new1") },
          { name: "two.tif", data: Buffer.from("new2") },
        ],
        {
          overwrite: true,
          renameFn: async (src, dst) => {
            calls += 1;
            if (calls === 4) throw new Error("rename boom");
            const { rename } = await import("node:fs/promises");
            await rename(src, dst);
          },
        },
      ),
      /rename boom/,
    );
    assert.equal(readFileSync(join(outDir, "one.tif"), "utf8"), "old1");
    assert.equal(readFileSync(join(outDir, "two.tif"), "utf8"), "old2");
    assert.deepEqual(readdirSync(outDir).sort(), ["one.tif", "two.tif"]);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

function pngChunk(type, data) {
  const typeBytes = Buffer.from(type, "ascii");
  const payload = Buffer.from(data);
  const out = Buffer.alloc(12 + payload.length);
  out.writeUInt32BE(payload.length, 0);
  typeBytes.copy(out, 4);
  payload.copy(out, 8);
  const c = crc32(out.subarray(4, 8 + payload.length)) >>> 0;
  out.writeUInt32BE(c, 8 + payload.length);
  return out;
}

function buildCustomPng({ width, height, bitDepth, colorType, interlace = 0, rawScanlines, extraChunks = [] }) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = interlace;
  const idat = deflateSync(Buffer.from(rawScanlines));
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    ...extraChunks,
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

test("PNG decoding parity: 3x2 1-bit, 1-bit Adam7, tRNS, invalid IDAT CRC, transparent RGB zeroing, gAMA->sRGB, non-sRGB cHRM/iCCP", async () => {
  // 1. 3x2 1-bit greyscale PNG with row padding bits:
  // Row 0: [1, 0, 1] -> 0b10100000 = 0xa0; Row 1: [0, 1, 0] -> 0b01000000 = 0x40
  const png1bit = buildCustomPng({
    width: 3,
    height: 2,
    bitDepth: 1,
    colorType: 0,
    rawScanlines: [0, 0xa0, 0, 0x40],
  });
  const dec1 = decodePngGreyscale(png1bit);
  assert.deepEqual(dec1.dims, [3, 2, 1]);
  assert.deepEqual(Array.from(dec1.data), [255, 0, 255, 0, 255, 0]);

  // 2. 1-bit Adam7 interlaced 3x2 PNG:
  // Adam7 passes for 3x2:
  // Pass 1 (x=0, y=0): 1x1 -> bit=1 (0x80)
  // Pass 2: empty (x=4 >= 3)
  // Pass 3: empty (y=4 >= 2)
  // Pass 4 (x=2, y=0): 1x1 -> bit=1 (0x80)
  // Pass 5 (x=0,2, y=2): empty (y=2 >= 2)
  // Pass 6 (x=1, y=0): 1x1 -> bit=0 (0x00)
  // Pass 7 (x=0,1,2, y=1): 3x1 -> [0, 1, 0] (0x40)
  const pngAdam7 = buildCustomPng({
    width: 3,
    height: 2,
    bitDepth: 1,
    colorType: 0,
    interlace: 1,
    rawScanlines: [
      0, 0x80, // pass 1: (0,0)=1
      0, 0x80, // pass 4: (2,0)=1
      0, 0x00, // pass 6: (1,0)=0
      0, 0x40, // pass 7: (0,1)=0, (1,1)=1, (2,1)=0
    ],
  });
  const decAdam7 = decodePngGreyscale(pngAdam7);
  assert.deepEqual(Array.from(decAdam7.data), [255, 0, 255, 0, 255, 0]);

  // 3. tRNS transparency chunk on 8-bit greyscale: value 120 marked transparent -> decoded as 0!
  const trns = Buffer.alloc(2);
  trns.writeUInt16BE(120, 0);
  const pngTrns = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 120, 200],
    extraChunks: [pngChunk("tRNS", trns)],
  });
  const decTrns = decodePngGreyscale(pngTrns);
  assert.deepEqual(Array.from(decTrns.data), [0, 200]);

  // 4. Transparent RGBA pixel (255, 180, 90, 0) zeroes RGB to 0
  const pngAlpha = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 6,
    rawScanlines: [0, 255, 180, 90, 0, 60, 120, 180, 255],
  });
  const decAlpha = decodePngGreyscale(pngAlpha);
  assert.deepEqual(Array.from(decAlpha.data), [0, 120]);

  // 5. Invalid IDAT CRC32 rejected cleanly
  const badCrc = Buffer.from(png1bit);
  const idatIdx = badCrc.indexOf(Buffer.from("IDAT"));
  const idatLen = badCrc.readUInt32BE(idatIdx - 4);
  badCrc[idatIdx + 4 + idatLen] ^= 0xff;
  assert.throws(() => decodePngGreyscale(badCrc), /CRC32/);

  // 6. gAMA -> sRGB conversion (gAMA=100000 linear 1.0 and gAMA=45455 1/2.2)
  const gamaLinear = Buffer.alloc(4);
  gamaLinear.writeUInt32BE(100000, 0);
  const pngLinear = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 128, 255],
    extraChunks: [pngChunk("gAMA", gamaLinear)],
  });
  const decLinear = decodePngGreyscale(pngLinear);
  // Linear 128/255 ≈ 0.50196 -> sRGB ≈ 0.7366 * 255 ≈ 188
  assert.ok(decLinear.data[0] >= 186 && decLinear.data[0] <= 190, `expected ~188, got ${decLinear.data[0]}`);
  assert.equal(decLinear.data[1], 255);

  const gama45455 = Buffer.alloc(4);
  gama45455.writeUInt32BE(45455, 0);
  // Standalone gAMA=45455 without cHRM matches Chromium Blink PNGImageDecoder (exact identity across all 256 values)
  const all256Scanline = Buffer.alloc(1 + 256);
  all256Scanline[0] = 0;
  for (let i = 0; i < 256; i += 1) all256Scanline[1 + i] = i;
  const png45455 = buildCustomPng({
    width: 256,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: all256Scanline,
    extraChunks: [pngChunk("gAMA", gama45455)],
  });
  const dec45455 = decodePngGreyscale(png45455);
  for (let i = 0; i < 256; i += 1) {
    assert.equal(dec45455.data[i], i, `standalone gAMA=45455 mismatch at level ${i}`);
  }

  // gAMA=45455 paired with sRGB cHRM DOES apply gamma 1/2.2 -> sRGB transfer (matching Chromium)
  const srgbChrmBuf = Buffer.alloc(32);
  [31270, 32900, 64000, 33000, 30000, 60000, 15000, 6000].forEach((val, idx) => srgbChrmBuf.writeUInt32BE(val, idx * 4));
  const png45455WithChrm = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 20, 128],
    extraChunks: [pngChunk("cHRM", srgbChrmBuf), pngChunk("gAMA", gama45455)],
  });
  const dec45455WithChrm = decodePngGreyscale(png45455WithChrm);
  assert.ok(dec45455WithChrm.data[0] >= 10 && dec45455WithChrm.data[0] <= 14, `expected ~12 for cHRM+gAMA=45455 toe, got ${dec45455WithChrm.data[0]}`);

  // 7. Non-sRGB cHRM rejected cleanly
  const badChrm = Buffer.alloc(32);
  [31270, 32900, 68000, 32000, 26500, 69000, 15000, 6000].forEach((val, idx) => badChrm.writeUInt32BE(val, idx * 4));
  const pngBadChrm = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("cHRM", badChrm)],
  });
  assert.throws(() => decodePngGreyscale(pngBadChrm), /non-sRGB PNG chromaticity/);

  // 8. Non-sRGB iCCP rejected cleanly
  const fakeIcc = Buffer.alloc(132);
  fakeIcc.writeUInt32BE(132, 0);
  Buffer.from("RGB ").copy(fakeIcc, 16);
  Buffer.from("acsp").copy(fakeIcc, 36);
  const iccpPayload = Buffer.concat([Buffer.from("Display P3\0"), Buffer.from([0]), deflateSync(fakeIcc)]);
  const pngBadIccp = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("iCCP", iccpPayload)],
  });
  assert.throws(() => decodePngGreyscale(pngBadIccp), /non-sRGB ICC profile/);

  // 8b. Truncated / malformed PNG iCCP chunks rejected (length <= 2, missing NUL, < 132 bytes, header profileSize > length, tag OOB)
  for (const badPayload of [
    Buffer.from([0x61]),
    Buffer.from([0x61, 0x00]),
    Buffer.from("NoNulTerminator"),
    Buffer.concat([Buffer.from("short\0"), Buffer.from([0]), deflateSync(Buffer.alloc(64))]),
  ]) {
    const pngBad = buildCustomPng({
      width: 2,
      height: 1,
      bitDepth: 8,
      colorType: 0,
      rawScanlines: [0, 100, 200],
      extraChunks: [pngChunk("iCCP", badPayload)],
    });
    assert.throws(() => decodePngGreyscale(pngBad), /iCCP|ICC profile/);
  }
  const bigHeaderIcc = Buffer.alloc(132);
  bigHeaderIcc.writeUInt32BE(512, 0); // declares 512 bytes but only 132 present
  Buffer.from("RGB ").copy(bigHeaderIcc, 16);
  Buffer.from("acsp").copy(bigHeaderIcc, 36);
  const pngTruncSize = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("iCCP", Buffer.concat([Buffer.from("sRGB\0"), Buffer.from([0]), deflateSync(bigHeaderIcc)]))],
  });
  assert.throws(() => decodePngGreyscale(pngTruncSize), /truncated/i);

  const oobTagIcc = Buffer.alloc(144);
  oobTagIcc.writeUInt32BE(144, 0);
  Buffer.from("RGB ").copy(oobTagIcc, 16);
  Buffer.from("acsp").copy(oobTagIcc, 36);
  oobTagIcc.writeUInt32BE(1, 128);
  Buffer.from("desc").copy(oobTagIcc, 132);
  oobTagIcc.writeUInt32BE(140, 136);
  oobTagIcc.writeUInt32BE(32, 140); // 140 + 32 > 144
  const pngOobTag = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("iCCP", Buffer.concat([Buffer.from("sRGB\0"), Buffer.from([0]), deflateSync(oobTagIcc)]))],
  });
  assert.throws(() => decodePngGreyscale(pngOobTag), /out-of-bounds tag/i);

  // 9. 16-bit linear PNG (gAMA=100000): sample16=200 strips high byte -> 0 (matching Chromium OffscreenCanvas), 256 -> 13
  const gamaLin = Buffer.alloc(4);
  gamaLin.writeUInt32BE(100000, 0);
  const raw16 = Buffer.alloc(1 + 4);
  raw16[0] = 0;
  raw16.writeUInt16BE(200, 1);
  raw16.writeUInt16BE(256, 3);
  const png16Linear = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 16,
    colorType: 0,
    rawScanlines: raw16,
    extraChunks: [pngChunk("gAMA", gamaLin)],
  });
  const dec16Linear = decodePngGreyscale(png16Linear);
  assert.equal(dec16Linear.data[0], 0);
  assert.equal(dec16Linear.data[1], 13);

  // 10. Exact Chromium/Skia alpha premul/unpremul parity: (gray=22, alpha=6) -> 42, (64, 2) -> 128, (64, 10) -> 77
  const pngAlphaParity = buildCustomPng({
    width: 3,
    height: 1,
    bitDepth: 8,
    colorType: 6,
    rawScanlines: [0, 22, 22, 22, 6, 64, 64, 64, 2, 64, 64, 64, 10],
  });
  const decAlphaParity = decodePngGreyscale(pngAlphaParity);
  assert.equal(decAlphaParity.data[0], 42);
  assert.equal(decAlphaParity.data[1], 128);
  assert.equal(decAlphaParity.data[2], 77);

  // 11. Narrow-range cICP [1, 13, 0, 0] rejected; full-range [1, 13, 0, 1] accepted
  const pngNarrowCicp = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("cICP", Buffer.from([1, 13, 0, 0]))],
  });
  assert.throws(() => decodePngGreyscale(pngNarrowCicp), /non-sRGB PNG color profile/);
  const pngFullCicp = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("cICP", Buffer.from([1, 13, 0, 1]))],
  });
  assert.deepEqual(Array.from(decodePngGreyscale(pngFullCicp).data), [100, 200]);

  // 12. Real ICC profile with sRGB description + sRGB primaries + LINEAR TRC rejected in BOTH PNG and JPEG
  function buildIccProfile({ linearTrc }) {
    const descStr = Buffer.from("sRGB IEC61966-2.1\0", "ascii");
    const descTag = Buffer.alloc(12 + descStr.length);
    descTag.write("desc", 0, "ascii");
    descTag.writeUInt32BE(descStr.length, 8);
    descStr.copy(descTag, 12);
    const makeXyz = (x, y, z) => {
      const b = Buffer.alloc(20);
      b.write("XYZ ", 0, "ascii");
      b.writeInt32BE(Math.round(x * 65536), 8);
      b.writeInt32BE(Math.round(y * 65536), 12);
      b.writeInt32BE(Math.round(z * 65536), 16);
      return b;
    };
    let trcTag;
    if (linearTrc) {
      trcTag = Buffer.alloc(16);
      trcTag.write("curv", 0, "ascii");
      trcTag.writeUInt32BE(2, 8);
      trcTag.writeUInt16BE(0, 12);
      trcTag.writeUInt16BE(65535, 14);
    } else {
      trcTag = Buffer.alloc(32);
      trcTag.write("para", 0, "ascii");
      trcTag.writeUInt16BE(3, 8);
      trcTag.writeInt32BE(Math.round(2.4 * 65536), 12);
      trcTag.writeInt32BE(Math.round((1 / 1.055) * 65536), 16);
      trcTag.writeInt32BE(Math.round((0.055 / 1.055) * 65536), 20);
      trcTag.writeInt32BE(Math.round((1 / 12.92) * 65536), 24);
      trcTag.writeInt32BE(Math.round(0.04045 * 65536), 28);
    }
    const tagEntries = [
      ["desc", descTag],
      ["rXYZ", makeXyz(0.4361, 0.2225, 0.0139)],
      ["gXYZ", makeXyz(0.3851, 0.7169, 0.0971)],
      ["bXYZ", makeXyz(0.1431, 0.0606, 0.7141)],
      ["rTRC", trcTag],
      ["gTRC", trcTag],
      ["bTRC", trcTag],
    ];
    const headerLen = 132 + tagEntries.length * 12;
    let offset = headerLen;
    const chunks = [];
    const table = Buffer.alloc(tagEntries.length * 12);
    tagEntries.forEach(([sig, buf], idx) => {
      table.write(sig, idx * 12, "ascii");
      table.writeUInt32BE(offset, idx * 12 + 4);
      table.writeUInt32BE(buf.length, idx * 12 + 8);
      chunks.push(buf);
      offset += buf.length;
    });
    const hdr = Buffer.alloc(132);
    hdr.writeUInt32BE(offset, 0);
    hdr.write("RGB ", 16, "ascii");
    hdr.write("acsp", 36, "ascii");
    hdr.writeUInt32BE(tagEntries.length, 128);
    return Buffer.concat([hdr, table, ...chunks]);
  }
  const linearIcc = buildIccProfile({ linearTrc: true });
  const validSrgbIcc = buildIccProfile({ linearTrc: false });
  const pngLinearIcc = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("iCCP", Buffer.concat([Buffer.from("sRGB\0"), Buffer.from([0]), deflateSync(linearIcc)]))],
  });
  assert.throws(() => decodePngGreyscale(pngLinearIcc), /non-sRGB transfer curve/);
  const pngValidIcc = buildCustomPng({
    width: 2,
    height: 1,
    bitDepth: 8,
    colorType: 0,
    rawScanlines: [0, 100, 200],
    extraChunks: [pngChunk("iCCP", Buffer.concat([Buffer.from("sRGB\0"), Buffer.from([0]), deflateSync(validSrgbIcc)]))],
  });
  assert.deepEqual(Array.from(decodePngGreyscale(pngValidIcc).data), [100, 200]);

  // Also test linear-TRC ICC embedded in JPEG APP2 ICC_PROFILE
  const jpegMod = await import("jpeg-js");
  const baseJpeg = jpegMod.default.encode({ data: Buffer.from([100, 100, 100, 255, 200, 200, 200, 255]), width: 2, height: 1 }, 95).data;
  const app2Payload = Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([1, 1]), linearIcc]);
  const app2Seg = Buffer.alloc(4 + app2Payload.length);
  app2Seg[0] = 0xff;
  app2Seg[1] = 0xe2;
  app2Seg.writeUInt16BE(2 + app2Payload.length, 2);
  app2Payload.copy(app2Seg, 4);
  const jpegWithLinearIcc = Buffer.concat([baseJpeg.subarray(0, 2), app2Seg, baseJpeg.subarray(2)]);
  const jpegWork = mkdtempSync(join(tmpdir(), "st-jpeg-icc-"));
  try {
    const jpgPath = join(jpegWork, "linear-icc.jpg");
    writeFileSync(jpgPath, jpegWithLinearIcc);
    await assert.rejects(
      () => analyseStructureTensorFile({ inputs: [jpgPath], outputDir: join(jpegWork, "out") }),
      /non-sRGB transfer curve/,
    );
  } finally {
    rmSync(jpegWork, { recursive: true, force: true });
  }
});

test("NIfTI-2 3D analysis preserves qform and sform in NIfTI-2 outputs and strict Node API validation works", async () => {
  const work = mkdtempSync(join(tmpdir(), "structure-tensor-nifti2-"));
  try {
    // Strict Node API checks
    assert.throws(() => parseCliOptions({ sigm: "1" }), /Unknown option/);
    assert.throws(() => parseCliOptions({ overwrite: "false" }), /must be a boolean/);
    assert.throws(() => parseCliOptions({ offline: "true" }), /must be a boolean/);
    await assert.rejects(() => checkInstallation({ cacheDir: "" }), /non-empty/);
    await assert.rejects(() => checkInstallation({ extra: true }), /Unknown option/);

    const prevOffline = process.env.NEURODESK_OFFLINE;
    try {
      process.env.NEURODESK_OFFLINE = "1";
      assert.throws(() => parseCliOptions({ offline: false }), /NEURODESK_OFFLINE=1/);
    } finally {
      if (prevOffline === undefined) delete process.env.NEURODESK_OFFLINE;
      else process.env.NEURODESK_OFFLINE = prevOffline;
    }

    assert.equal(LOCK_NAME, ".neurodesk-cli.lock");

    // Failed partial write cleans up .partial
    const efbigDir = join(work, "efbig");
    writeFileSync(join(work, "placeholder"), "x");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(efbigDir);
    await assert.rejects(
      () => commitOutputs(efbigDir, [{ name: "out.tif", data: Buffer.from("abc") }], {
        writeFileFn: async (p) => {
          writeFileSync(p, "a");
          throw Object.assign(new Error("EFBIG"), { code: "EFBIG" });
        },
      }),
      /EFBIG/,
    );
    assert.deepEqual(readdirSync(efbigDir), []);

    // NIfTI-2 3D volume with qform + sform
    const dims = [16, 16, 12];
    const voxels = new Float32Array(dims[0] * dims[1] * dims[2]);
    for (let z = 0; z < dims[2]; z += 1) {
      for (let y = 0; y < dims[1]; y += 1) {
        for (let x = 0; x < dims[0]; x += 1) {
          voxels[x + dims[0] * (y + dims[1] * z)] = Math.cos((2 * Math.PI * y) / 4);
        }
      }
    }
    const buf = new ArrayBuffer(544 + voxels.byteLength);
    const v = new DataView(buf);
    v.setInt32(0, 540, true);
    new Uint8Array(buf, 4, 8).set([0x6e, 0x2b, 0x32, 0x00, 0x0d, 0x0a, 0x1a, 0x0a]);
    v.setInt16(12, 16, true);
    v.setInt16(14, 32, true);
    v.setBigInt64(16, 3n, true);
    v.setBigInt64(24, 16n, true);
    v.setBigInt64(32, 16n, true);
    v.setBigInt64(40, 12n, true);
    for (let i = 0; i < 4; i += 1) v.setBigInt64(48 + i * 8, 1n, true);
    v.setFloat64(104, 1, true);
    v.setFloat64(112, 1, true);
    v.setFloat64(120, 1, true);
    v.setFloat64(128, 1, true);
    v.setBigInt64(168, 544n, true);
    v.setFloat64(176, 1, true);
    v.setFloat64(184, 0, true);
    v.setInt32(344, 1, true);
    v.setFloat64(376, 15, true);
    v.setInt32(348, 2, true);
    v.setFloat64(400, 2, true);
    v.setFloat64(424, 99, true);
    v.setFloat64(440, -3, true);
    v.setFloat64(480, 4, true);
    v.setInt32(500, 2, true);
    new Uint8Array(buf, 544).set(new Uint8Array(voxels.buffer));

    const nii2Path = join(work, "vol2.nii.gz");
    writeFileSync(nii2Path, gzipSync(new Uint8Array(buf)));
    const outDir = join(work, "out-nifti2");
    const run = await analyseStructureTensorFile({ inputs: [nii2Path], outputDir: outDir });
    assert.equal(run.dimensions, 3);
    const outCoh = gunzipSync(readFileSync(join(outDir, "vol2_coherency.nii.gz")));
    const odv = new DataView(outCoh.buffer, outCoh.byteOffset, outCoh.byteLength);
    assert.equal(odv.getInt32(0, true), 540);
    assert.equal(odv.getInt32(344, true), 1);
    assert.equal(odv.getFloat64(376, true), 15);
    assert.equal(odv.getInt32(348, true), 2);
    assert.equal(odv.getFloat64(400, true), 2);
    assert.equal(odv.getFloat64(424, true), 99);
    assert.equal(odv.getFloat64(440, true), -3);
    assert.equal(odv.getFloat64(480, true), 4);

    // Sol r2: strict NIfTI-1/2 header validation & NiBabel 5.3.3 quaternion parity
    const badMagic = buf.slice(0);
    new Uint8Array(badMagic)[8] = 0x00; // corrupt byte 4 of 8-byte magic
    assert.throws(() => extractNibabelAffine(badMagic), /Invalid NIfTI-2 magic/);

    const badOffset2 = buf.slice(0);
    new DataView(badOffset2).setBigInt64(168, 540n, true);
    assert.throws(() => extractNibabelAffine(badOffset2), /vox_offset/);
    const zeroOffset2 = buf.slice(0);
    new DataView(zeroOffset2).setBigInt64(168, 0n, true);
    assert.throws(() => extractNibabelAffine(zeroOffset2), /vox_offset/);

    const badOffset1 = new ArrayBuffer(352);
    const dv1 = new DataView(badOffset1);
    dv1.setInt32(0, 348, true);
    new Uint8Array(badOffset1, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
    dv1.setFloat32(108, 348, true);
    assert.throws(() => extractNibabelAffine(badOffset1), /vox_offset/);
    dv1.setFloat32(108, 0, true);
    assert.throws(() => extractNibabelAffine(badOffset1), /vox_offset/);

    // NIfTI-1 near-180° quaternion (b = Math.fround(1 - 2^-23) => |w^2| < 3*f32_eps => w = 0, exact quat2mat unit scale!)
    const q1Buf = new ArrayBuffer(352);
    const q1 = new DataView(q1Buf);
    q1.setInt32(0, 348, true);
    new Uint8Array(q1Buf, 344, 4).set([0x6e, 0x2b, 0x31, 0x00]);
    q1.setFloat32(108, 352, true);
    q1.setFloat32(76, 1, true);
    q1.setFloat32(80, 1, true);
    q1.setFloat32(84, 1, true);
    q1.setFloat32(88, 1, true);
    q1.setInt16(252, 1, true);
    q1.setFloat32(256, Math.fround(1 - 2 ** -23), true);
    const aff1 = extractNibabelAffine(q1Buf);
    assert.equal(aff1[0][0], 1, "quat2mat normalizes by nq so first column is exact [1, 0, 0]");
    assert.equal(aff1[1][1], -1);
    assert.equal(aff1[2][2], -1);
    assert.equal(aff1[1][2], 0, "w=0 when |w^2| < 3*f32_eps");

    // NIfTI-2 Sol case: b = 1 + eps, c = sqrt(0.875*eps) => exact w^2 = -2.875*eps => w = 0
    const q2Buf = buf.slice(0);
    const q2 = new DataView(q2Buf);
    q2.setInt32(348, 0, true); // disable sform so qform is used
    q2.setInt32(344, 1, true);
    q2.setFloat64(352, 1 + Number.EPSILON, true);
    q2.setFloat64(360, Math.sqrt(0.875 * Number.EPSILON), true);
    q2.setFloat64(368, 0, true);
    const aff2 = extractNibabelAffine(q2Buf);
    assert.ok(Number.isFinite(aff2[0][0]), "NIfTI-2 exact Dekker/Shewchuk quaternion accepted");
    q2.setFloat64(352, 1 + 2 * Number.EPSILON, true);
    q2.setFloat64(360, 0, true);
    assert.throws(() => extractNibabelAffine(q2Buf), /Invalid NIfTI quaternion/);

    // Strict plain-object, non-enumerable & symbol unknown keys, inherited prototype, and null alias validation
    assert.throws(() => parseCliOptions(new Date()), /plain object/);
    assert.throws(() => parseCliOptions(Object.create({ overwrite: true })), /plain object/);
    assert.throws(() => parseCliOptions({ unknownKey: undefined }), /Unknown option/);
    const nonEnumOpt = {};
    Object.defineProperty(nonEnumOpt, "hidden", { value: undefined, enumerable: false });
    assert.throws(() => parseCliOptions(nonEnumOpt), /Unknown option/);
    assert.throws(() => parseCliOptions({ [Symbol("extra")]: undefined }), /Unknown option/);
    assert.throws(() => parseCliOptions({ "min-coherency": null }), /finite number/);
    await assert.rejects(() => checkInstallation(new Date()), /plain object/);
    await assert.rejects(() => checkInstallation({ extra: undefined }), /Unknown option/);
    await assert.rejects(() => checkInstallation({ [Symbol("extra")]: 1 }), /Unknown option/);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("Sol r3: JPEG APP2 ICC_PROFILE validation, RGB JPEG rounding parity, and atomic output safety", async () => {
  const work = mkdtempSync(join(tmpdir(), "st-sol-r3-"));
  try {
    // 1. RGB JPEG rounded YCbCr parity: solid [200, 100, 50] decodes to exact (200+100+50)/3 = 116.6667 (matching Chromium)
    const solidRgba = new Uint8Array(16 * 16 * 4);
    for (let i = 0; i < 256; i += 1) {
      solidRgba[4 * i] = 200;
      solidRgba[4 * i + 1] = 100;
      solidRgba[4 * i + 2] = 50;
      solidRgba[4 * i + 3] = 255;
    }
    const baseJpg = Buffer.from(jpeg.encode({ data: solidRgba, width: 16, height: 16 }, 95).data);
    const solidPath = join(work, "solid.jpg");
    writeFileSync(solidPath, baseJpg);
    const solidDecoded = await readImageFile(solidPath);
    assert.ok(
      Math.abs(solidDecoded.image.data[0] - (200 + 100 + 50) / 3) < 1e-6,
      `expected exact 116.6667, got ${solidDecoded.image.data[0]}`,
    );

    // 2. JPEG APP2 ICC_PROFILE invalid sequences rejected (seq=0, count=0, seq>count, mismatched count, duplicate seq, missing segment)
    const makeApp2 = (seqNo, count, body = Buffer.alloc(8)) => {
      const payload = Buffer.concat([Buffer.from("ICC_PROFILE\0"), Buffer.from([seqNo, count]), body]);
      const seg = Buffer.alloc(4 + payload.length);
      seg[0] = 0xff;
      seg[1] = 0xe2;
      seg.writeUInt16BE(2 + payload.length, 2);
      payload.copy(seg, 4);
      return seg;
    };
    const injectApp2 = (...segs) => Buffer.concat([baseJpg.subarray(0, 2), ...segs, baseJpg.subarray(2)]);
    for (const [name, buf] of [
      ["seq0.jpg", injectApp2(makeApp2(0, 1))],
      ["count0.jpg", injectApp2(makeApp2(1, 0))],
      ["seqgt.jpg", injectApp2(makeApp2(2, 1))],
      ["mismatch.jpg", injectApp2(makeApp2(1, 2), makeApp2(2, 3))],
      ["dup.jpg", injectApp2(makeApp2(1, 2), makeApp2(1, 2))],
      ["missing.jpg", injectApp2(makeApp2(1, 2))],
    ]) {
      const p = join(work, name);
      writeFileSync(p, buf);
      await assert.rejects(() => readImageFile(p), /ICC_PROFILE/);
    }

    // 3. Failed unlinkSync(partialPath) after linkSync rolls back already-linked finalPath
    const unlinkDir = join(work, "unlink-fail");
    const claimUnlink = await claimOutputDir(unlinkDir, { overwrite: false });
    await assert.rejects(
      () => commitOutputs(
        unlinkDir,
        [{ name: "a.tif", data: Buffer.from("payload") }],
        {
          overwrite: false,
          claim: claimUnlink,
          unlinkFn: () => {
            const err = new Error("unlink denied");
            err.code = "EACCES";
            throw err;
          },
        },
      ),
      /unlink denied/,
    );
    assert.equal(existsSync(join(unlinkDir, "a.tif")), false, "finalPath must be rolled back when unlink(partial) fails");
    await claimUnlink.release({ removeCreated: true });

    // 4. Missing .backup during rollback marks rollback failed and retains .neurodesk-cli.lock
    const missingBkDir = join(work, "missing-backup");
    const claimBk = await claimOutputDir(missingBkDir, { overwrite: true });
    writeFileSync(join(missingBkDir, "a.tif"), "orig-a");
    let bkPath = null;
    await assert.rejects(
      () => commitOutputs(
        missingBkDir,
        [
          { name: "a.tif", data: Buffer.from("new-a") },
          { name: "b.tif", data: Buffer.from("new-b") },
        ],
        {
          overwrite: true,
          claim: claimBk,
          renameFn: async (src, dst) => {
            if (dst.endsWith(".backup")) {
              bkPath = dst;
              await rename(src, dst);
              return;
            }
            // Delete backup before failing publish so rollback gets ENOENT on restore
            if (bkPath && existsSync(bkPath)) unlinkSync(bkPath);
            throw new Error("publish boom");
          },
        },
      ),
      /publish boom/,
    );
    await claimBk.release();
    assert.equal(existsSync(join(missingBkDir, LOCK_NAME)), true, "lock must stay on disk when backup is missing during rollback");

    // 5. !overwrite NEVER routes through renameFn even when a custom renameFn is supplied
    const noOvDir = join(work, "no-overwrite-custom-rename");
    const claimNoOv = await claimOutputDir(noOvDir, { overwrite: false });
    let renameCalled = false;
    await assert.rejects(
      () => commitOutputs(
        noOvDir,
        [{ name: "a.tif", data: Buffer.from("new") }],
        {
          overwrite: false,
          claim: claimNoOv,
          writeFileFn: async (p, data) => {
            writeFileSync(p, data);
            writeFileSync(join(noOvDir, "a.tif"), "raced-winner");
          },
          renameFn: async (src, dst) => {
            renameCalled = true;
            await rename(src, dst);
          },
        },
      ),
      /already exists/,
    );
    assert.equal(renameCalled, false, "renameFn must never be called when overwrite is false");
    assert.equal(readFileSync(join(noOvDir, "a.tif"), "utf8"), "raced-winner");
    await claimNoOv.release();

    // 6. Raced symlink during --overwrite backup is detected, restored intact, and never overwritten
    const symDir = join(work, "raced-sym");
    const claimSym = await claimOutputDir(symDir, { overwrite: true });
    const precious = join(work, "precious.txt");
    writeFileSync(precious, "keep-me");
    writeFileSync(join(symDir, "a.tif"), "regular-before-race");
    await assert.rejects(
      () => commitOutputs(
        symDir,
        [{ name: "a.tif", data: Buffer.from("attacker") }],
        {
          overwrite: true,
          claim: claimSym,
          renameFn: async (src, dst) => {
            if (dst.endsWith(".backup")) {
              // Simulate TOCTOU: another process replaces a.tif with a symlink just before backup rename
              unlinkSync(src);
              symlinkSync(precious, src);
            }
            await rename(src, dst);
          },
        },
      ),
      /symbolic link/,
    );
    assert.equal(lstatSync(join(symDir, "a.tif")).isSymbolicLink(), true, "raced symlink must be restored intact");
    assert.equal(readFileSync(precious, "utf8"), "keep-me");
    await claimSym.release();

    // 7. Raced symlink during --overwrite publish (when target did not exist at backup time) is caught & restored
    const symPubDir = join(work, "raced-sym-pub");
    const claimSymPub = await claimOutputDir(symPubDir, { overwrite: true });
    await assert.rejects(
      () => commitOutputs(
        symPubDir,
        [{ name: "a.tif", data: Buffer.from("attacker") }],
        {
          overwrite: true,
          claim: claimSymPub,
          writeFileFn: async (p, data) => {
            writeFileSync(p, data);
            symlinkSync(precious, join(symPubDir, "a.tif"));
          },
        },
      ),
      /symbolic link/,
    );
    assert.equal(lstatSync(join(symPubDir, "a.tif")).isSymbolicLink(), true, "raced symlink must stay intact");
    assert.equal(readFileSync(precious, "utf8"), "keep-me");
    await claimSymPub.release();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});
