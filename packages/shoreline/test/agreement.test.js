// The single-threaded WebAssembly module against the native binary on a phantom (test/agreement.mjs).
// Generates the phantom with the crate's ignored export test, so it needs cargo and
// `pnpm build:wasm` first. The threaded module needs Web Workers, which Node does not have
// (wasm-bindgen-rayon starts its pool with `new Worker`); the dwicorrect browser test compares it.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runShoreline } from "../src/index.js";
import { INPUTS, args, assertAgreement, runNative } from "./agreement.mjs";

const single = fileURLToPath(new URL("../wasm/single/", import.meta.url));

test("the WebAssembly module agrees with the native binary on a phantom", { skip: !existsSync(join(single, "shoreline_wasm_bg.wasm")) && "run pnpm --filter @neurodesk/shoreline build:wasm first", timeout: 1_200_000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "shoreline-agreement-"));
  try {
    runNative(dir);
    const glue = await import(join(single, "shoreline_wasm.js"));
    glue.initSync({ module: readFileSync(join(single, "shoreline_wasm_bg.wasm")) });
    const files = Object.fromEntries(INPUTS.map((name) => [name, readFileSync(join(dir, name))]));
    const outputs = runShoreline({ api: glue, files, args: args("wasm") });
    const differences = assertAgreement(outputs, dir);
    assert.ok(Object.keys(differences).length >= 8);
    console.log(`single-threaded WebAssembly against native (2 threads), largest relative difference: ${JSON.stringify(differences)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
