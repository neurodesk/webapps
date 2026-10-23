// The comparison of a WebAssembly run with the native binary on the command-line phantom, shared
// by test/agreement.test.js (the single-threaded module in Node) and the dwicorrect browser test
// (the threaded module, which needs Web Workers and so a browser). Both run
// dwi_shoreline::cli::run, so their outputs must agree.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const workspace = fileURLToPath(new URL("../../../exes/dwi/", import.meta.url));

/** The phantom's input files, as the command line names them. */
export const INPUTS = ["dwi.nii.gz", "mask.nii.gz", "field.nii.gz", "acqp", "index", "bvals", "bvecs"];

/** The command line of both runs, writing to `out`. */
export const args = (out) => [
  "--imain=dwi.nii.gz", "--mask=mask.nii.gz", "--acqp=acqp", "--index=index", "--bvecs=bvecs", "--bvals=bvals",
  "--field=field.nii.gz", "--flm=quadratic", "--slm=linear", "--repol", "--niter=5", "--fwhm=2", `--out=${out}`,
];

// Relative to the largest value. On 30 ADNI sessions and 4 OpenNeuro series the two builds
// differed by at most 4e-8 (float32 rounding) and 1.3e-5 in the 4-decimal z-score maps.
export const TOLERANCE = 1e-5;

/** Writes the phantom into `dir` and runs the native binary on it (outputs `native.*`). */
export function runNative(dir, threads = 2) {
  const cargo = (cargoArgs, env = {}) => execFileSync("cargo", cargoArgs, { cwd: workspace, env: { ...process.env, ...env }, stdio: ["ignore", "ignore", "inherit"] });
  cargo(["test", "--release", "--locked", "-p", "dwi-shoreline", "--test", "synthetic", "export_command_line_phantom", "--", "--ignored"], { SHORELINE_CLI_PHANTOM_DIR: dir });
  cargo(["build", "--release", "--locked", "-p", "dwi-shoreline"]);
  execFileSync(join(workspace, "target/release/shoreline"), [...args("native"), `--nthr=${threads}`], { cwd: dir, stdio: "ignore" });
}

function numbers(bytes) {
  return new TextDecoder().decode(bytes).split(/\s+/).filter((t) => /^[-+0-9.eE]+$/.test(t)).map(Number);
}

function floats(gz) {
  const raw = gunzipSync(gz);
  const offset = raw.readFloatLE(108);
  return new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.length));
}

/** The largest difference relative to the largest value; fails beyond TOLERANCE. */
function assertClose(name, a, b) {
  assert.equal(a.length, b.length, `${name}: ${a.length} values against ${b.length}`);
  let scale = 0;
  let worst = 0;
  for (let i = 0; i < b.length; i++) {
    scale = Math.max(scale, Math.abs(b[i]));
    worst = Math.max(worst, Math.abs(a[i] - b[i]));
  }
  assert.ok(worst <= TOLERANCE * Math.max(scale, 1e-12), `${name}: largest difference ${worst} (scale ${scale})`);
  return worst / Math.max(scale, 1e-12);
}

/**
 * Compares the WebAssembly outputs (`wasm.*`, by name) with the native ones in `dir`; returns
 * the largest relative difference per file.
 */
export function assertAgreement(outputs, dir) {
  const native = readdirSync(dir).filter((name) => name.startsWith("native.") && name !== "native.log");
  assert.ok(native.length >= 8, `native outputs: ${native}`);
  const differences = {};
  for (const name of native) {
    const suffix = name.slice("native".length);
    const ours = outputs[`wasm${suffix}`];
    assert.ok(ours, `the WebAssembly run wrote no wasm${suffix}`);
    const theirs = readFileSync(join(dir, name));
    if (suffix === ".nii.gz") differences[suffix] = assertClose(suffix, floats(ours), floats(theirs));
    else if (suffix === ".outlier_map") {
      assert.equal(new TextDecoder().decode(ours), theirs.toString(), suffix);
      differences[suffix] = 0;
    } else differences[suffix] = assertClose(suffix, numbers(ours), numbers(theirs));
  }
  assert.ok(new TextDecoder().decode(outputs["wasm.log"]).includes("done"), "the log ends the run");
  return differences;
}
