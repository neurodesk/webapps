import assert from "node:assert/strict";
import test from "node:test";
import { denoiseVolume, effectiveSettings, runSettings } from "../src/core/denoise.js";
import { extractSliceFeatures, featureNames, mirrorIndex } from "../src/core/features.js";
import { estimateNoiseSigma, estimatePoissonGaussian, residualDiagnostics } from "../src/core/metrics.js";
import { createNormalRng, createRng } from "../src/core/rng.js";
import { denoiseVstNlm, forwardGat, gatInverseZeroRoot, inverseGat } from "../src/core/vst-nlm.js";
import { createZsN2nModel, pairDownsample, zsN2nLossAndGrad } from "../src/core/zsn2n.js";

function psnr(clean, estimate, maxVal) {
  let mse = 0;
  for (let i = 0; i < clean.length; i += 1) {
    const d = clean[i] - estimate[i];
    mse += d * d;
  }
  mse /= clean.length;
  return mse <= 1e-12 ? 99 : 10 * Math.log10((maxVal * maxVal) / mse);
}

function syntheticFluorescence2d(ny, nx) {
  const clean = new Float32Array(ny * nx);
  const blobs = [
    [ny * 0.25, nx * 0.3, 12, 220],
    [ny * 0.65, nx * 0.7, 15, 190],
    [ny * 0.35, nx * 0.75, 8, 250],
    [ny * 0.75, nx * 0.28, 10, 170],
  ];
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      let v = 25;
      for (const [cy, cx, r, amp] of blobs) {
        const d2 = (y - cy) ** 2 + (x - cx) ** 2;
        v += amp * Math.exp(-d2 / (2 * r * r));
      }
      const distLine = Math.abs((y - ny * 0.15) - 0.7 * (x - nx * 0.15)) / Math.hypot(1, 0.7);
      v += 130 * Math.exp(-(distLine * distLine) / 6);
      clean[y * nx + x] = v;
    }
  }
  return clean;
}

function addGaussianNoise(clean, sigma, seed = 101) {
  const randn = createNormalRng(createRng(seed));
  const noisy = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i += 1) noisy[i] = clean[i] + sigma * randn();
  return noisy;
}

/** Exact Knuth Poisson draw for small lambda (< 30) and PTRD / normal+skew draw for larger lambda. */
function samplePoisson(lambda, rng, randn) {
  if (!(lambda > 0)) return 0;
  if (lambda < 30) {
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k += 1;
      p *= rng();
    } while (p > L);
    return k - 1;
  }
  return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * randn()));
}

function addTruePoissonGaussianNoise(clean, alpha, sigmaRead, seed = 202) {
  const rng = createRng(seed);
  const randn = createNormalRng(createRng(seed ^ 0x55555555));
  const noisy = new Float32Array(clean.length);
  for (let i = 0; i < clean.length; i += 1) {
    const counts = samplePoisson(Math.max(0, clean[i] / alpha), rng, randn);
    noisy[i] = alpha * counts + sigmaRead * randn();
  }
  return noisy;
}

