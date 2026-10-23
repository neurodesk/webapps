// Stages the shoreline WebAssembly modules (packages/shoreline/wasm, built by its build:wasm)
// in public/shoreline-wasm/, so that the threaded module's helper workers load by URL.
import { cp, mkdir, rm } from "node:fs/promises";

const source = new URL("../../../packages/shoreline/wasm/", import.meta.url);
const target = new URL("../public/shoreline-wasm/", import.meta.url);

await rm(target, { recursive: true, force: true });
await mkdir(target, { recursive: true });
await cp(source, target, { recursive: true });
