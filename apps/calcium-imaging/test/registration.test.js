import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fft1d, fft2d } from "../src/core/fft.js";
import {
  createRegistration,
  initialTemplate,
  patchGrid,
  patchStarts,
  registerTranslation,
  shiftFrame,
  shiftField,
  templateSpectrum,
  warpFrame,
} from "../src/core/registration.js";

// validation/unit_reference.py: CaImAn's register_translation and scikit-image's
// phase_cross_correlation on five noisy shifted 45 × 52 frames.
const reference = JSON.parse(readFileSync(new URL("./fixtures/caiman-reference.json", import.meta.url), "utf8")).registration;

function naiveDft(re, im, inverse) {
  const n = re.length;
  const outRe = new Float64Array(n);
  const outIm = new Float64Array(n);
  const sign = inverse ? 1 : -1;
  for (let k = 0; k < n; k++) {
    for (let t = 0; t < n; t++) {
      const angle = (sign * 2 * Math.PI * k * t) / n;
      outRe[k] += re[t] * Math.cos(angle) - im[t] * Math.sin(angle);
      outIm[k] += re[t] * Math.sin(angle) + im[t] * Math.cos(angle);
    }
  }
  return [outRe, outIm];
}

function seeded(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

for (const n of [1, 2, 3, 8, 45, 52, 64, 100]) {
  test(`the FFT of length ${n} equals the direct DFT, forward and inverse`, () => {
    const random = seeded(n);
    const re = Float64Array.from({ length: n }, () => random() - 0.5);
    const im = Float64Array.from({ length: n }, () => random() - 0.5);
    for (const inverse of [false, true]) {
      const [expectedRe, expectedIm] = naiveDft(re, im, inverse);
      const outRe = Float64Array.from(re);
      const outIm = Float64Array.from(im);
      fft1d(outRe, outIm, inverse);
      for (let k = 0; k < n; k++) {
        assert.ok(Math.abs(outRe[k] - expectedRe[k]) < 1e-9 * n, `re[${k}]`);
        assert.ok(Math.abs(outIm[k] - expectedIm[k]) < 1e-9 * n, `im[${k}]`);
      }
    }
  });
}

test("the 2D FFT followed by its unscaled inverse returns N times the input", () => {
  const random = seeded(7);
  const height = 9;
  const width = 12;
  const re = Float64Array.from({ length: height * width }, () => random());
  const im = new Float64Array(height * width);
  const copy = Float64Array.from(re);
  fft2d(re, im, height, width);
  fft2d(re, im, height, width, true);
  for (let i = 0; i < re.length; i++) assert.ok(Math.abs(re[i] / (height * width) - copy[i]) < 1e-12);
});

test("cross-correlation shifts equal CaImAn's register_translation on odd-sized frames", () => {
  const spectrum = templateSpectrum(Float64Array.from(reference.template), reference.height, reference.width);
  reference.frames.forEach((frame, i) => {
    const { shift } = registerTranslation(spectrum, Float64Array.from(frame), { upsample: reference.upsample, maxShift: reference.maxShift });
    assert.deepEqual(shift, reference.caiman[i], `frame ${i}`);
  });
});

test("phase-correlation shifts equal scikit-image's phase_cross_correlation", () => {
  const spectrum = templateSpectrum(Float64Array.from(reference.template), reference.height, reference.width);
  reference.frames.forEach((frame, i) => {
    const { shift } = registerTranslation(spectrum, Float64Array.from(frame), { upsample: reference.upsample, normalization: "phase" });
    assert.deepEqual(shift, reference.skimagePhase[i], `frame ${i}`);
  });
});

/** A smooth random texture: box-blurred seeded noise, height × width. */
function texture(height, width, seed = 3) {
  const random = seeded(seed);
  const noise = Float64Array.from({ length: height * width }, () => random());
  const out = new Float64Array(height * width);
  const r = 2;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let count = 0;
      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const yy = (y + dy + height) % height;
          const xx = (x + dx + width) % width;
          sum += noise[yy * width + xx];
          count++;
        }
      }
      out[y * width + x] = 1000 * (sum / count);
    }
  }
  return out;
}

