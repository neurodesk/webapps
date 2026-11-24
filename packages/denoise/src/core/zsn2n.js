// Browser adaptation of Zero-Shot Noise2Noise (ZS-N2N)
// (Mansour & Heckel, CVPR 2023: "Zero-Shot Noise2Noise: Efficient Image Denoising
// without any Data").
//
// Uses the paper's 2-layer residual CNN and symmetric residual + consistency objective on
// diagonal 2x2 downsampled sub-image pairs with Adam. Defaults to 16 channels, 48x48 random
// crops and 200 steps for interactive CPU speed (up to 48 channels and 1500 steps configurable).

import { imageStats } from "./metrics.js";
import { createNormalRng, createRng } from "./rng.js";

const LEAKY_SLOPE = 0.2;

/**
 * Diagonal 2x2 pair downsampler from Mansour & Heckel (CVPR 2023):
 *   y1[r, c] = 0.5 * (y[2r, 2c+1] + y[2r+1, 2c])
 *   y2[r, c] = 0.5 * (y[2r, 2c]   + y[2r+1, 2c+1])
 * @param {Float32Array} img `[h, w]`
 * @param {number} h
 * @param {number} w
 */
export function pairDownsample(img, h, w) {
  const h2 = h >> 1;
  const w2 = w >> 1;
  const y1 = new Float32Array(h2 * w2);
  const y2 = new Float32Array(h2 * w2);
  for (let r = 0; r < h2; r += 1) {
    const r0 = 2 * r * w;
    const r1 = r0 + w;
    const dst = r * w2;
    for (let c = 0; c < w2; c += 1) {
      const c0 = 2 * c;
      y1[dst + c] = 0.5 * (img[r0 + c0 + 1] + img[r1 + c0]);
      y2[dst + c] = 0.5 * (img[r0 + c0] + img[r1 + c0 + 1]);
    }
  }
  return { y1, y2, h2, w2 };
}

/**
 * Exact adjoint (transpose) of `pairDownsample`: accumulates gradients `dY1`, `dY2`
 * into `dImg` (`[h, w]`).
 */
export function pairDownsampleBackward(dY1, dY2, h, w, dImg) {
  const h2 = h >> 1;
  const w2 = w >> 1;
  for (let r = 0; r < h2; r += 1) {
    const r0 = 2 * r * w;
    const r1 = r0 + w;
    const src = r * w2;
    for (let c = 0; c < w2; c += 1) {
      const c0 = 2 * c;
      const g1 = 0.5 * dY1[src + c];
      const g2 = 0.5 * dY2[src + c];
      dImg[r0 + c0 + 1] += g1;
      dImg[r1 + c0] += g1;
      dImg[r0 + c0] += g2;
      dImg[r1 + c0 + 1] += g2;
    }
  }
}

/**
 * Allocates parameters, gradients and Adam moments for the 2-layer ZS-N2N residual CNN:
 *   Conv1(1 -> C, 3x3, pad=1) + LeakyReLU(0.2)
 *   Conv2(C -> C, 3x3, pad=1) + LeakyReLU(0.2)
 *   Conv3(C -> 1, 1x1)
 * Uses Kaiming-normal initialization for LeakyReLU(0.2).
 * @param {number} channels
 * @param {number} seed
 */
export function createZsN2nModel(channels, seed = 42) {
  const rng = createRng(seed);
  const randn = createNormalRng(rng);
  const gain = Math.sqrt(2 / (1 + LEAKY_SLOPE * LEAKY_SLOPE));

  const w1 = new Float32Array(channels * 9);
  const b1 = new Float32Array(channels);
  const w2 = new Float32Array(channels * channels * 9);
  const b2 = new Float32Array(channels);
  const w3 = new Float32Array(channels);
  const b3 = new Float32Array(1);

  const s1 = gain / Math.sqrt(9);
  for (let i = 0; i < w1.length; i += 1) w1[i] = randn() * s1;
  const s2 = gain / Math.sqrt(9 * channels);
  for (let i = 0; i < w2.length; i += 1) w2[i] = randn() * s2;
  const s3 = 0.5 / Math.sqrt(channels);
  for (let i = 0; i < w3.length; i += 1) w3[i] = randn() * s3;

  const params = [w1, b1, w2, b2, w3, b3];
  const grads = params.map((p) => new Float32Array(p.length));
  const m = params.map((p) => new Float32Array(p.length));
  const v = params.map((p) => new Float32Array(p.length));

  return {
    channels,
    w1,
    b1,
    w2,
    b2,
    w3,
    b3,
    params,
    grads,
    m,
    v,
    step: 0,
  };
}

