// Stages the browser runtimes into public/ (gitignored): Greedy's threaded WASM and niimath's Emscripten module.
// Vite bundles the fastprep core and glm WASM (wasm-bindgen's default URL) and MindGrab's models; the MNI template
// comes from the pinned manifest.
import { cp, mkdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const pub = new URL("../public/", import.meta.url);
const stage = async (name, from, files) => {
  const to = new URL(`${name}/`, pub);
  await rm(to, { recursive: true, force: true });
  await mkdir(to, { recursive: true });
  if (!files) return cp(from, to, { recursive: true });
  for (const f of files) await cp(join(from, f), new URL(f, to));
};

await stage("greedy-wasm", new URL("../../../packages/greedy/wasm/", import.meta.url));
await stage("niimath", dirname(require.resolve("@niivue/niimath/niimath.js")), ["niimath.js", "niimath.wasm"]);
