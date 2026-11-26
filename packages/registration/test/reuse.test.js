import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { createRegistration } from "../src/index.js";
import createModule from "../wasm/syncro-registration.mjs";

test("a kernel trap is preserved even when restoring its stack also fails", async () => {
  const trap = new Error("kernel trap");
  let restored = false;
  const ants = await createRegistration({ createModule: async () => ({
    stackSave: () => 1024,
    stackRestore: (stack) => {
      assert.equal(stack, 1024);
      restored = true;
      throw new Error("restore failure");
    },
    callMain: () => { throw trap; },
    FS: { mkdir() {}, writeFile() {} },
  }) });
  assert.throws(() => ants.register({ fixed: new Uint8Array(0), moving: new Uint8Array(0) }), (error) => error === trap);
  assert.equal(restored, true);
});

test("one registration instance applies transforms 200 times without consuming its stack", async () => {
  let module;
  const ants = await createRegistration({
    createModule: async (options) => (module = await createModule(options)),
    wasmBinary: await readFile(new URL("../wasm/syncro-registration.wasm", import.meta.url)),
  });
  const image = syntheticNifti({
    dims: [16, 16, 16],
    value: (i) => 100 * Math.exp(-((i % 16 - 7) ** 2 + (Math.floor(i / 16) % 16 - 6) ** 2 + (Math.floor(i / 256) - 8) ** 2) / 20),
    gzip: false,
  });
  const stack = module.stackSave();
  const registration = ants.register({ fixed: image, moving: image });
  assert.equal(module.stackSave(), stack);
  try {
    let expected;
    for (let run = 0; run < 200; run++) {
      const result = ants.apply({ registration, moving: image });
      expected ??= result;
      assert.deepEqual(result, expected, `run ${run + 1}`);
      assert.equal(module.stackSave(), stack, `stack after run ${run + 1}`);
    }
  } finally {
    ants.release(registration);
  }
});

test("registerWithArgs runs affine-only registration and applyTransforms supports forward and inverse resampling", async () => {
  const ants = await createRegistration({
    createModule,
    wasmBinary: await readFile(new URL("../wasm/syncro-registration.wasm", import.meta.url)),
  });
  const image = syntheticNifti({
    dims: [16, 16, 16],
    value: (i) => 100 * Math.exp(-((i % 16 - 7) ** 2 + (Math.floor(i / 16) % 16 - 6) ** 2 + (Math.floor(i / 256) - 8) ** 2) / 20),
    gzip: false,
  });
  const aff = ants.registerWithArgs({
    fixed: image,
    moving: image,
    transformNames: ["0GenericAffine.mat"],
    buildArgs: (fixed, moving, prefix, out) => [
      "--dimensionality", "3", "--float", "1", "--random-seed", "42",
      "-r", `[${fixed},${moving},1]`,
      "--metric", `mattes[${fixed},${moving},1,32,regular,0.2]`,
      "--transform", "Affine[0.25]",
      "--convergence", "50x20",
      "--smoothing-sigmas", "1x0",
      "--shrink-factors", "2x1",
      "-u", "0", "-z", "1",
      "--output", `[${prefix},${out}]`,
    ],
  });
  assert.ok(aff.transforms["0GenericAffine.mat"]?.byteLength > 0);
  const resampled = ants.applyTransforms({
    fixed: image,
    moving: image,
    transforms: [{ name: "aff.mat", bytes: aff.transforms["0GenericAffine.mat"], invert: true }],
    interpolation: "nearest",
    fill: 0,
  });
  assert.ok(resampled.byteLength > 0);
});
