import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkInstallation, denoiseFile, parseCliOptions } from "../src/node.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import { stackTiff } from "../src/format.js";
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