test("J-invariant features have bit-for-bit zero center leakage on corners, singleton axes, 2-slice stacks and 1e20 dynamic range", () => {
  // High-dynamic-range cancellation probe on a 2-slice 17x17 stack filled with 1e-20.
  const hdrDims = [2, 17, 17];
  const hdrVol = new Float32Array(2 * 17 * 17).fill(1e-20);
  const hdrPert = Float32Array.from(hdrVol);
  hdrPert[8 * 17 + 8] = 1.0;
  const nfHdr = featureNames({ use3d: true, maxScale: 8 }).length;
  const fBase = extractSliceFeatures(hdrVol, hdrDims, 0, { use3d: true, maxScale: 8 });
  const fPert = extractSliceFeatures(hdrPert, hdrDims, 0, { use3d: true, maxScale: 8 });
  const off = (8 * 17 + 8) * nfHdr;
  for (let f = 0; f < nfHdr; f += 1) {
    assert.equal(fBase[off + f], fPert[off + f], `HDR feature ${f} leaked center pixel`);
  }

  // Singleton axes & corners.
  const cases = [
    { dims: [1, 1, 9], use3d: false, probes: [[0, 0, 0], [0, 0, 4], [0, 0, 8]] },
    { dims: [1, 9, 1], use3d: false, probes: [[0, 0, 0], [0, 4, 0], [0, 8, 0]] },
    { dims: [3, 1, 1], use3d: true, probes: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] },
    { dims: [5, 17, 19], use3d: true, probes: [[0, 0, 0], [0, 0, 18], [4, 16, 18], [2, 8, 9]] },
  ];
  for (const { dims, use3d, probes } of cases) {
    const [nz, ny, nx] = dims;
    const rng = createRng(7);
    const vol = new Float32Array(nz * ny * nx);
    for (let i = 0; i < vol.length; i += 1) vol[i] = rng() * 10 - 5;
    const numFeatures = featureNames({ use3d, maxScale: 8 }).length;
    for (const [z, y, x] of probes) {
      const a = extractSliceFeatures(vol, dims, z, { use3d, maxScale: 8 });
      const perturbed = Float32Array.from(vol);
      perturbed[(z * ny + y) * nx + x] += 1000;
      const b = extractSliceFeatures(perturbed, dims, z, { use3d, maxScale: 8 });
      const rowOff = (y * nx + x) * numFeatures;
      for (let f = 0; f < numFeatures; f += 1) {
        assert.equal(a[rowOff + f], b[rowOff + f], `dims=${dims} probe=(${z},${y},${x}) feat=${f} leaked`);
      }
    }
  }
});

test("all four methods handle small nonconstant images (4x4, 8x8, 9x9, 1x8) without NaNs or infinite RMSE", () => {
  const shapes = [[1, 4, 4], [1, 8, 8], [1, 9, 9], [1, 1, 8], [1, 2, 2]];
  for (const dims of shapes) {
    const [nz, ny, nx] = dims;
    const rng = createRng(31);
    const img = new Float32Array(nz * ny * nx);
    for (let i = 0; i < img.length; i += 1) img[i] = 10 + 100 * rng();
    for (const method of ["fgr-gbdt", "fgr-ridge", "zs-n2n", "vst-nlm"]) {
      const opts = method === "zs-n2n" ? { method, iterations: 50, channels: 16 } : { method };
      const res = denoiseVolume(img, dims, opts);
      assert.equal(res.denoised.length, img.length);
      for (let i = 0; i < res.denoised.length; i += 1) {
        assert.ok(Number.isFinite(res.denoised[i]), `${method} on ${dims} produced non-finite at ${i}`);
      }
      if (res.details.valRmse !== undefined) {
        assert.ok(Number.isFinite(res.details.valRmse), `${method} on ${dims} produced non-finite valRmse`);
      }
    }
  }
});

test("denoiseVolume rejects NaN and Inf inputs before processing", () => {
  const img = new Float32Array(64 * 64).fill(10);
  img[123] = Number.NaN;
  assert.throws(() => denoiseVolume(img, [1, 64, 64]), /non-finite/i);
  img[123] = Number.POSITIVE_INFINITY;
  assert.throws(() => denoiseVolume(img, [1, 64, 64]), /non-finite/i);
});

test("ZS-N2N analytic backpropagation matches central finite differences", () => {
  const h = 8;
  const w = 8;
  const rng = createRng(123);
  const patch = new Float32Array(h * w);
  for (let i = 0; i < patch.length; i += 1) patch[i] = rng() * 2 - 1;

  const model = createZsN2nModel(4, 99);
  zsN2nLossAndGrad(model, patch, h, w);
  const savedGrads = model.grads.map((g) => Float32Array.from(g));

  const eps = 1e-3;
  for (let t = 0; t < model.params.length; t += 1) {
    const p = model.params[t];
    const g = savedGrads[t];
    const indices = [0, Math.floor(p.length / 2), p.length - 1];
    for (const idx of new Set(indices)) {
      const orig = p[idx];
      p[idx] = orig + eps;
      const lossPlus = zsN2nLossAndGrad(model, patch, h, w);
      p[idx] = orig - eps;
      const lossMinus = zsN2nLossAndGrad(model, patch, h, w);
      p[idx] = orig;

      const numeric = (lossPlus - lossMinus) / (2 * eps);
      const analytic = g[idx];
      const absErr = Math.abs(analytic - numeric);
      const relErr = absErr / Math.max(1e-3, Math.abs(numeric));
      assert.ok(
        absErr < 2e-3 || relErr < 2e-2,
        `param[${t}][${idx}]: analytic=${analytic}, numeric=${numeric}`,
      );
    }
  }
});

