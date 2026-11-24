#!/usr/bin/env node
// Portable release validation for @neurodesk/denoise.
// Runs the packaged executable (or bin/denoise.js) across 2D TIFF, 3D Z-stack TIFF,
// and 2D+T NIfTI inputs for all four denoising methods, verifying noise reduction,
// calibration preservation, residual accuracy, and voxel parity with @neurodesk/denoise/core.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gzipSync } from "node:zlib";
import { denoiseVolume } from "../src/core/denoise.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import { stackNifti, stackTiff } from "../src/format.js";
import { readVolume } from "../src/input.js";

const { values } = parseArgs({ options: { executable: { type: "string" } } });
const command = values.executable
  ? [resolve(values.executable)]
  : [process.execPath, fileURLToPath(new URL("../bin/denoise.js", import.meta.url))];

const failures = [];
function check(passed, message) {
  if (!passed) failures.push(message);
  console.log(`${passed ? "PASS" : "FAIL"} ${message}`);
}

function psnr(estimate, truth) {
  let mse = 0;
  let maxVal = -Infinity;
  let minVal = Infinity;
  for (let i = 0; i < truth.length; i += 1) {
    const d = estimate[i] - truth[i];
    mse += d * d;
    if (truth[i] > maxVal) maxVal = truth[i];
    if (truth[i] < minVal) minVal = truth[i];
  }
  mse /= truth.length;
  const range = Math.max(1e-6, maxVal - minVal);
  return mse <= 0 ? Infinity : 20 * Math.log10(range / Math.sqrt(mse));
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < a.length; i += 1) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

function makePhantom([nz, ny, nx], sigma, seed) {
  const clean = new Float32Array(nz * ny * nx);
  const noisy = new Float32Array(nz * ny * nx);
  const randn = createNormalRng(createRng(seed));
  for (let z = 0; z < nz; z += 1) {
    const phase = z * 0.25;
    for (let y = 0; y < ny; y += 1) {
      for (let x = 0; x < nx; x += 1) {
        const idx = (z * ny + y) * nx + x;
        const val = 80
          + 55 * Math.sin((x + phase) / 4.5) * Math.cos((y - phase) / 4.5)
          + 30 * Math.exp(-(((x - nx * 0.5) ** 2 + (y - ny * 0.5) ** 2) / (2 * 64)));
        clean[idx] = val;
        noisy[idx] = val + randn() * sigma;
      }
    }
  }
  return { clean, noisy };
}

