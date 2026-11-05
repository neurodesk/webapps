// The numerics against an independent reference (scipy.ndimage and numpy.linalg.eigh, written to
// validation/reference.json by validation/scipy-reference.py) and against synthetic images with
// known orientation.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  analyse,
  convolveAxis,
  directionColours,
  distributionCsv,
  eigenSymmetric3,
  gaussianKernel,
  histogram,
  hsbToRgb,
  maps2d,
  maps3d,
  selection,
  structureTensor,
} from "../src/tensor.js";
import { axisAngle, cylinders3d, direction, grating2d } from "./synthetic.mjs";
import { DOMAINS, syntheticExample } from "../scripts/make-synthetic-example.mjs";

const reference = JSON.parse(readFileSync(new URL("../validation/reference.json", import.meta.url), "utf8"));

/** Signed difference of two orientations on the 180° circle. */
function angleDifference(a, b) {
  return ((((a - b) % 180) + 270) % 180) - 90;
}

test("kernels are scipy's: normalised Gaussian, derivative -x/σ² times it, radius round(4σ)", () => {
  const g = gaussianKernel(1);
  assert.equal(g.length, 9);
  assert.ok(Math.abs(g.reduce((a, b) => a + b) - 1) < 1e-15);
  const d = gaussianKernel(2, 1);
  assert.equal(d.length, 17);
  // A unit ramp has unit derivative, less the variance cut off at 4σ.
  const ramp = Float64Array.from({ length: 41 }, (_, i) => i);
  const out = convolveAxis(ramp, new Float64Array(41), [41, 1, 1], 0, d);
  assert.ok(Math.abs(out[20] - 1) < 1e-3);
});

test("2D maps equal scipy on gratings and recover the true angle within 0.01°", () => {
  for (const ref of reference.gratings) {
    const image = grating2d({ degrees: ref.degrees });
    const { components } = structureTensor(image, { sigma: ref.sigma, rho: ref.rho });
    const maps = maps2d(components);
    ref.points.forEach(([x, y], k) => {
      const i = x + 64 * y;
      assert.ok(Math.abs(angleDifference(maps.orientation[i], ref.orientation[k])) < 1e-9, `${ref.degrees}° at ${x},${y}`);
      assert.ok(Math.abs(maps.coherency[i] - ref.coherency[k]) < 1e-12);
      assert.ok(Math.abs(maps.energy[i] - ref.energy[k]) <= 1e-10 * ref.energy[k]);
      // Away from the reflected borders the grating's true angle is recovered.
      if (Math.min(x, y, 63 - x, 63 - y) >= 20) {
        assert.ok(Math.abs(angleDifference(maps.orientation[i], ref.degrees)) < 0.01, `truth ${ref.degrees}°: ${maps.orientation[i]}`);
        assert.ok(maps.coherency[i] > 0.999);
      }
    });
  }
});

test("3D fibre directions equal numpy's eigenvectors and the true direction within 0.01°", () => {
  for (const ref of reference.cylinders) {
    const image = cylinders3d({ size: ref.size, spacing: ref.spacing, azimuth: ref.azimuth, elevation: ref.elevation });
    const { components } = structureTensor(image, { sigma: ref.sigma, rho: ref.rho });
    const maps = maps3d(components);
    const [nx, ny] = ref.size;
    ref.points.forEach(([x, y, z], k) => {
      const i = x + nx * (y + ny * z);
      const v = [maps.vectors[3 * i], maps.vectors[3 * i + 1], maps.vectors[3 * i + 2]];
      // acos resolves angles near 0 only to about 1e-6°.
      assert.ok(axisAngle(v, ref.vectors[k]) < 1e-5, `numpy vector at ${x},${y},${z}`);
      assert.ok(Math.abs(maps.azimuth[i] - ref.azimuth_deg[k]) < 1e-6 || ref.elevation >= 85);
      assert.ok(Math.abs(maps.elevation[i] - ref.elevation_deg[k]) < 1e-6);
      assert.ok(Math.abs(maps.coherency[i] - ref.coherency[k]) < 1e-9);
      assert.ok(Math.abs(maps.energy[i] - ref.energy[k]) <= 1e-10 * ref.energy[k]);
      // The centre is far from the reflected borders.
      if (k === 0) assert.ok(axisAngle(v, image.direction) < 0.01, `truth at ${x},${y},${z}: ${axisAngle(v, image.direction)}°`);
    });
  }
});

test("a σ below one voxel along z biases 3D angles, which is why the app refuses it", () => {
  const image = cylinders3d({ size: [48, 48, 24], spacing: [1, 1, 2], azimuth: -60, elevation: 45 });
  const { components } = structureTensor(image, { sigma: 1, rho: 4 });
  const maps = maps3d(components);
  const i = 24 + 48 * (24 + 48 * 12);
  const v = [maps.vectors[3 * i], maps.vectors[3 * i + 1], maps.vectors[3 * i + 2]];
  assert.ok(axisAngle(v, image.direction) > 1);
});

