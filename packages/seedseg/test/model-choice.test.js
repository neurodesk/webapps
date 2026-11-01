import assert from "node:assert/strict";
import test from "node:test";
import { resolveModelChoice } from "../src/assets.js";

// The browser automation contract and the command line both resolve requests through this.
test("a request with v1 models and no model runs v1; mixed requests are rejected", () => {
  assert.equal(resolveModelChoice({}), "v2");
  assert.equal(resolveModelChoice({ folds: [0, 1], mirror: true }), "v2");
  assert.equal(resolveModelChoice({ models: [123] }), "v1");
  assert.equal(resolveModelChoice({ ensemble: 3 }), "v1");
  assert.equal(resolveModelChoice({ model: "v1", models: [42] }), "v1");
  assert.throws(
    () => resolveModelChoice({ model: "v2", models: [123] }),
    /v1 checkpoints/,
  );
  assert.throws(
    () => resolveModelChoice({ models: [123], folds: [0] }),
    /choose one model/,
  );
  assert.throws(
    () => resolveModelChoice({ model: "v1", folds: [0] }),
    /apply to v2/,
  );
  assert.throws(
    () => resolveModelChoice({ model: "v3" }),
    /Unknown SeedSeg model/,
  );
});
