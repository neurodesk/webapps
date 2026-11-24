import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkInstallation, denoiseFile, parseCliOptions } from "../src/node.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import { stackNifti, stackTiff } from "../src/format.js";
import { readVolume } from "../src/input.js";

const BIN = fileURLToPath(new URL("../bin/denoise.js", import.meta.url));

function syntheticTiff(dims, sigma = 8, seed = 11) {
  const [nz, ny, nx] = dims;
  const data = new Float32Array(nz * ny * nx);
  const randn = createNormalRng(createRng(seed));
  for (let z = 0; z < nz; z += 1) {
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        data[(z * ny + y) * nx + x] = 60 + 35 * Math.sin(x / 4) * Math.cos(y / 4) + randn() * sigma;
      }
    }
  }
  return new Uint8Array(stackTiff(data, dims, { x: 0.3, y: 0.3, z: 0 }));
}

test("parseCliOptions validates flags and defaults", () => {
  const parsed = parseCliOptions({ method: "fgr-gbdt", trees: "40", depth: "3", "max-scale": "4", residual: true });
  assert.equal(parsed.settings.method, "fgr-gbdt");
  assert.equal(parsed.settings.nTrees, 40);
  assert.equal(parsed.settings.maxDepth, 3);
  assert.equal(parsed.settings.maxScale, 4);
  assert.equal(parsed.residual, true);
  assert.equal(parsed.format, "auto");

  assert.throws(() => parseCliOptions({ format: "png" }), /--format/);
  assert.throws(() => parseCliOptions({ method: "zs-n2n", iterations: "12.5" }), /integer/);
});

test("checkInstallation passes offline self-check", async () => {
  const info = await checkInstallation();
  assert.equal(info.ok, true);
  assert.equal(info.package, "@neurodesk/denoise");
  assert.deepEqual(info.methods, ["fgr-gbdt", "fgr-ridge", "zs-n2n", "vst-nlm"]);
});

