// Stage @niivue/meica's single-threaded WebAssembly build where the worker loads it. Only
// dist/single: the threaded build links Apache-2.0 wasm-bindgen-rayon and must not be deployed
// until its licensing is determined (meica-rs AGENTS.md), even from a local checkout that has it.
// The build's glue and binary use relative URLs and stay together.
import { cp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const dist = join(dirname(createRequire(import.meta.url).resolve("@niivue/meica/package.json")), "dist");
const target = new URL("../public/meica-wasm/", import.meta.url);
await rm(target, { recursive: true, force: true });
await cp(join(dist, "single"), new URL("single/", target), { recursive: true });
