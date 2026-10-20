// Stage the ANTs N4 WebAssembly runtime that the worker imports by URL at run time (Vite cannot
// bundle Emscripten's pthread glue). public/n4/ is gitignored.
import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../../../packages/n4/wasm/", import.meta.url);
const target = new URL("../public/n4/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
for (const name of ["n4-bias.mjs", "n4-bias.wasm"]) await cp(new URL(name, source), new URL(name, target));
