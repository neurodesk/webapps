// The WebAssembly module (single-threaded build) against the native binary on a phantom:
// both run dwi_shoreline::cli::run, so their outputs must agree. Generates the phantom with
// the crate's ignored export test, so it needs cargo and `pnpm build:wasm` first.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runShoreline } from "../src/index.js";

const single = fileURLToPath(new URL("../wasm/single/", import.meta.url));
const workspace = fileURLToPath(new URL("../../../exes/dwi/", import.meta.url));
const inputs = ["dwi.nii.gz", "mask.nii.gz", "field.nii.gz", "acqp", "index", "bvals", "bvecs"];
const args = (out) => [
  "--imain=dwi.nii.gz", "--mask=mask.nii.gz", "--acqp=acqp", "--index=index", "--bvecs=bvecs", "--bvals=bvals",
  "--field=field.nii.gz", "--flm=quadratic", "--slm=linear", "--repol", "--niter=5", "--fwhm=2", `--out=${out}`,
];
// Relative to the largest value. On 30 ADNI sessions and 4 OpenNeuro series the two builds
// differed by at most 4e-8 (float32 rounding) and 1.3e-5 in the 4-decimal z-score maps.
const TOLERANCE = 1e-5;

function numbers(bytes) {
  return new TextDecoder().decode(bytes).split(/\s+/).filter((t) => /^[-+0-9.eE]+$/.test(t)).map(Number);
}

function floats(gz) {
  const raw = gunzipSync(gz);
  const offset = raw.readFloatLE(108);
  return new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.length));
}

function assertClose(name, a, b) {
  assert.equal(a.length, b.length, `${name}: ${a.length} values against ${b.length}`);
  let scale = 0;
  let worst = 0;
  for (let i = 0; i < b.length; i++) {
    scale = Math.max(scale, Math.abs(b[i]));
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }
  assert.ok(worst <= TOLERANCE * Math.max(scale, 1e-12), `${name}: largest difference ${worst} (scale ${scale})`);
}

test("the WebAssembly module agrees with the native binary on a phantom", { skip: !existsSync(join(single, "shoreline_wasm_bg.wasm")) && "run pnpm --filter @neurodesk/shoreline build:wasm first", timeout: 1_200_000 }, async () => {
  const dir = mkdtempSync(join(process.env.TMPDIR || tmpdir(), "shoreline-agreement-"));
  try {
    const cargo = (cargoArgs, env = {}) => execFileSync("cargo", cargoArgs, { cwd: workspace, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
    cargo(["test", "--release", "--locked", "-p", "dwi-shoreline", "--test", "synthetic", "export_command_line_phantom", "--", "--ignored"], { SHORELINE_CLI_PHANTOM_DIR: dir });
    cargo(["build", "--release", "--locked", "-p", "dwi-shoreline"]);
    execFileSync(join(workspace, "target/release/shoreline"), [...args("native"), "--nthr=2"], { cwd: dir, stdio: "ignore" });

    const glue = await import(join(single, "shoreline_wasm.js"));
    glue.initSync({ module: readFileSync(join(single, "shoreline_wasm_bg.wasm")) });
    const files = Object.fromEntries(inputs.map((name) => [name, readFileSync(join(dir, name))]));
    const outputs = runShoreline({ api: glue, files, args: args("wasm") });

    const native = readdirSync(dir).filter((name) => name.startsWith("native.") && name !== "native.log");
    assert.ok(native.length >= 8, `native outputs: ${native}`);
    for (const name of native) {
      const suffix = name.slice("native".length);
      const ours = outputs[`wasm${suffix}`];
      assert.ok(ours, `the WebAssembly run wrote no wasm${suffix}`);
      const theirs = readFileSync(join(dir, name));
      if (suffix === ".nii.gz") assertClose(suffix, floats(ours), floats(theirs));
      else if (suffix === ".outlier_map") assert.equal(new TextDecoder().decode(ours), theirs.toString(), suffix);
      else assertClose(suffix, numbers(ours), numbers(theirs));
    }
    assert.ok(new TextDecoder().decode(outputs["wasm.log"]).includes("done"), "the log ends the run");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
