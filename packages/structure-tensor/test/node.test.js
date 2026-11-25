import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";
import { decode as decodePng, encode as encodePng } from "fast-png";
import {
  analyseStructureTensorFile,
  boundedGunzip,
  checkInstallation,
  claimOutputDir,
  commitOutputs,
  extractNibabelAffine,
  parseCliOptions,
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
    await assert.rejects(() => claimOutputDir(outDir), /already in use/);
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