test("pairDownsample distinguishes the two diagonal 2x2 kernels on an asymmetric image", () => {
  const img = Float32Array.from([
    10, 2, 30, 4,
    6, 20, 8, 40,
    50, 12, 70, 14,
    16, 60, 18, 80,
  ]);
  const { y1, y2, h2, w2 } = pairDownsample(img, 4, 4);
  assert.deepEqual([h2, w2], [2, 2]);
  // y1 averages anti-diagonals (0,1)+(1,0); y2 averages main diagonals (0,0)+(1,1).
  assert.deepEqual(Array.from(y1), [4, 6, 14, 16]);
  assert.deepEqual(Array.from(y2), [15, 35, 55, 75]);
});

test("Generalized Anscombe inverse is continuous, monotone and nonnegative across dark counts", () => {
  for (const [alpha, sigma] of [[1.5, 4.0], [2.0, 3.0], [1.0, 0.0]]) {
    const spec = gatInverseZeroRoot(alpha, sigma);
    // Zero jump right above tZero and at tMatch.
    assert.equal(inverseGat(spec.tZero, alpha, sigma, 0, spec), 0);
    assert.ok(inverseGat(spec.tZero + 1e-4, alpha, sigma, 0, spec) < 1e-2, "discontinuity above tZero");
    if (spec.ramp) {
      const below = inverseGat(spec.tMatch - 1e-5, alpha, sigma, 0, spec);
      const above = inverseGat(spec.tMatch + 1e-5, alpha, sigma, 0, spec);
      assert.ok(Math.abs(above - below) < 1e-2, `discontinuity at tMatch: ${below} vs ${above}`);
    }
    // Monotone non-decreasing across [0..40].
    let prev = 0;
    for (let t = 0; t <= 40; t += 0.1) {
      const val = inverseGat(t, alpha, sigma, 0, spec);
      assert.ok(val >= prev - 1e-12 && val >= 0, `non-monotone at t=${t}: ${val} < ${prev}`);
      prev = val;
    }
    // Accurate round-trip in high-SNR regime.
    for (const x of [30, 150, 500]) {
      const t = forwardGat(x, alpha, sigma, 0);
      const recovered = inverseGat(t, alpha, sigma, 0, spec);
      assert.ok(Math.abs(recovered - x) < 1.0, `GAT roundtrip at x=${x}: got ${recovered}`);
    }
  }
});

test("fast integral-image NLM matches a brute-force reference at borders and on a 2-slice stack", () => {
  // Brute-force mirror-padded NLM with strictly in-bounds candidate centres.
  function bruteForceNlm(data, dims, { use3d, strength, patchRadius, searchRadius }) {
    const [nz, ny, nx] = dims;
    const plane = ny * nx;
    const sigma = estimateNoiseSigma(data, dims);
    const h = Math.max(1e-6, strength * sigma);
    const invH2 = 1 / (h * h);
    const twoSigma2 = 2 * sigma * sigma;
    const at = (z, y, x) => data[z * plane + mirrorIndex(y, ny) * nx + mirrorIndex(x, nx)];
    const out = new Float32Array(data.length);
    const dzRange = use3d && nz > 1 ? [-1, 0, 1] : [0];
    const pArea = (2 * patchRadius + 1) ** 2;

    for (let z = 0; z < nz; z += 1) {
      for (let y = 0; y < ny; y += 1) {
        for (let x = 0; x < nx; x += 1) {
          let num = 0;
          let den = 0;
          let maxW = 0;
          for (const dz of dzRange) {
            const nzIdx = z + dz;
            if (nzIdx < 0 || nzIdx >= nz) continue;
            for (let dy = -searchRadius; dy <= searchRadius; dy += 1) {
              const sy = y + dy;
              if (sy < 0 || sy >= ny) continue;
              for (let dx = -searchRadius; dx <= searchRadius; dx += 1) {
                const sx = x + dx;
                if (sx < 0 || sx >= nx) continue;
                if (dz === 0 && dy === 0 && dx === 0) continue;
                let dist = 0;
                for (let oy = -patchRadius; oy <= patchRadius; oy += 1) {
                  for (let ox = -patchRadius; ox <= patchRadius; ox += 1) {
                    const diff = at(z, y + oy, x + ox) - at(nzIdx, sy + oy, sx + ox);
                    dist += diff * diff;
                  }
                }
                dist /= pArea;
                const d = dist - twoSigma2;
                const w = d <= 0 ? 1 : Math.exp(-d * invH2);
                if (w > maxW) maxW = w;
                num += w * data[nzIdx * plane + sy * nx + sx];
                den += w;
              }
            }
          }
          const wSelf = maxW > 0 ? maxW : 1;
          out[z * plane + y * nx + x] = (num + wSelf * data[z * plane + y * nx + x]) / (den + wSelf);
        }
      }
    }
    return out;
  }

  const dims = [2, 9, 10];
  const rng = createRng(55);
  const data = new Float32Array(2 * 9 * 10);
  for (let i = 0; i < data.length; i += 1) data[i] = 50 + 30 * rng();

  const opts = { noiseModel: "gaussian", use3d: true, strength: 1.0, patchRadius: 1, searchRadius: 2 };
  const fast = denoiseVstNlm(data, dims, opts).denoised;
  const ref = bruteForceNlm(data, dims, opts);
  for (let i = 0; i < fast.length; i += 1) {
    assert.ok(Math.abs(fast[i] - ref[i]) < 1e-4, `NLM border mismatch at ${i}: fast=${fast[i]} ref=${ref[i]}`);
  }
});

