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
