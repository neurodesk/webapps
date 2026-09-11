import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const publicRoot = new URL("../public/", import.meta.url);
const greedySource = new URL("../../../packages/greedy/wasm/", import.meta.url);
const greedyTarget = new URL("greedy-wasm/", publicRoot);
const mindgrabRoot = dirname(require.resolve("@brainchop/mindgrab/package.json"));
const mindgrabTarget = new URL("brainchop/", publicRoot);

await rm(greedyTarget, { recursive: true, force: true });
await rm(mindgrabTarget, { recursive: true, force: true });
await mkdir(greedyTarget, { recursive: true });
await cp(greedySource, greedyTarget, { recursive: true });
await mkdir(mindgrabTarget, { recursive: true });
for (const name of [
  "worker.js",
  "brainchop-mindgrab-gpu.js",
  "brainchop-mindgrab-gpu.wasm",
  "brainchop-mindgrab-gl.js",
  "brainchop-mindgrab-gl.wasm",
  "brainchop-mindgrab.js",
  "brainchop-mindgrab.wasm",
]) {
  await cp(join(mindgrabRoot, "dist", name), new URL(name, mindgrabTarget));
}
await cp(join(mindgrabRoot, "LICENSE"), new URL("LICENSE", mindgrabTarget));