test("Poisson-Gaussian estimator detects true Poisson noise and rejects noise-free checkerboards and flat Gaussian images", () => {
  const ny = 128;
  const nx = 128;
  const clean = syntheticFluorescence2d(ny, nx);

  // True discrete Poisson + Gaussian readout draws.
  const noisyPg = addTruePoissonGaussianNoise(clean, 2.5, 6.0, 22);
  const pg = estimatePoissonGaussian(noisyPg, [1, ny, nx]);
  assert.equal(pg.isPoisson, true, `expected true Poisson detection, got ${JSON.stringify(pg)}`);
  assert.ok(pg.alpha > 1.0 && pg.alpha < 4.5, `expected alpha near 2.5, got ${pg.alpha}`);

  // Noise-free checkerboard on two backgrounds must NOT trigger Poisson mode.
  const checker = new Float32Array(ny * nx);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      const bg = y < ny / 2 ? 10 : 200;
      checker[y * nx + x] = bg + (((x + y) & 1) ? 40 : 0);
    }
  }
  assert.equal(estimatePoissonGaussian(checker, [1, ny, nx]).isPoisson, false);

  // 40 seeded flat Gaussian images must NOT trigger false-positive Poisson mode.
  const flat = new Float32Array(96 * 96).fill(100);
  let falsePositives = 0;
  for (let s = 1; s <= 40; s += 1) {
    const g = addGaussianNoise(flat, 15, s * 13);
    if (estimatePoissonGaussian(g, [1, 96, 96]).isPoisson) falsePositives += 1;
  }
  assert.equal(falsePositives, 0, `expected 0 false Poisson triggers across 40 flat Gaussian images, got ${falsePositives}`);
});

test("residualDiagnostics catches alternating stripes where X and Y autocorrelations have opposite signs", () => {
  const ny = 32;
  const nx = 32;
  const input = new Float32Array(ny * nx);
  const denoised = new Float32Array(ny * nx);
  for (let y = 0; y < ny; y += 1) {
    for (let x = 0; x < nx; x += 1) {
      // Vertical alternating stripes: residual is (-1)^x -> acX = -1, acY = +1.
      input[y * nx + x] = (x & 1) ? 10 : -10;
      denoised[y * nx + x] = 0;
    }
  }
  const diag = residualDiagnostics(input, denoised, [1, ny, nx]);
  assert.ok(diag.residualAutocorrX < -0.9, `expected acX < -0.9, got ${diag.residualAutocorrX}`);
  assert.ok(diag.residualAutocorrY > 0.9, `expected acY > 0.9, got ${diag.residualAutocorrY}`);
  assert.ok(diag.residualMaxAbsAutocorr > 0.9);
  assert.equal(diag.structureWarning, true);
});

