import assert from "node:assert/strict";
import { test } from "node:test";
import { gzip, gunzip, isGzip, registerAffineGreedy, registerGreedy, resliceAffineGreedy, resliceGreedy } from "../src/index.js";

const api = {
  register_affine_wasm: (_fixed, _moving, _metric, _iterations, imageCenters) => (imageCenters ? "matrix" : "identity-start"),
  register_nmi_svf_wasm: () => Uint8Array.of(7),
  reslice_affine: () => Uint8Array.of(1),
  reslice_warp_affine: (_fixed, _moving, warp) => Uint8Array.of(warp[0], 2),
  reslice_warp_affine_options: (_fixed, _moving, warp, _matrix, preceding, nearest, fill) => Uint8Array.of(warp[0], preceding ? 1 : 0, nearest ? 1 : 0, fill),
  reslice_affine_options: (_fixed, _moving, _matrix, nearest, fill) => Uint8Array.of(nearest ? 1 : 0, fill),
};

test("affine registration returns the resliced image and matrix", () => {
  const result = registerGreedy({ api, fixed: Uint8Array.of(1), moving: Uint8Array.of(2) });
  assert.deepEqual(result.image, Uint8Array.of(1));
  assert.equal(result.matrix, "matrix");
  assert.equal(result.warp, null);
});

test("deformable registration returns its warp", () => {
  const result = registerGreedy({ api, fixed: Uint8Array.of(1), moving: Uint8Array.of(2), mode: "deformable" });
  assert.deepEqual(result.image, Uint8Array.of(7, 2));
  assert.deepEqual(result.warp, Uint8Array.of(7));
});

test("registration transforms can be reused for scalar and lesion reslicing", () => {
  assert.equal(registerAffineGreedy({ api, fixed: Uint8Array.of(1), moving: Uint8Array.of(2) }), "matrix");
  const registration = { matrix: "matrix", warp: Uint8Array.of(7) };
  assert.deepEqual(resliceGreedy({ api, fixed: Uint8Array.of(1), moving: Uint8Array.of(2), registration, precedingMatrix: "path", interpolation: "nearest", fill: -2 }), Uint8Array.of(7, 1, 1, 254));
  assert.deepEqual(resliceAffineGreedy({ api, fixed: Uint8Array.of(1), moving: Uint8Array.of(2), matrix: "path", fill: 3 }), Uint8Array.of(0, 3));
});

test("gzip helpers round trip bytes", async () => {
  const source = new TextEncoder().encode("greedy");
  const compressed = await gzip(source);
  assert.ok(isGzip(compressed));
  assert.deepEqual(await gunzip(compressed), source);
});