/**
 * Forward pass computing residual noise `g(x)` for a single-channel image `x` (`[h, w]`).
 * Activations are stored pixel-major (`[h * w, C]`) for cache-friendly inner loops.
 */
export function forwardNoise(model, x, h, w) {
  const C = model.channels;
  const hw = h * w;
  const { w1, b1, w2, b2, w3, b3 } = model;

  // Layer 1: Conv(1 -> C, 3x3, pad=1) + LeakyReLU
  const z1 = new Float32Array(hw * C);
  const a1 = new Float32Array(hw * C);
  for (let y = 0; y < h; y += 1) {
    for (let xPos = 0; xPos < w; xPos += 1) {
      const p = y * w + xPos;
      const pOff = p * C;
      // Gather 3x3 patch from 1-channel input with zero padding.
      const p00 = y > 0 && xPos > 0 ? x[p - w - 1] : 0;
      const p01 = y > 0 ? x[p - w] : 0;
      const p02 = y > 0 && xPos + 1 < w ? x[p - w + 1] : 0;
      const p10 = xPos > 0 ? x[p - 1] : 0;
      const p11 = x[p];
      const p12 = xPos + 1 < w ? x[p + 1] : 0;
      const p20 = y + 1 < h && xPos > 0 ? x[p + w - 1] : 0;
      const p21 = y + 1 < h ? x[p + w] : 0;
      const p22 = y + 1 < h && xPos + 1 < w ? x[p + w + 1] : 0;

      for (let co = 0; co < C; co += 1) {
        const wOff = co * 9;
        const val = b1[co]
          + w1[wOff] * p00 + w1[wOff + 1] * p01 + w1[wOff + 2] * p02
          + w1[wOff + 3] * p10 + w1[wOff + 4] * p11 + w1[wOff + 5] * p12
          + w1[wOff + 6] * p20 + w1[wOff + 7] * p21 + w1[wOff + 8] * p22;
        z1[pOff + co] = val;
        a1[pOff + co] = val > 0 ? val : LEAKY_SLOPE * val;
      }
    }
  }

  // Layer 2: Conv(C -> C, 3x3, pad=1) + LeakyReLU
  // Weight layout: w2[(co * 9 + k) * C + ci] so inner loop over ci is contiguous.
  // Gather the 3x3 neighbourhood into a contiguous [9*C] row per pixel to eliminate
  // repeated bounds checks and memory traffic on z2.
  const z2 = new Float32Array(hw * C);
  const a2 = new Float32Array(hw * C);
  const w2StrideCo = 9 * C;
  const col = new Float32Array(w2StrideCo);
  for (let y = 0; y < h; y += 1) {
    for (let xPos = 0; xPos < w; xPos += 1) {
      col.fill(0);
      for (let ky = -1; ky <= 1; ky += 1) {
        const ny = y + ky;
        if (ny < 0 || ny >= h) continue;
        const rowBase = ny * w;
        for (let kx = -1; kx <= 1; kx += 1) {
          const nx = xPos + kx;
          if (nx < 0 || nx >= w) continue;
          const kOff = ((ky + 1) * 3 + (kx + 1)) * C;
          const aOff = (rowBase + nx) * C;
          for (let ci = 0; ci < C; ci += 1) col[kOff + ci] = a1[aOff + ci];
        }
      }
      const pOff = (y * w + xPos) * C;
      for (let co = 0; co < C; co += 1) {
        const wOff = co * w2StrideCo;
        let acc = b2[co];
        for (let k = 0; k < w2StrideCo; k += 1) acc += w2[wOff + k] * col[k];
        z2[pOff + co] = acc;
        a2[pOff + co] = acc > 0 ? acc : LEAKY_SLOPE * acc;
      }
    }
  }

  // Layer 3: Conv(C -> 1, 1x1)
  const out = new Float32Array(hw);
  const bias3 = b3[0];
  for (let p = 0; p < hw; p += 1) {
    const pOff = p * C;
    let acc = bias3;
    for (let ci = 0; ci < C; ci += 1) acc += w3[ci] * a2[pOff + ci];
    out[p] = acc;
  }

  return { out, z1, a1, z2, a2, x, h, w };
}

/**
 * Exact backward pass accumulating gradients of `L` with respect to `model.params`
 * given `dOut` = `dL / d(g(x))`.
 */