test("denoiseFile writes calibrated TIFF/NIfTI, residual, and provenance, and guards non-empty dirs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-node-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 32, 32]));
    const outDir = join(dir, "out");

    const res = await denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "fgr-ridge", "max-scale": "4", format: "both", residual: true },
    });

    assert.equal(res.outputs.length, 5);
    assert.ok(res.diagnostics.noiseFloorDropDb > 0);

    const outTiff = await readVolume(new File([await readFile(join(outDir, "sample_denoised.tif"))], "sample_denoised.tif"));
    assert.deepEqual(outTiff.dims, [1, 32, 32]);
    assert.ok(Math.abs(outTiff.spacingUm.x - 0.3) < 1e-4);

    // Refuses non-empty output directory without --overwrite.
    await assert.rejects(
      () => denoiseFile({ input: inputPath, outputDir: outDir, options: { method: "fgr-ridge" } }),
      /not empty/i,
    );

    // Succeeds with --overwrite.
    const rerun = await denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "fgr-ridge", overwrite: true },
    });
    assert.ok(rerun.outputs.length >= 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("CLI executable supports --help, self-check, download-models, and denoising", async () => {
  const help = spawnSync(process.execPath, [BIN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /Usage: denoise/);

  const self = spawnSync(process.execPath, [BIN, "self-check"], { encoding: "utf8" });
  assert.equal(self.status, 0);
  assert.equal(JSON.parse(self.stdout).ok, true);

  const dl = spawnSync(process.execPath, [BIN, "download-models"], { encoding: "utf8" });
  assert.equal(dl.status, 0);
  assert.match(dl.stdout, /0 model files/);

  const dir = await mkdtemp(join(tmpdir(), "denoise-bin-test-"));
  try {
    const inputPath = join(dir, "cells.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));
    const outDir = join(dir, "results");
    const run = spawnSync(process.execPath, [BIN, inputPath, outDir, "--method", "vst-nlm", "--noise-model", "gaussian"], {
      encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout.trim(), /cells_denoised\.tif$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("concurrent CLI runs to the same empty output directory cannot overwrite each other", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-race-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 48, 48]));
    const outDir = join(dir, "shared-out");
    await mkdir(outDir);

    const runAsync = (args) =>
      new Promise((resolvePromise) => {
        const child = spawn(process.execPath, [BIN, ...args], { stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk) => { stderr += chunk; });
        child.on("close", (code) => resolvePromise({ code, stderr }));
      });

    const [a, b] = await Promise.all([
      runAsync([inputPath, outDir, "--method", "fgr-gbdt", "--trees", "30", "--max-scale", "4"]),
      runAsync([inputPath, outDir, "--method", "vst-nlm", "--noise-model", "gaussian"]),
    ]);

    const successes = [a, b].filter((r) => r.code === 0);
    const failures = [a, b].filter((r) => r.code !== 0);
    assert.equal(successes.length, 1, `expected exactly 1 winner, got a=${a.code} b=${b.code}`);
    assert.equal(failures.length, 1);
    assert.match(failures[0].stderr, /locked|not empty/i);

    const entries = await readdir(outDir);
    assert.deepEqual(entries.sort(), ["sample_denoised.tif", "sample_provenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a blocked target path leaves no partial image or staged files behind", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-atomic-test-"));
  try {
    const inputPath = join(dir, "sample.tif");
    await writeFile(inputPath, syntheticTiff([1, 24, 24]));
    const outDir = join(dir, "out");
    await mkdir(outDir);
    await mkdir(join(outDir, "sample_provenance.json"));

    await assert.rejects(
      () => denoiseFile({
        input: inputPath,
        outputDir: outDir,
        options: { method: "fgr-ridge", "max-scale": "4", overwrite: true },
      }),
      /is a directory/i,
    );

    const entries = await readdir(outDir);
    assert.deepEqual(entries, ["sample_provenance.json"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("single-axis XY calibration in a 2D+T OME-TIFF is preserved without fabricating the unspecified axis", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-single-axis-test-"));
  try {
    const dims = [3, 24, 24];
    const data = new Float32Array(3 * 24 * 24);
    const randn = createNormalRng(createRng(19));
    for (let i = 0; i < data.length; i += 1) data[i] = 50 + 20 * Math.sin(i / 7) + randn() * 4;
    const tiffBytes = stackTiff(data, dims, { x: 0.25, y: null, z: null }, { axisKind: "t", frameInterval: 0.5 });

    const inVol = await readVolume(new File([tiffBytes], "movie.ome.tif"));
    assert.equal(inVol.axisKind, "t");
    assert.ok(Math.abs(inVol.spacingUm.x - 0.25) < 1e-6);
    assert.equal(inVol.spacingUm.y, null);
    assert.ok(Math.abs(inVol.frameInterval - 0.5) < 1e-6);

    const inputPath = join(dir, "movie.ome.tif");
    await writeFile(inputPath, new Uint8Array(tiffBytes));
    const outDir = join(dir, "out");
    await denoiseFile({
      input: inputPath,
      outputDir: outDir,
      options: { method: "vst-nlm", "noise-model": "gaussian", format: "auto" },
    });

    const outVol = await readVolume(new File([await readFile(join(outDir, "movie_denoised.tif"))], "movie_denoised.tif"));
    assert.equal(outVol.axisKind, "t");
    assert.deepEqual(outVol.dims, [3, 24, 24]);
    assert.ok(Math.abs(outVol.spacingUm.x - 0.25) < 1e-6);
    assert.equal(outVol.spacingUm.y, null);
    assert.ok(Math.abs(outVol.frameInterval - 0.5) < 1e-6);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("readVolume rejects rank-4 NIfTI with non-temporal 4th-axis units (Hz, ppm, rad/s)", async () => {
  const data = new Float32Array(3 * 16 * 16).fill(10);
  const base = stackNifti(data, [3, 16, 16], { x: 1, y: 1, z: 1 }, { axisKind: "t", frameInterval: 1 });
  for (const [code, label] of [[32, /Hz/], [40, /ppm/], [48, /rad\/s/]]) {
    const copy = base.slice(0);
    new DataView(copy).setUint8(123, 2 | code);
    await assert.rejects(
      () => readVolume(new File([copy], "spectrum.nii")),
      label,
    );
  }
});

test("denoiseFile enforces maxFileBytes before reading file bytes into memory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "denoise-limit-test-"));
  try {
    const inputPath = join(dir, "big.tif");
    await writeFile(inputPath, syntheticTiff([1, 32, 32]));
    const outDir = join(dir, "out");
    await assert.rejects(
      () => denoiseFile({ input: inputPath, outputDir: outDir, maxBytes: 1024, maxFileBytes: 1024 }),
      /too large/i,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
