// Stage the runtime assets fetched by URL at run time (Vite never emits them):
// ANTs' WebAssembly kernel from packages/registration and MindGrab's glue + WASM.
// Both folders are gitignored.
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const publicRoot = new URL("../public/", import.meta.url);
const registrationSource = new URL("../../../packages/registration/wasm/", import.meta.url);
const registrationTarget = new URL("registration/", publicRoot);
const mindgrabRoot = dirname(require.resolve("@brainchop/core/package.json"));
const mindgrabTarget = new URL("brainchop/", publicRoot);

await rm(registrationTarget, { recursive: true, force: true });
await rm(mindgrabTarget, { recursive: true, force: true });
await mkdir(registrationTarget, { recursive: true });
for (const name of ["syncro-registration.mjs", "syncro-registration.wasm"]) {
  await cp(new URL(name, registrationSource), new URL(name, registrationTarget));
}
await mkdir(new URL("models/", mindgrabTarget), { recursive: true });
for (const name of [
  "worker.js",
  "models/mindgrab.bin",
  "brainchop-mindgrab-gl.js",
  "brainchop-mindgrab-gl.wasm",
  "brainchop-mindgrab.js",
  "brainchop-mindgrab.wasm",
]) {
  await cp(join(mindgrabRoot, "dist", name), new URL(name, mindgrabTarget));
}
await cp(join(mindgrabRoot, "LICENSE"), new URL("LICENSE", mindgrabTarget));