export function backwardNoise(model, cache, dOut) {
  const C = model.channels;
  const { x, h, w, z1, a1, z2, a2 } = cache;
  const hw = h * w;
  const [dw1, db1, dw2, db2, dw3, db3] = model.grads;
  const { w2, w3 } = model;

  // Backprop through Layer 3 (1x1) and LeakyReLU2.
  const dz2 = new Float32Array(hw * C);
  let dBias3 = 0;
  for (let p = 0; p < hw; p += 1) {
    const g = dOut[p];
    dBias3 += g;
    const pOff = p * C;
    for (let ci = 0; ci < C; ci += 1) {
      dw3[ci] += g * a2[pOff + ci];
      const da2 = g * w3[ci];
      dz2[pOff + ci] = z2[pOff + ci] > 0 ? da2 : LEAKY_SLOPE * da2;
    }
  }
  db3[0] += dBias3;

  // Backprop through Layer 2 (3x3, C -> C).
  const da1 = new Float32Array(hw * C);
  const w2StrideCo = 9 * C;
  for (let y = 0; y < h; y += 1) {
    for (let xPos = 0; xPos < w; xPos += 1) {
      const pOff = (y * w + xPos) * C;
      for (let co = 0; co < C; co += 1) db2[co] += dz2[pOff + co];

      for (let ky = -1; ky <= 1; ky += 1) {
        const ny = y + ky;
        if (ny < 0 || ny >= h) continue;
        const rowBase = ny * w;
        for (let kx = -1; kx <= 1; kx += 1) {
          const nx = xPos + kx;
          if (nx < 0 || nx >= w) continue;
          const kIdx = (ky + 1) * 3 + (kx + 1);
          const aOff = (rowBase + nx) * C;
          for (let co = 0; co < C; co += 1) {
            const g = dz2[pOff + co];
            const wOff = co * w2StrideCo + kIdx * C;
            for (let ci = 0; ci < C; ci += 1) {
              dw2[wOff + ci] += g * a1[aOff + ci];
              da1[aOff + ci] += g * w2[wOff + ci];
            }
          }
        }
      }
    }
  }

  // Backprop through LeakyReLU1 and Layer 1 (3x3, 1 -> C).
  for (let y = 0; y < h; y += 1) {
    for (let xPos = 0; xPos < w; xPos += 1) {
      const p = y * w + xPos;
      const pOff = p * C;
      const p00 = y > 0 && xPos > 0 ? x[p - w - 1] : 0;
      const p01 = y > 0 ? x[p - w] : 0;
      const p02 = y > 0 && xPos + 1 < w ? x[p - w + 1] : 0;
      const p10 = xPos > 0 ? x[p - 1] : 0;
      const p11 = x[p];
      const p12 = xPos + 1 < w ? x[p + 1] : 0;
      const p20 = y + 1 < h && xPos > 0 ? x[p + w - 1] : 0;
      const p21 = y + 1 < h ? x[p + w] : 0;
      const p22 = y + 1 < h && xPos + 1 < w ? x[p + w + 1] : 0;

      for (let co = 0; co < C; co += 1) {
        const g = z1[pOff + co] > 0 ? da1[pOff + co] : LEAKY_SLOPE * da1[pOff + co];
        db1[co] += g;
        const wOff = co * 9;
        dw1[wOff] += g * p00;
        dw1[wOff + 1] += g * p01;
        dw1[wOff + 2] += g * p02;
        dw1[wOff + 3] += g * p10;
        dw1[wOff + 4] += g * p11;
        dw1[wOff + 5] += g * p12;
        dw1[wOff + 6] += g * p20;
        dw1[wOff + 7] += g * p21;
        dw1[wOff + 8] += g * p22;
      }
    }
  }
}

/**
 * Evaluates the full ZS-N2N loss `L_res + L_cons` on one even-sized patch `patch` (`[h, w]`)
 * and accumulates exact gradients into `model.grads`. Returns the scalar loss.
 */
