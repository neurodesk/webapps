import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { encode as encodePng } from "fast-png";
import jpeg from "jpeg-js";
import { scalarNifti } from "../src/core/nifti.js";
import { parseStrictNiftiHeader, readStrictNiftiVolume } from "../src/nifti-io.js";
import {
  checkInstallation,
  claimOutputDirectory,
  decodeJpegSection,
  decodePngSection,
  parseCliOptions,
  runHisto2Mri,
  writeStagedOutputs,
} from "../src/node.js";

const binPath = fileURLToPath(new URL("../bin/histo2mri.js", import.meta.url));

function runCli(args) {
  return spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
}

test("CLI rejects empty string flags, invalid ranges, and disallowed subcommand flags", () => {
  for (const args of [
    ["--axis=", "mri.nii.gz", "sec.tif", "out"],
    ["--slice=", "mri.nii.gz", "sec.tif", "out"],
    ["--cache-dir=", "self-check"],
    ["self-check", "--axis", "2"],
    ["self-check", "--offline"],
    ["self-check", "extra"],
    ["mri.nii.gz", "sec.tif", "out", "--cache-dir", "/tmp"],
    ["mri.nii.gz", "sec.tif", "out", "--axis", "z"],
    ["mri.nii.gz", "sec.tif", "out", "--contrast", "bogus"],
    ["mri.nii.gz", "sec.tif", "out", "--orientation", "9"],
    ["mri.nii.gz", "sec.tif", "out", "--tilt-a", "45"],
    ["mri.nii.gz", "sec.tif", "out", "--linear-iterations", "bad"],
    ["mri.nii.gz", "sec.tif"],
  ]) {
    const res = runCli(args);
    assert.notEqual(res.status, 0, `expected failure for ${args.join(" ")}`);
  }
  const help = runCli(["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: histo2mri/);
});

test("parseCliOptions validates enums, axis aliases, and schedules before I/O", () => {
  assert.throws(() => parseCliOptions({ axis: "3" }), /Option --axis/);
  assert.throws(() => parseCliOptions({ contrast: "nissl" }), /Option --contrast/);
  assert.throws(() => parseCliOptions({ "search-offset": "15" }), /Option --search-offset/);
  assert.throws(() => parseCliOptions({ "deformable-iterations": "10x" }), /Option --deformable-iterations/);
  const ok = parseCliOptions({ axis: "j", slice: "12", contrast: "eosin", "no-deformable": true });
  assert.equal(ok.axis, 1);
  assert.equal(ok.sliceIndex, 12);
  assert.equal(ok.contrast, "eosin");
  assert.equal(ok.deformable, false);
});

test("readStrictNiftiVolume enforces NiBabel sform > qform > LAS-centered fallback and post-Float32 finiteness", () => {
  const dims = [4, 6, 8];
  const voxels = new Float32Array(4 * 6 * 8).fill(10);
  const base = scalarNifti(voxels, dims, [[2, 0, 0, 10], [0, 3, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]]);
  const raw = new Uint8Array(base);
  const view = new DataView(raw.buffer);

  // Set qform_code = 1 with distinct qoffset while sform_code = 2: sform wins, both preserved
  view.setInt16(252, 1, true);
  view.setFloat32(268, 99, true);
  const both = parseStrictNiftiHeader(raw);
  assert.equal(both.sformCode, 2);
  assert.equal(both.qformCode, 1);
  assert.equal(both.affine[0][3], 10);
  assert.equal(both.qformAffine[0][3], 99);
  assert.equal(both.sformAffine[0][3], 10);

  // Clear sform_code -> qform wins
  view.setInt16(254, 0, true);
  const qOnly = parseStrictNiftiHeader(raw);
  assert.equal(qOnly.affine[0][3], 99);

  // Clear qform_code too -> exact NiBabel LAS-centered fallback
  view.setInt16(252, 0, true);
  const fallback = parseStrictNiftiHeader(raw);
  assert.deepEqual(fallback.affine, [
    [-2, 0, 0, 2 * 1.5],
    [0, 3, 0, -3 * 2.5],
    [0, 0, 4, -4 * 3.5],
    [0, 0, 0, 1],
  ]);

  // Bounded gunzipSync rejects oversized decompressed payloads and bad CRC32
  const gz = gzipSync(raw);
  assert.throws(() => readStrictNiftiVolume(gz, { maxDecompressedBytes: 100 }), /Failed to decompress/);
  const corrupt = new Uint8Array(gz);
  corrupt[corrupt.length - 6] ^= 0xff;
  assert.throws(() => readStrictNiftiVolume(corrupt), /Failed to decompress/);

  // Float64 value finite in JS Number (1e300) overflows to Infinity after Float32 narrowing -> rejected!
  const f64Buf = new Uint8Array(352 + 8 * 8);
  f64Buf.set(raw.subarray(0, 352));
  const f64View = new DataView(f64Buf.buffer);
  f64View.setInt16(42, 2, true);
  f64View.setInt16(44, 2, true);
  f64View.setInt16(46, 2, true);
  f64View.setInt16(70, 64, true); // FLOAT64
  f64View.setInt16(72, 64, true);
  f64View.setFloat64(352, 1e300, true);
  assert.throws(() => readStrictNiftiVolume(f64Buf), /non-finite intensities after Float32 conversion/);
});

test("PNG and JPEG decoders work in pure Node without browser DOM/Canvas", () => {
  const width = 8;
  const height = 6;
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    rgba[i * 4] = 200;
    rgba[i * 4 + 1] = 100;
    rgba[i * 4 + 2] = 50;
    rgba[i * 4 + 3] = 255;
  }
  const pngBytes = encodePng({ width, height, data: rgba, channels: 4, depth: 8 });
  const pngSec = decodePngSection(pngBytes, "test.png");
  assert.equal(pngSec.width, width);
  assert.equal(pngSec.height, height);
  assert.equal(pngSec.channels, 3);
  assert.equal(pngSec.data[0], 200);
  assert.equal(pngSec.data[1], 100);
  assert.equal(pngSec.data[2], 50);

  const jpgBytes = jpeg.encode({ width, height, data: Buffer.from(rgba) }, 95).data;
  const jpgSec = decodeJpegSection(new Uint8Array(jpgBytes), "test.jpg");
  assert.equal(jpgSec.width, width);
  assert.equal(jpgSec.height, height);
  assert.equal(jpgSec.channels, 3);
});

test("self-check honors --cache-dir and exercises Greedy WASM registration offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-self-check-"));
  try {
    const info = await checkInstallation({ cacheDir: work });
    assert.equal(info.ok, true);
    assert.equal(info.greedy, "wasm-single");
    assert.equal(info.cacheDir, work);
    assert.ok(info.phantom.nmiFinal > 1.2);

    const cli = runCli(["self-check", "--cache-dir", work]);
    assert.equal(cli.status, 0, cli.stderr);
    const parsed = JSON.parse(cli.stdout.trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.cacheDir, work);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("claimOutputDirectory enforces O_EXCL exclusivity and cleans up newly created dir on failure", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-lock-"));
  try {
    const fresh = join(work, "fresh");
    const claim = await claimOutputDirectory(fresh);
    await assert.rejects(claimOutputDirectory(fresh), /already in use/);
    await claim.release({ removeDirIfEmpty: true });
    await assert.rejects(stat(fresh), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("writeStagedOutputs rolls back renamed outputs on mid-batch rename failure", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-stage-"));
  try {
    let calls = 0;
    await assert.rejects(
      writeStagedOutputs(
        work,
        [
          { name: "a.nii.gz", bytes: new Uint8Array([1]) },
          { name: "b.mat", bytes: new Uint8Array([2]) },
        ],
        {
          renameFn: async (src, dst) => {
            calls += 1;
            if (calls === 2) throw new Error("rename fail");
            return rename(src, dst);
          },
        },
      ),
      /rename fail/,
    );
    assert.deepEqual(await readdir(work), []);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("runHisto2Mri registers a PNG section to a gzipped NIfTI MRI offline", async () => {
  const work = await mkdtemp(join(tmpdir(), "histo2mri-e2e-"));
  try {
    const nu = 48;
    const nv = 48;
    const nz = 7;
    const slice = new Float32Array(nu * nv);
    for (let j = 0; j < nv; j++) {
      for (let i = 0; i < nu; i++) {
        const dx = (i - 24) / 1.15;
        const dy = j - 24;
        const r = Math.hypot(dx, dy);
        slice[j * nu + i] = r < 16 ? (r > 12 ? 600 : 950) : 0;
      }
    }
    const volData = new Float32Array(nu * nv * nz);
    for (let k = 0; k < nz; k++) volData.set(slice, k * nu * nv);
    const mriNii = scalarNifti(volData, [nu, nv, nz], [[1, 0, 0, -24], [0, 1, 0, -24], [0, 0, 1, -3], [0, 0, 0, 1]]);
    const mriPath = join(work, "brain.nii.gz");
    await writeFile(mriPath, gzipSync(mriNii));

    const rgb = new Uint8Array(nu * nv * 3);
    for (let i = 0; i < nu * nv; i++) {
      const v = Math.round((slice[i] / 1000) * 255);
      rgb[i * 3] = v;
      rgb[i * 3 + 1] = v;
      rgb[i * 3 + 2] = v;
    }
    const secPath = join(work, "sec01.png");
    await writeFile(secPath, encodePng({ width: nu, height: nv, data: rgb, channels: 3, depth: 8 }));

    const outDir = join(work, "out");
    const result = await runHisto2Mri({
      mriPath,
      sectionPaths: [secPath],
      outputDir: outDir,
      options: {
        axis: "2",
        slice: "3",
        orientation: "0",
        "pixel-size": "1000",
        "no-refine-plane": true,
        "no-deformable": true,
        "linear-iterations": "20x10x0",
      },
    });
    for (const expected of [
      "sec01_warped_rgba.nii.gz",
      "sec01_mri_plane.nii.gz",
      "sec01_section.nii.gz",
      "sec01_affine.mat",
      "sec01_registration.json",
      "sections_in_mri.nii.gz",
    ]) {
      assert.ok(result.files.includes(expected), `missing ${expected}`);
    }
    const report = JSON.parse(await readFile(join(outDir, "sec01_registration.json"), "utf8"));
    assert.equal(report.app, "histo2mri");
    assert.ok(report.nmi.final > 1.2, `expected high NMI, got ${report.nmi.final}`);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