test("all four denoising methods significantly improve PSNR on noisy 2D fluorescence and are deterministic", () => {
  const ny = 96;
  const nx = 96;
  const clean = syntheticFluorescence2d(ny, nx);
  const noisy = addTruePoissonGaussianNoise(clean, 2.0, 12.0, 303);
  const noisyPsnr = psnr(clean, noisy, 350);

  const configs = [
    { method: "fgr-gbdt", nTrees: 60, maxDepth: 4, maxScale: 8, seed: 42 },
    { method: "fgr-ridge", maxScale: 8, seed: 42 },
    { method: "zs-n2n", iterations: 120, channels: 16, seed: 42 },
    { method: "vst-nlm", noiseModel: "poisson-gaussian", nlmStrength: 1.0, seed: 42 },
  ];

  for (const cfg of configs) {
    const res = denoiseVolume(noisy, [1, ny, nx], cfg);
    const outPsnr = psnr(clean, res.denoised, 350);
    assert.ok(
      outPsnr > noisyPsnr + 4.0,
      `${cfg.method}: expected PSNR gain > 4 dB (noisy=${noisyPsnr.toFixed(2)}, out=${outPsnr.toFixed(2)})`,
    );
    assert.ok(
      res.diagnostics.denoisedNoiseSigma < res.diagnostics.inputNoiseSigma * 0.5,
      `${cfg.method}: expected >50% noise sigma drop`,
    );
    assert.ok(
      res.diagnostics.residualMaxAbsAutocorr < 0.35,
      `${cfg.method}: residual max |autocorr| too high (${res.diagnostics.residualMaxAbsAutocorr})`,
    );
  }

  const a = denoiseVolume(noisy, [1, ny, nx], { method: "fgr-gbdt", nTrees: 30, seed: 7 });
  const b = denoiseVolume(noisy, [1, ny, nx], { method: "fgr-gbdt", nTrees: 30, seed: 7 });
  assert.deepEqual(a.denoised, b.denoised);
});

test("3D Aydin FGR uses axial context to outperform 2D on a noisy 3D stack", () => {
  const nz = 9;
  const ny = 48;
  const nx = 48;
  const clean = new Float32Array(nz * ny * nx);
  for (let z = 0; z < nz; z += 1) {
    const slice = syntheticFluorescence2d(ny, nx);
    const zScale = 0.7 + 0.3 * Math.cos(((z - 4) / 4) * Math.PI * 0.5);
    for (let i = 0; i < ny * nx; i += 1) clean[z * ny * nx + i] = slice[i] * zScale;
  }
  const noisy = addGaussianNoise(clean, 25, 404);
  const noisyPsnr = psnr(clean, noisy, 350);

  const res2d = denoiseVolume(noisy, [nz, ny, nx], { method: "fgr-gbdt", mode: "2d", nTrees: 40, seed: 42 });
  const res3d = denoiseVolume(noisy, [nz, ny, nx], { method: "fgr-gbdt", mode: "3d", nTrees: 40, seed: 42 });
  const psnr2d = psnr(clean, res2d.denoised, 350);
  const psnr3d = psnr(clean, res3d.denoised, 350);

  assert.ok(psnr2d > noisyPsnr + 5, `2D PSNR gain insufficient: ${psnr2d} vs ${noisyPsnr}`);
  assert.ok(psnr3d > psnr2d + 0.5, `3D (${psnr3d.toFixed(2)}) should outperform 2D (${psnr2d.toFixed(2)})`);
  assert.equal(res3d.details.use3d, true);
  assert.equal(res2d.details.use3d, false);
});

test("runSettings validates active parameters only and effectiveSettings returns replayable parameters", () => {
  assert.throws(() => runSettings({ method: "unknown" }), /Unknown denoising method/);
  assert.throws(() => runSettings({ method: "fgr-gbdt", nTrees: 5 }), /Trees must be/);
  assert.throws(() => runSettings({ method: "fgr-ridge", maxScale: 3 }), /Max scale radius/);
  assert.throws(() => runSettings({ method: "zs-n2n", iterations: 5 }), /Training steps/);
  assert.throws(() => runSettings({ method: "vst-nlm", nlmStrength: 10 }), /Filter strength/);

  // Invalid inactive fields for another method must not block the selected method.
  const ridge = runSettings({ method: "fgr-ridge", nTrees: Number.NaN, iterations: -1, nlmStrength: 999 });
  assert.equal(ridge.method, "fgr-ridge");
  assert.deepEqual(effectiveSettings(ridge), { method: "fgr-ridge", mode: "auto", maxScale: 8, seed: 42 });
});
