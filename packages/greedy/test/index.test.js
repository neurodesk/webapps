import assert from "node:assert/strict";
import { test } from "node:test";
import { gzip, gunzip, isGzip, registerGreedy } from "../src/index.js";

const api = {
  register_affine_wasm: () => "matrix",
  register_nmi_svf_wasm: () => Uint8Array.of(7),
  reslice_affine: () => Uint8Array.of(1),
  reslice_warp_affine: (_fixed, _moving, warp) => Uint8Array.of(warp[0], 2),
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

test("gzip helpers round trip bytes", async () => {
  const source = new TextEncoder().encode("greedy");
  const compressed = await gzip(source);
  assert.ok(isGzip(compressed));
  assert.deepEqual(await gunzip(compressed), source);
});