export function zsN2nLossAndGrad(model, patch, h, w) {
  for (const g of model.grads) g.fill(0);
  const { y1, y2, h2, w2 } = pairDownsample(patch, h, w);
  const n2 = h2 * w2;
  const invN2 = 1 / n2;

  const c1 = forwardNoise(model, y1, h2, w2);
  const c2 = forwardNoise(model, y2, h2, w2);
  const cFull = forwardNoise(model, patch, h, w);

  // Full denoised patch y_hat = patch - g(patch), then downsampled to (yh1, yh2).
  const yHat = new Float32Array(h * w);
  for (let i = 0; i < yHat.length; i += 1) yHat[i] = patch[i] - cFull.out[i];
  const { y1: yh1, y2: yh2 } = pairDownsample(yHat, h, w);

  const dG1 = new Float32Array(n2);
  const dG2 = new Float32Array(n2);
  const dYh1 = new Float32Array(n2);
  const dYh2 = new Float32Array(n2);

  let lossRes = 0;
  let lossCons = 0;
  for (let i = 0; i < n2; i += 1) {
    const pred1 = y1[i] - c1.out[i];
    const pred2 = y2[i] - c2.out[i];

    // Residual term: 0.5 * (MSE(pred1, y2) + MSE(pred2, y1))
    const r1 = pred1 - y2[i];
    const r2 = pred2 - y1[i];
    lossRes += r1 * r1 + r2 * r2;

    // Consistency term: 0.5 * (MSE(pred1, yh1) + MSE(pred2, yh2))
    const q1 = pred1 - yh1[i];
    const q2 = pred2 - yh2[i];
    lossCons += q1 * q1 + q2 * q2;

    // d(0.5/n2 * (pred - target)^2) / d(g) = -(1/n2) * (pred - target)
    dG1[i] = -invN2 * (r1 + q1);
    dG2[i] = -invN2 * (r2 + q2);
    // d(0.5/n2 * (pred1 - yh1)^2) / d(yh1) = -(1/n2) * q1
    // Since yHat = patch - g(patch), d/d(g(patch)) = -d/d(yHat) = +(1/n2) * D^T(q).
    dYh1[i] = invN2 * q1;
    dYh2[i] = invN2 * q2;
  }

  const dGFull = new Float32Array(h * w);
  pairDownsampleBackward(dYh1, dYh2, h, w, dGFull);

  backwardNoise(model, c1, dG1);
  backwardNoise(model, c2, dG2);
  backwardNoise(model, cFull, dGFull);

  return 0.5 * invN2 * (lossRes + lossCons);
}

/**
 * Performs one Adam step with global L2 gradient norm clipping (`maxNorm = 5`).
 */
function adamStep(model, lr) {
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  model.step += 1;
  const bc1 = 1 - beta1 ** model.step;
  const bc2 = 1 - beta2 ** model.step;

  let normSq = 0;
  for (const g of model.grads) {
    for (let i = 0; i < g.length; i += 1) normSq += g[i] * g[i];
  }
  const gradNorm = Math.sqrt(normSq);
  const clip = gradNorm > 5 ? 5 / gradNorm : 1;

  for (let k = 0; k < model.params.length; k += 1) {
    const p = model.params[k];
    const g = model.grads[k];
    const m = model.m[k];
    const v = model.v[k];
    for (let i = 0; i < p.length; i += 1) {
      const gi = g[i] * clip;
      const mi = beta1 * m[i] + (1 - beta1) * gi;
      const vi = beta2 * v[i] + (1 - beta2) * gi * gi;
      m[i] = mi;
      v[i] = vi;
      p[i] -= (lr * (mi / bc1)) / (Math.sqrt(vi / bc2) + eps);
    }
  }
}

/**
 * Extracts an even-sized 2D crop `[ph, pw]` from slice `z` of a normalized `[nz, ny, nx]` volume.
 */
function extractCrop(volume, dims, z, y0, x0, ph, pw, out) {
  const [, ny, nx] = dims;
  const base = z * ny * nx;
  for (let r = 0; r < ph; r += 1) {
    const src = base + (y0 + r) * nx + x0;
    out.set(volume.subarray(src, src + pw), r * pw);
  }
  return out;
}

/**
 * Runs seamless tiled inference `x - g(x)` on one 2D slice using an 8-pixel halo
 * (exact for a 2-layer 3x3 CNN whose total receptive-field radius is 2 pixels).
 */
function inferSliceTiled(model, slice, ny, nx, tileSize = 128) {
  if (ny <= tileSize && nx <= tileSize) {
    const { out } = forwardNoise(model, slice, ny, nx);
    const denoised = new Float32Array(ny * nx);
    for (let i = 0; i < denoised.length; i += 1) denoised[i] = slice[i] - out[i];
    return denoised;
  }

  const halo = 8;
  const denoised = new Float32Array(ny * nx);
  for (let y0 = 0; y0 < ny; y0 += tileSize) {
    const y1 = Math.min(ny, y0 + tileSize);
    const py0 = Math.max(0, y0 - halo);
    const py1 = Math.min(ny, y1 + halo);
    const th = py1 - py0;

    for (let x0 = 0; x0 < nx; x0 += tileSize) {
      const x1 = Math.min(nx, x0 + tileSize);
      const px0 = Math.max(0, x0 - halo);
      const px1 = Math.min(nx, x1 + halo);
      const tw = px1 - px0;

      const tile = new Float32Array(th * tw);
      for (let r = 0; r < th; r += 1) {
        const src = (py0 + r) * nx + px0;
        tile.set(slice.subarray(src, src + tw), r * tw);
      }
      const { out } = forwardNoise(model, tile, th, tw);
      for (let y = y0; y < y1; y += 1) {
        const tr = y - py0;
        const dstRow = y * nx;
        const srcRow = tr * tw;
        for (let x = x0; x < x1; x += 1) {
          const tc = x - px0;
          denoised[dstRow + x] = tile[srcRow + tc] - out[srcRow + tc];
        }
      }
    }
  }
  return denoised;
}

