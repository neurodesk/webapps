// Node loader for the committed WebAssembly module: tests, validation scripts and any
// future command line run the same binary as the web app's worker.
import { readFileSync } from "node:fs";
import { initSync, gibsonLanniPsf, paddedDims, Deconvolver } from "../wasm/deconvolution_wasm.js";

let loaded = null;

export function loadDeconvolution() {
  if (!loaded) {
    initSync({ module: readFileSync(new URL("../wasm/deconvolution_wasm_bg.wasm", import.meta.url)) });
    loaded = Object.freeze({ gibsonLanniPsf, paddedDims, Deconvolver });
  }
  return loaded;
}