test("an integer shift moves the content by that many pixels, borders replicated", () => {
  const frame = Float32Array.from({ length: 12 }, (_, i) => i);
  // 3 × 4 frame shifted down one row and left one column.
  const out = shiftFrame(frame, 3, 4, [1, -1]);
  assert.deepEqual(Array.from(out), [1, 2, 3, 3, 1, 2, 3, 3, 5, 6, 7, 7]);
});

test("rigid registration recovers known sub-pixel translations to 0.1 px", () => {
  const height = 64;
  const width = 64;
  const template = texture(height, width);
  const spectrum = templateSpectrum(template, height, width);
  for (const truth of [[1.3, -2.7], [-0.4, 0.8], [3.0, 2.2], [0, -4.6]]) {
    // frame(y, x) = template(y + dy, x + dx), so registering needs the shift [dy, dx].
    const frame = shiftFrame(template, height, width, [-truth[0], -truth[1]]);
    const { shift } = registerTranslation(spectrum, frame, { upsample: 10, maxShift: 8 });
    assert.ok(Math.abs(shift[0] - truth[0]) <= 0.1 + 1e-9 && Math.abs(shift[1] - truth[1]) <= 0.1 + 1e-9, `${shift} vs ${truth}`);
  }
});

test("maxShift limits the integer peak search", () => {
  const height = 32;
  const width = 32;
  const template = texture(height, width, 11);
  const frame = shiftFrame(template, height, width, [-6, 0]);
  const spectrum = templateSpectrum(template, height, width);
  assert.deepEqual(registerTranslation(spectrum, frame, { upsample: 1, maxShift: 8 }).shift, [6, 0]);
  assert.ok(Math.abs(registerTranslation(spectrum, frame, { upsample: 1, maxShift: 3 }).shift[0]) <= 3);
});

test("sub-pixel refinement stays inside maxShift (0.3 px at maxShift 0, 3.7 px at maxShift 3)", () => {
  const height = 48;
  const width = 48;
  const template = texture(height, width, 3);
  const spectrum = templateSpectrum(template, height, width);
  for (const [truth, maxShift] of [[0.3, 0], [3.7, 3], [-3.7, 3]]) {
    const frame = shiftFrame(template, height, width, [-truth, -truth]);
    const free = registerTranslation(spectrum, frame, { upsample: 10, maxShift: 8 }).shift;
    assert.ok(Math.abs(free[0] - truth) <= 0.1 + 1e-9, `unbounded ${free} vs ${truth}`);
    const { shift } = registerTranslation(spectrum, frame, { upsample: 10, maxShift });
    assert.deepEqual(shift.map(Math.abs), [maxShift, maxShift], `${shift} with maxShift ${maxShift}`);
  }
});

test("piecewise patch shifts stay within maxDeviation of the rigid shift after refinement", () => {
  const height = 64;
  const width = 64;
  const template = texture(height, width, 9);
  // The rigid stage may not move (maxShift 0), so every patch must absorb 3.7 px but may take only 3.
  const frame = shiftFrame(template, height, width, [-3.7, 3.7]);
  const result = createRegistration(template, height, width, { mode: "piecewise", maxShift: 0, upsample: 10, patchSize: 32, patchOverlap: 16, maxDeviation: 3 }).correct(frame);
  assert.deepEqual(result.rigid.map(Math.abs), [0, 0]);
  for (const [dy, dx] of result.patches) assert.ok(Math.abs(dy) <= 3 && Math.abs(dx) <= 3, `[${dy}, ${dx}]`);
  assert.ok(result.patches.some(([dy, dx]) => dy === 3 && dx === -3), JSON.stringify(result.patches));
});