/**
 * Runs Zero-Shot Noise2Noise (Mansour & Heckel, CVPR 2023) on a 2D or 3D `[nz, ny, nx]`
 * Float32 volume. Trains one shared lightweight residual CNN across patches drawn from the
 * image/stack, then denoises every slice seamlessly.
 *
 * @param {Float32Array} data
 * @param {[number, number, number]} dims `[nz, ny, nx]`
 * @param {{
 *   iterations?: number,
 *   channels?: number,
 *   patchSize?: number,
 *   learningRate?: number,
 *   seed?: number,
 *   onProgress?: (fraction: number, stage: string) => void
 * }} [options]
 */
export function denoiseZsN2n(data, dims, options = {}) {
  const {
    iterations = 200,
    channels = 16,
    patchSize = 48,
    learningRate = 2e-3,
    seed = 42,
    onProgress,
  } = options;

  const [nz, ny, nx] = dims;
  const plane = ny * nx;
  const stats = imageStats(data);
  if (!(stats.std > 1e-12) || ny < 4 || nx < 4) {
    onProgress?.(1, "Image too small or constant — returned unchanged");
    return {
      denoised: Float32Array.from(data),
      details: { channels, iterations: 0, parameterCount: 0, initialLoss: 0, finalLoss: 0 },
    };
  }

  const invStd = 1 / stats.std;
  const norm = new Float32Array(data.length);
  for (let i = 0; i < data.length; i += 1) {
    const v = data[i];
    norm[i] = Number.isFinite(v) ? (v - stats.mean) * invStd : 0;
  }

  // Even patch dimensions capped at image size.
  const ph = Math.max(4, Math.min(patchSize, ny) & ~1);
  const pw = Math.max(4, Math.min(patchSize, nx) & ~1);
  const patch = new Float32Array(ph * pw);

  const model = createZsN2nModel(channels, seed);
  const paramCount = model.params.reduce((acc, p) => acc + p.length, 0);
  const rng = createRng(seed ^ 0x27d4eb2d);

  let initialLoss = 0;
  let finalLoss = 0;
  const maxY0 = ny - ph;
  const maxX0 = nx - pw;

  for (let iter = 1; iter <= iterations; iter += 1) {
    const z = nz > 1 ? Math.floor(rng() * nz) : 0;
    const y0 = maxY0 > 0 ? Math.floor(rng() * (maxY0 + 1)) : 0;
    const x0 = maxX0 > 0 ? Math.floor(rng() * (maxX0 + 1)) : 0;
    extractCrop(norm, dims, z, y0, x0, ph, pw, patch);

    // Cosine learning-rate decay from lr down to 0.1 * lr.
    const progressFrac = (iter - 1) / Math.max(1, iterations - 1);
    const lr = learningRate * (0.1 + 0.45 * (1 + Math.cos(Math.PI * progressFrac)));

    const loss = zsN2nLossAndGrad(model, patch, ph, pw);
    if (iter === 1) initialLoss = loss;
    finalLoss = loss;
    adamStep(model, lr);

    if (iter === 1 || iter === iterations || iter % 10 === 0) {
      onProgress?.(0.75 * (iter / iterations), `Training ZS-N2N: step ${iter} of ${iterations}…`);
    }
  }

  const denoised = new Float32Array(data.length);
  const mean = stats.mean;
  const std = stats.std;
  for (let z = 0; z < nz; z += 1) {
    const slice = norm.subarray(z * plane, (z + 1) * plane);
    const pred = inferSliceTiled(model, slice, ny, nx);
    const base = z * plane;
    for (let i = 0; i < plane; i += 1) {
      denoised[base + i] = pred[i] * std + mean;
    }
    onProgress?.(0.75 + 0.25 * ((z + 1) / nz), `Denoising slice ${z + 1} of ${nz}…`);
  }

  onProgress?.(1, "Done");
  return {
    denoised,
    details: {
      channels,
      iterations,
      patchShape: [ph, pw],
      parameterCount: paramCount,
      initialLoss: Number(initialLoss.toPrecision(4)),
      finalLoss: Number(finalLoss.toPrecision(4)),
    },
  };
}
