import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { gunzipSync } from "node:zlib";
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

function centroidX(bytes, dims = [16, 16, 16]) {
  const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : bytes;
  const voxOffset = new DataView(raw.buffer, raw.byteOffset, raw.byteLength).getFloat32(108, true);
  const voxels = new Float32Array(raw.buffer, raw.byteOffset + voxOffset, dims[0] * dims[1] * dims[2]);
  let wSum = 0;
  let xSum = 0;
  for (let i = 0; i < voxels.length; i++) {
    const w = Math.max(0, voxels[i]);
    wSum += w;
    xSum += w * (i % dims[0]);
  }
  return xSum / wSum;
}

test("registerWithArgs runs affine-only registration and applyTransforms supports forward and inverse resampling", async () => {
  const ants = await createRegistration({
    createModule,
    wasmBinary: await readFile(new URL("../wasm/syncro-registration.wasm", import.meta.url)),
  });
  const fixed = syntheticNifti({
    dims: [16, 16, 16],
    value: (i) => 100 * Math.exp(-((i % 16 - 9) ** 2 + (Math.floor(i / 16) % 16 - 7) ** 2 + (Math.floor(i / 256) - 8) ** 2) / 14),
    gzip: false,
  });
  const moving = syntheticNifti({
    dims: [16, 16, 16],
    value: (i) => 100 * Math.exp(-((i % 16 - 6) ** 2 + (Math.floor(i / 16) % 16 - 7) ** 2 + (Math.floor(i / 256) - 8) ** 2) / 14),
    gzip: false,
  });
  const aff = ants.registerWithArgs({
    fixed,
    moving,
    transformNames: ["0GenericAffine.mat"],
    buildArgs: (f, m, prefix, out) => [
      "--dimensionality", "3", "--float", "1", "--random-seed", "42",
      "-r", `[${f},${m},1]`,
      "--metric", `mattes[${f},${m},1,32,regular,0.2]`,
      "--transform", "Affine[0.25]",
      "--convergence", "50x20",
      "--smoothing-sigmas", "1x0",
      "--shrink-factors", "2x1",
      "-u", "0", "-z", "1",
      "--output", `[${prefix},${out}]`,
    ],
  });
  assert.ok(aff.transforms["0GenericAffine.mat"]?.byteLength > 0);
  const forward = ants.applyTransforms({
    fixed,
    moving,
    transforms: [{ name: "aff.mat", bytes: aff.transforms["0GenericAffine.mat"] }],
    interpolation: "linear",
    fill: 0,
  });
  const inverse = ants.applyTransforms({
    fixed: moving,
    moving: fixed,
    transforms: [{ name: "aff.mat", bytes: aff.transforms["0GenericAffine.mat"], invert: true }],
    interpolation: "linear",
    fill: 0,
  });
  assert.ok(Math.abs(centroidX(forward) - 9) < 0.8, `expected forward centroid near 9, got ${centroidX(forward)}`);
  assert.ok(Math.abs(centroidX(inverse) - 6) < 0.8, `expected inverse centroid near 6, got ${centroidX(inverse)}`);
});

test("registerWithArgs and applyTransforms clean up staged files and preserve the original write failure", async () => {
  const writeFailure = new Error("ENOSPC");
  const unlinked = [];
  const removed = [];
  let writes = 0;
  const ants = await createRegistration({
    createModule: async () => ({
      stackSave: () => 0,
      stackRestore: () => {},
      callMain: () => 0,
      FS: {
        files: new Map(),
        mkdir(dir) { this.files.set(dir, new Set()); },
        writeFile(path) {
          writes++;
          const dir = path.slice(0, path.lastIndexOf("/"));
          const name = path.slice(path.lastIndexOf("/") + 1);
          if (writes === 2) throw writeFailure;
          this.files.get(dir).add(name);
        },
        readdir(dir) { return [".", "..", ...(this.files.get(dir) || [])]; },
        unlink(path) { unlinked.push(path); },
        rmdir(dir) { removed.push(dir); throw new Error("cleanup boom"); },
      },
    }),
  });
  assert.throws(
    () => ants.registerWithArgs({ fixed: new Uint8Array([1]), moving: new Uint8Array([2]), buildArgs: () => [] }),
    (err) => err === writeFailure,
  );
  assert.deepEqual(unlinked, ["/job-0/fixed.nii"]);
  assert.deepEqual(removed, ["/job-0"]);
});