function runCli(args) {
  const run = spawnSync(command[0], [...command.slice(1), ...args], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (run.error) throw run.error;
  return run;
}

const work = await mkdtemp(join(tmpdir(), "denoise-cli-check-"));
try {
  // 1. self-check
  const selfCheck = runCli(["self-check"]);
  check(selfCheck.status === 0, `self-check exits 0 (status ${selfCheck.status})`);
  const selfInfo = JSON.parse(selfCheck.stdout.trim());
  check(selfInfo.ok === true && Array.isArray(selfInfo.methods) && selfInfo.methods.length === 4,
    `self-check reports ok=true and all 4 methods (${selfInfo.version})`);

  // 2. 2D calibrated TIFF across all 4 methods
  const p2d = makePhantom([1, 48, 48], 10, 101);
  const in2dPath = join(work, "nuclei_2d.tif");
  await writeFile(in2dPath, new Uint8Array(stackTiff(p2d.noisy, [1, 48, 48], { x: 0.25, y: 0.25, z: 0 })));
  const rawPsnr2d = psnr(p2d.noisy, p2d.clean);

  const cases = [
    { id: "fgr-gbdt", args: ["--method", "fgr-gbdt", "--trees", "30", "--depth", "4", "--max-scale", "4", "--seed", "7", "--residual"], settings: { method: "fgr-gbdt", nTrees: 30, maxDepth: 4, maxScale: 4, seed: 7 } },
    { id: "fgr-ridge", args: ["--method", "fgr-ridge", "--max-scale", "4", "--seed", "7"], settings: { method: "fgr-ridge", maxScale: 4, seed: 7 } },
    { id: "zs-n2n", args: ["--method", "zs-n2n", "--iterations", "80", "--channels", "16", "--seed", "7"], settings: { method: "zs-n2n", iterations: 80, channels: 16, seed: 7 } },
    { id: "vst-nlm", args: ["--method", "vst-nlm", "--noise-model", "gaussian", "--nlm-strength", "1.0"], settings: { method: "vst-nlm", noiseModel: "gaussian", nlmStrength: 1.0 } },
  ];

  for (const item of cases) {
    const outDir = join(work, `out-${item.id}`);
    const run = runCli([in2dPath, outDir, ...item.args]);
    check(run.status === 0, `${item.id}: CLI exits 0${run.status ? ` (${run.stderr.trim()})` : ""}`);
    const outPath = join(outDir, "nuclei_2d_denoised.tif");
    const outBytes = await readFile(outPath);
    const outVol = await readVolume(new File([outBytes], "nuclei_2d_denoised.tif"));
    const ref = denoiseVolume(p2d.noisy, [1, 48, 48], item.settings);
    const diff = maxAbsDiff(outVol.data, ref.denoised);
    const outPsnr = psnr(outVol.data, p2d.clean);
    check(diff <= 1e-5, `${item.id}: voxel parity with core (max diff ${diff.toExponential(2)})`);
    check(outPsnr > rawPsnr2d + 2, `${item.id}: improves PSNR ${rawPsnr2d.toFixed(1)} -> ${outPsnr.toFixed(1)} dB`);
    check(Math.abs(outVol.spacingUm.x - 0.25) < 1e-4 && Math.abs(outVol.spacingUm.y - 0.25) < 1e-4,
      `${item.id}: preserves XY micrometre calibration (${outVol.spacingUm.x}, ${outVol.spacingUm.y})`);
    const prov = JSON.parse(await readFile(join(outDir, "nuclei_2d_provenance.json"), "utf8"));
    check(prov.methodId === item.id && prov.diagnostics.noiseFloorDropDb > 0, `${item.id}: writes valid provenance JSON`);
    if (item.args.includes("--residual")) {
      const resBytes = await readFile(join(outDir, "nuclei_2d_residual.tif"));
      const resVol = await readVolume(new File([resBytes], "nuclei_2d_residual.tif"));
      check(maxAbsDiff(resVol.data, ref.residual) <= 1e-5, `${item.id}: residual TIFF matches core`);
    }
  }

  // 3. 3D Z-stack TIFF + --format both
  const p3d = makePhantom([5, 32, 32], 10, 202);
  const in3dPath = join(work, "stack_3d.tif");
  await writeFile(in3dPath, new Uint8Array(stackTiff(p3d.noisy, [5, 32, 32], { x: 0.5, y: 0.5, z: 1.5 })));
  const out3dDir = join(work, "out-3d");
  const run3d = runCli([in3dPath, out3dDir, "--method", "fgr-ridge", "--max-scale", "4", "--format", "both"]);
  check(run3d.status === 0, `3d-stack: CLI exits 0`);
  const out3dNii = await readVolume(new File([await readFile(join(out3dDir, "stack_3d_denoised.nii.gz"))], "stack_3d_denoised.nii.gz"));
  check(out3dNii.dims.join("x") === "5x32x32" && out3dNii.axisKind === "z",
    `3d-stack: NIfTI export keeps 5x32x32 Z-stack geometry`);

  // 4. 2D+T NIfTI preserves dim[4] and frameInterval
  const p2dt = makePhantom([4, 32, 32], 10, 303);
  const in2dtPath = join(work, "movie_2dt.nii.gz");
  await writeFile(
    in2dtPath,
    gzipSync(new Uint8Array(stackNifti(p2dt.noisy, [4, 32, 32], { x: 0.4, y: 0.4, z: 1 }, { axisKind: "t", frameInterval: 0.25 }))),
  );
  const out2dtDir = join(work, "out-2dt");
  const run2dt = runCli([in2dtPath, out2dtDir, "--method", "vst-nlm", "--noise-model", "gaussian"]);
  check(run2dt.status === 0, `2d+t-nifti: CLI exits 0`);
  const out2dtVol = await readVolume(new File([await readFile(join(out2dtDir, "movie_2dt_denoised.nii.gz"))], "movie_2dt_denoised.nii.gz"));
  check(
    out2dtVol.dims.join("x") === "4x32x32" && out2dtVol.axisKind === "t" && Math.abs(out2dtVol.frameInterval - 0.25) < 1e-4,
    `2d+t-nifti: preserves 4 frames and 0.25 s interval`,
  );
} finally {
  await rm(work, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed:\n- ${failures.join("\n- ")}`);
  process.exit(1);
}
console.log("\nAll @neurodesk/denoise portable CLI checks passed.");
