// Which of the package's native-ANTs goldens a kernel build keeps, and why (#462). It runs the steps of
// test/expected.mjs (runNativeReferenceSteps: two Mattes rigid registrations of the test pair,
// AverageAffineTransform, --apply with each interpolator and AverageImages) twice with the build in
// KERNEL_DIR, for example sdc-gate/build-wasm.sh's deriv64:
//
//   all:          every step in the build;
//   isolated:     the two registrations in the committed kernel, every other step in the build, so a
//                 golden that fails only under "all" fails because of the registrations.
//
//   node validation/variant-goldens.mjs KERNEL_DIR
//
// For each golden it prints whether the bytes are native ANTs's, and for "all" whether the seed-1234
// registration still recovers the known shift (assertRecoversShift) and its largest parameter change
// against the committed kernel's. The package's tests hold the committed kernel to these goldens;
// this script reports, and changes no golden.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHmcRegistration } from "../src/index.js";
import { readMatTransform } from "../src/mat.js";
import { loadHmcRegistration } from "../src/node.js";
import { NATIVE_MAT_SEED_4321_SHA256, NATIVE_MAT_SHA256, NATIVE_SHA256, assertRecoversShift, runNativeReferenceSteps } from "../test/expected.mjs";

const dir = process.argv[2];
if (!dir) throw new Error("usage: node validation/variant-goldens.mjs KERNEL_DIR");
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const data = new URL("../test/data/", import.meta.url);
const pair = { fixed: await readFile(new URL("fixed.nii", data)), moving: await readFile(new URL("moving.nii", data)) };
const wasmBinary = await readFile(join(dir, "hmc-registration.wasm"));
const { default: createModule } = await import(pathToFileURL(join(dir, "hmc-registration.mjs")).href);
const build = await createHmcRegistration({ createModule, wasmBinary });
const committed = await loadHmcRegistration();
const GOLDEN = { "seed12340GenericAffine.mat": NATIVE_MAT_SHA256, "seed43210GenericAffine.mat": NATIVE_MAT_SEED_4321_SHA256, ...NATIVE_SHA256 };

async function steps(registrationKernel) {
  const run = async (argv, inputs) => (argv.includes("--transform") ? registrationKernel : build).run(argv, inputs).outputs;
  const files = await runNativeReferenceSteps(run, pair);
  return { files, nativeBytes: Object.fromEntries(Object.entries(GOLDEN).map(([name, expected]) => [name, sha256(files[name]) === expected])) };
}

const all = await steps(build);
const isolated = await steps(committed);
const transform = readMatTransform(all.files["seed12340GenericAffine.mat"]);
let recoversShift = true;
try {
  assertRecoversShift(transform);
} catch (error) {
  recoversShift = error.message;
}
const reference = readMatTransform(isolated.files["seed12340GenericAffine.mat"]).parameters;
console.log(JSON.stringify({
  wasm_sha256: sha256(wasmBinary),
  all: { nativeBytes: all.nativeBytes, recoversShift, seed1234Sha256: sha256(all.files["seed12340GenericAffine.mat"]),
    maxParameterChange: Math.max(...transform.parameters.map((value, i) => Math.abs(value - reference[i]))) },
  isolated: { nativeBytes: isolated.nativeBytes },
}, null, 1));
