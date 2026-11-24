import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const publicRoot = new URL("../public/", import.meta.url);
const fireantsRoot = dirname(require.resolve("@fireants/fireants/package.json"));
const fireantsTarget = new URL("cfireants/", publicRoot);
const mindgrabRoot = dirname(require.resolve("@brainchop/core/package.json"));
const mindgrabTarget = new URL("brainchop/", publicRoot);

await rm(fireantsTarget, { recursive: true, force: true });
await rm(mindgrabTarget, { recursive: true, force: true });
await mkdir(fireantsTarget, { recursive: true });
for (const name of [
  "cfireants-mt.js",
  "cfireants-mt.wasm",
  "cfireants.js",
  "cfireants.wasm",
  "cfireants-gpu.js",
  "cfireants-gpu.wasm",
  "worker.js",
]) {
  await cp(join(fireantsRoot, "dist", name), new URL(name, fireantsTarget));
}
for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
  await cp(join(fireantsRoot, name), new URL(name, fireantsTarget));
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
