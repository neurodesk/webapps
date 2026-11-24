// Stage @brainchop/core's MindMap tissue model for runtime fetch: the
// Emscripten glue finds its .wasm next to itself, so both stay unhashed in
// public/brainchop/<version>/ (gitignored, as in apps/brain2print).
import { cp, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const packageDir = dirname(require.resolve("@brainchop/core/package.json"));
const { version } = JSON.parse(await readFile(join(packageDir, "package.json"), "utf8"));
const root = new URL("../public/brainchop/", import.meta.url);
// Versioned: a cached old worker.js must never meet a newer page.
const target = new URL(`${version}/`, root);
await mkdir(new URL("models/", target), { recursive: true });
for (const old of await readdir(root)) {
  if (old !== version) await rm(new URL(old, root), { recursive: true, force: true });
}
// Pure-JS WebGPU V4 reads models/mindmap.bin; -gl is WebGL2 and "" is threaded CPU.
const modules = ["-gl", ""].flatMap((backend) => ["js", "wasm"].map((ext) => `brainchop-mindmap${backend}.${ext}`));
for (const name of ["worker.js", "models/mindmap.bin", ...modules]) {
  await cp(join(packageDir, "dist", name), new URL(name, target));
}
