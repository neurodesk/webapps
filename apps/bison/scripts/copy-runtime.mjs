// Stage the two ANTs kernels that the BISON worker starts by URL (Vite never emits them):
// antsRegistration from packages/hmc-registration and DenoiseImage from packages/ants-denoise.
// Each keeps its package layout (src/*.js beside ../wasm/), because each worker script imports
// its siblings and finds its pinned kernel relative to itself. The folder is gitignored.
import { cp, mkdir, rm } from "node:fs/promises";

const target = new URL("../public/bison-runtime/", import.meta.url);
const packages = new URL("../../../packages/", import.meta.url);

const KERNELS = {
  "hmc-registration": {
    src: ["worker.js", "index.js", "pin.js", "mat.js"],
    wasm: ["hmc-registration.mjs", "hmc-registration.wasm"],
  },
  "ants-denoise": {
    src: ["worker.js", "index.js", "pin.js"],
    wasm: ["ants-denoise.mjs", "ants-denoise.wasm"],
  },
};

await rm(target, { recursive: true, force: true });
for (const [name, folders] of Object.entries(KERNELS)) {
  for (const [folder, files] of Object.entries(folders)) {
    const to = new URL(`${name}/${folder}/`, target);
    await mkdir(to, { recursive: true });
    for (const file of files) await cp(new URL(`${name}/${folder}/${file}`, packages), new URL(file, to));
  }
  for (const file of ["LICENSE", "NOTICE"]) await cp(new URL(`${name}/${file}`, packages), new URL(`${name}/${file}`, target));
}
