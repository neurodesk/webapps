import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";
import { createN4 } from "../src/index.js";
import createModule from "../wasm/n4-bias.mjs";

test("a kernel trap is preserved even when restoring its stack also fails", async () => {
  const trap = new Error("kernel trap");
  let restored = false;
  const n4 = await createN4({ createModule: async () => ({
    stackSave: () => 1024,
    stackRestore: (stack) => {
      assert.equal(stack, 1024);
      restored = true;
      throw new Error("restore failure");
    },
    callMain: () => { throw trap; },
    FS: { mkdir() {}, writeFile() {}, readdir: () => [], rmdir() {} },
  }) });
  await assert.rejects(n4.correct({ image: new Uint8Array(0) }), (error) => error === trap);
  assert.equal(restored, true);
});

test("one N4 instance corrects 200 images without consuming its stack", async () => {
  let module;
  const n4 = await createN4({
    createModule: async (options) => (module = await createModule(options)),
    wasmBinary: await readFile(new URL("../wasm/n4-bias.wasm", import.meta.url)),
  });
  const image = syntheticNifti({ dims: [8, 8, 8], value: (i) => 100 + i % 53, gzip: false });
  const stack = module.stackSave();
  let expected;
  for (let run = 0; run < 200; run++) {
    const result = await n4.correct({ image, shrink: 1, convergence: [1, 0], bspline: [20, 3] });
    expected ??= result;
    assert.deepEqual(result, expected, `run ${run + 1}`);
    assert.equal(module.stackSave(), stack, `stack after run ${run + 1}`);
  }
});