test("patch grids end flush with the image and patch centres are interpolated bilinearly", () => {
  assert.deepEqual(patchStarts(256, 64, 32), [0, 32, 64, 96, 128, 160, 192]);
  assert.deepEqual(patchStarts(100, 64, 32), [0, 32, 36]);
  assert.deepEqual(patchStarts(40, 64, 32), [0]);
  const grid = patchGrid(256, 256, 64, 32);
  assert.equal(grid.ys.length * grid.xs.length, 49);
  assert.equal(grid.centresY[0], 31.5);
  const small = patchGrid(8, 8, 4, 0);
  const shifts = [[0, 0], [1, 2], [2, 0], [3, 2]];
  const { fieldY, fieldX } = shiftField(small, shifts, 8, 8);
  // Pixel (3, 3) lies 3/8 of the way from the centre 1.5 to the centre 5.5 on both axes.
  assert.equal(fieldY[3 * 8 + 3], (0 * 0.625 + 1 * 0.375) * 0.625 + (2 * 0.625 + 3 * 0.375) * 0.375);
  assert.equal(fieldX[3 * 8 + 3], 0.75);
  // Beyond the outer centres the shift of the nearest patch is kept.
  assert.deepEqual([fieldY[0], fieldX[0]], [0, 0]);
  assert.deepEqual([fieldY[63], fieldX[63]], [3, 2]);
});

test("piecewise rigid recovers a smooth deformation that a rigid shift cannot", () => {
  const height = 128;
  const width = 128;
  const template = texture(height, width, 5);
  // A shear of ±1.5 px in y across x, plus a 1 px offset in x: linear, so a patch's mean
  // displacement is the displacement at its centre.
  const trueY = new Float32Array(height * width);
  const trueX = new Float32Array(height * width).fill(1);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) trueY[y * width + x] = (1.5 * (x - (width - 1) / 2)) / ((width - 1) / 2);
  // frame(p) = template(p + d(p)) is undone by the shift field d.
  const negY = trueY.map((value) => -value);
  const negX = trueX.map((value) => -value);
  const frame = warpFrame(template, height, width, negY, negX);
  const error = (registered) => {
    let sum = 0;
    let count = 0;
    for (let y = 8; y < height - 8; y++) {
      for (let x = 8; x < width - 8; x++) {
        sum += (registered[y * width + x] - template[y * width + x]) ** 2;
        count++;
      }
    }
    return Math.sqrt(sum / count);
  };
  const rigid = createRegistration(template, height, width, { mode: "rigid" }).correct(frame);
  const piecewise = createRegistration(template, height, width, { mode: "piecewise", patchSize: 32, patchOverlap: 16, maxDeviation: 3 }).correct(frame);
  assert.ok(error(piecewise.frame) < 0.5 * error(rigid.frame), `piecewise ${error(piecewise.frame)} vs rigid ${error(rigid.frame)}`);
  const grid = piecewise.grid ?? patchGrid(height, width, 32, 16);
  // Unwindowed patch correlation is biased slightly toward zero shift, as in NoRMCorre.
  let total = 0;
  piecewise.patches.forEach(([dy, dx], k) => {
    const cy = grid.centresY[Math.floor(k / grid.xs.length)];
    const cx = grid.centresX[k % grid.xs.length];
    const index = Math.round(cy) * width + Math.round(cx);
    const error = Math.max(Math.abs(dy - trueY[index]), Math.abs(dx - trueX[index]));
    assert.ok(error < 0.3, `patch ${k}: [${dy}, ${dx}] vs [${trueY[index]}, ${trueX[index]}]`);
    total += error;
  });
  assert.ok(total / piecewise.patches.length < 0.15);
});

test("the initial template is the median of 10-frame bin means", () => {
  const frames = 30;
  const movie = new Float32Array(frames);
  for (let f = 0; f < frames; f++) movie[f] = f < 10 ? 1 : f < 20 ? 5 : 100;
  assert.deepEqual(Array.from(initialTemplate(movie, frames, 1, 1)), [5]);
  assert.deepEqual(Array.from(initialTemplate(movie.subarray(0, 4), 4, 1, 1)), [1]);
});