test("the synthetic 3D example has its two declared fibre directions within 0.5°", () => {
  const example = syntheticExample();
  const result = analyse({ ...example, data: Float64Array.from(example.data) }, { sigma: 1, rho: 3, minCoherency: 0.2, minEnergy: 0.01 });
  const [nx, ny] = example.dims;
  for (const { azimuth, elevation, xs } of DOMAINS) {
    const x = (xs[0] + xs[1]) >> 1;
    const i = x + nx * (32 + ny * 16);
    const v = [result.maps.vectors[3 * i], result.maps.vectors[3 * i + 1], result.maps.vectors[3 * i + 2]];
    assert.ok(axisAngle(v, direction(azimuth, elevation)) < 0.5, `${azimuth}/${elevation}`);
  }
});

test("Jacobi eigen-decomposition is orthonormal and reconstructs the matrix", () => {
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  for (let trial = 0; trial < 200; trial++) {
    const [a, b, c, d, e, f] = Array.from({ length: 6 }, random);
    const { values, vectors } = eigenSymmetric3(a, b, c, d, e, f);
    assert.ok(values[0] >= values[1] && values[1] >= values[2]);
    const m = [[a, b, c], [b, d, e], [c, e, f]];
    for (let r = 0; r < 3; r++) {
      for (let s = 0; s < 3; s++) {
        const sum = vectors.reduce((acc, v, k) => acc + values[k] * v[r] * v[s], 0);
        assert.ok(Math.abs(sum - m[r][s]) < 1e-12);
      }
    }
  }
});

test("orientation convention: stripes running up to the right are +45° with rows pointing down", () => {
  // Fibres along (1, -1) in (x, row) run up and to the right on screen.
  const { orientation } = maps2d([[1], [1], [1]]);
  assert.equal(orientation[0], 45);
  assert.equal(maps2d([[1], [0], [0]]).orientation[0], 90);
  assert.equal(maps2d([[0], [0], [1]]).orientation[0], 0);
});

test("distribution counts selected pixels in 1° bins and writes them as CSV", () => {
  const maps = { coherency: Float64Array.of(0.9, 0.1, 0.9, 0.9), energy: Float64Array.of(10, 10, 0.05, 5) };
  const selected = selection(maps, { minCoherency: 0.2, minEnergy: 0.01 });
  assert.deepEqual(Array.from(selected), [1, 0, 0, 1]);
  const h = histogram(Float64Array.of(-90, 0, 0, 90), selected);
  assert.equal(h.total, 2);
  assert.equal(h.counts[0], 1);
  assert.equal(h.counts[179], 1);
  const csv = distributionCsv({ orientation: h }).split("\n");
  assert.equal(csv[0], "quantity,bin_low_deg,bin_high_deg,count,fraction");
  assert.equal(csv[1], "orientation,-90,-89,1,0.50000000");
  assert.equal(csv.length, 182);
});

test("HSB colours match java.awt.Color.HSBtoRGB", () => {
  assert.deepEqual(hsbToRgb(0, 1, 1), [255, 0, 0]);
  assert.deepEqual(hsbToRgb(1 / 3, 1, 1), [0, 255, 0]);
  assert.deepEqual(hsbToRgb(0.5, 0.5, 0.5), [64, 128, 128]);
  assert.deepEqual(hsbToRgb(0.25, 0, 0.2), [51, 51, 51]);
});

test("the reference example's settings and histogram length are consistent", () => {
  assert.equal(reference.example.histogram.length, 180);
  assert.equal(reference.example.histogram.reduce((a, b) => a + b), reference.example.counted);
});

test("NaN or infinite samples are refused instead of giving all-NaN maps", () => {
  const image = grating2d({ degrees: 30 });
  image.data[100] = Number.NaN;
  assert.throws(() => analyse(image, { sigma: 1, rho: 3, minCoherency: 0.2, minEnergy: 0.01 }), /NaN value at x 36, y 1/);
  image.data[100] = Number.NEGATIVE_INFINITY;
  assert.throws(() => structureTensor(image, { sigma: 1, rho: 3 }), /infinite value/);
});

test("the distribution counts a pixel whose coherency equals the minimum exactly", () => {
  const maps = { coherency: Float64Array.of(0.2, 0.2 - 1e-12), energy: Float64Array.of(1, 1) };
  assert.deepEqual(Array.from(selection(maps, { minCoherency: 0.2, minEnergy: 0 })), [1, 0]);
});

test("the direction map scales |v| by fibre coherency, rounding half up", () => {
  const rgb = directionColours(Float64Array.of(1, 0, 0, 0.6, -0.8, 0), Float64Array.of(0.5, 0.5));
  assert.deepEqual(Array.from(rgb), [128, 0, 0, 77, 102, 0]);
});

test("3D maps report progress through the eigen-decomposition, not only after it", () => {
  const n = 1000;
  const ones = new Float64Array(n).fill(1);
  const zeros = new Float64Array(n);
  const fractions = [];
  maps3d([ones, zeros, zeros, ones, zeros, zeros], { onProgress: (f) => fractions.push(f) });
  assert.ok(fractions.length >= 19, `${fractions.length} updates`);
  assert.ok(fractions.every((f, k) => k === 0 || f > fractions[k - 1]));
  assert.equal(fractions.at(-1), 1);
  const overall = [];
  const example = syntheticExample();
  analyse({ ...example, data: Float64Array.from(example.data) }, { sigma: 1, rho: 3, minCoherency: 0.2, minEnergy: 0.01 }, { onProgress: (f) => overall.push(f) });
  assert.ok(overall.filter((f) => f > 0.5 && f < 1).length >= 10, "progress moves while the eigenvectors are computed");
});
