import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { HMC_REGISTRATION_WASM_SHA256 } from "../src/pin.js";

for (const scenario of ["full-success", "worker-error", "worker-event-error", "missing-warp", "wrong-warp", "launch-error", "cancel-success", "cancel-late", "cancel-bad-recovery"]) {
  test(`browser CLI ${scenario}: cleanup preserves the acceptance exit status`, { skip: process.platform !== "linux" && "the measurement CLI uses Linux /proc" }, () => {
    const directory = mkdtempSync(join(tmpdir(), "hmc-browser-cli-"));
    try {
      const argv = ["--transform", "SyN[0.1]"];
      writeFileSync(join(directory, "ants-calls.jsonl"), JSON.stringify({ tool: "antsRegistration", cwd: directory, argv }) + "\n");
      writeFileSync(join(directory, "wasm-calls.jsonl"), JSON.stringify({ program: "antsRegistration", argv: [...argv, "--random-seed", "1234"], wasm_sha256: HMC_REGISTRATION_WASM_SHA256 }) + "\n");
      for (const file of ["fmap_syn0Warp.nii.gz", "fmap_syn0InverseWarp.nii.gz"]) writeFileSync(join(directory, file), gzipSync(Buffer.from(file)));
      const out = join(directory, "results");
      const done = spawnSync(process.execPath, ["--import", fileURLToPath(new URL("./fixtures/browser-syn/loader.mjs", import.meta.url)),
        fileURLToPath(new URL("../validation/browser-syn.mjs", import.meta.url)), scenario.startsWith("cancel") ? "cancel" : "full", directory, out],
      { env: { ...process.env, HMC_BROWSER_TEST_CASE: scenario }, encoding: "utf8", timeout: 10000 });
      assert.equal(done.error, undefined, done.stderr);
      assert.equal(done.status, scenario.endsWith("success") ? 0 : 1, done.stdout + done.stderr);
      const report = JSON.parse(readFileSync(join(out, "result.json"), "utf8"));
      if (!scenario.endsWith("success")) assert.ok(report.error);
      assert.deepEqual(JSON.parse(readFileSync(join(out, "left-processes.json"), "utf8")), []);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
}
