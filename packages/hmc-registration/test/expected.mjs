// What a rigid registration of test/data/moving.nii to test/data/fixed.nii must give, in Node and
// in a browser worker.
import assert from "node:assert/strict";
import { SHIFT_RAS } from "../scripts/make-test-data.mjs";

export const ARGV = Object.freeze([
  "--dimensionality", "3", "--float", "1", "--random-seed", "1234",
  "--transform", "Rigid[0.1]",
  "--metric", "Mattes[fixed.nii,moving.nii,1,32,Regular,0.25]",
  "--convergence", "[100x50,1e-6,10]", "--shrink-factors", "2x1", "--smoothing-sigmas", "1x0vox",
  "--output", "[out]",
]);

// ITK works in LPS, so the RAS shift changes sign on x and y. The transform maps fixed points to
// moving points, so its translation is the shift itself.
export const SHIFT_LPS = Object.freeze([-SHIFT_RAS[0], -SHIFT_RAS[1], SHIFT_RAS[2]]);

// SHA-256 of out0GenericAffine.mat from native antsRegistration at ANTs 52bc0ab (SuperBuild,
// Release, ITK_GLOBAL_DEFAULT_NUMBER_OF_THREADS=1) with ARGV, built with the kernel's float64
// accumulation in the Mattes metric (cmake/mattes-pdf-double.cmake; validation/sdc-gate/native,
// variant deriv64). The WebAssembly kernel writes the same bytes.
export const NATIVE_MAT_SHA256 = "e70a8ac13558d80cede25caddc77d7c3b74b3e47d64559716a171fa50fecd75b";

/** Asserts that a transform read by readMatTransform is the known rigid shift. */
export function assertRecoversShift({ transform, parameters, fixed }) {
  assert.equal(transform, "AffineTransform_float_3_3");
  assert.equal(parameters.length, 12);
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  parameters.slice(0, 9).forEach((value, i) => assert.ok(Math.abs(value - identity[i]) < 0.005, `matrix[${i}] = ${value}`));
  // The centre is the grid centre, the origin, so the translation is the offset itself.
  assert.deepEqual(fixed, [0, 0, 0]);
  parameters.slice(9).forEach((value, axis) => assert.ok(Math.abs(value - SHIFT_LPS[axis]) < 0.05, `translation[${axis}] = ${value}, expected ${SHIFT_LPS[axis]}`));
}

// SHA-256 of out0GenericAffine.mat from native antsRegistration with ARGV and --random-seed 4321.
export const NATIVE_MAT_SEED_4321_SHA256 = "0dadfd90f6e1ae1e7b0b9183e31e797014d1170e9c68338af65f65a0c4a1b823";

// The interpolators --apply takes, as antsApplyTransforms names them.
export const INTERPOLATIONS = Object.freeze(["Linear", "NearestNeighbor", "BSpline", "BSpline[5]", "HammingWindowedSinc", "LanczosWindowedSinc"]);

// SHA-256 of each file that native ANTs at 52bc0ab with the same Mattes accumulation
// (validation/native-reference.sh on the deriv64 build) writes from
// test/data. The WebAssembly kernel writes the same bytes: a tolerance of 0, inside the 1e-5
// relative limit of #445. apply-<name>.nii is antsApplyTransforms in its default double precision
// with -u float; with --float 1 native ANTs differs from it by at most 5.1e-7 of the image maximum.
export const NATIVE_SHA256 = Object.freeze({
  "average.mat": "268138b70b05e28d1c163faa093076f7ba0752deeb1f793f03a1e878f809af1d",
  "apply-Linear.nii": "666f3c3d34eadbd1d2f6ef8137864c60d2aab8c39ed0837e835b6e1bf8f65485",
  "apply-NearestNeighbor.nii": "c449329cd82220ca457d05b12734097fe956e3cbac863e1eac830f1f3eb034ad",
  "apply-BSpline.nii": "5d1979ed9ceefc873433ac4fbe80672e7d6c5d0b235abc1c0cf74626463dd5dc",
  "apply-BSpline5.nii": "14d8f42b4ac7f2c20691182d960673e5ee9b8b1ab6c70247b374141caf376f55",
  "apply-HammingWindowedSinc.nii": "1c339e2c689949cdbb2129d319e2c4d7b0aa60b1b0ea4d5b931166f4ab6a3468",
  "apply-LanczosWindowedSinc.nii": "ae2515a70a5b1866105fe1542e3c0e24ae8414d55580e1b85d210558bc655d7f",
  "apply-inverse-HammingWindowedSinc.nii": "a3db344012d1ac7c0f57e984c2ca7d83a54fff606d5453e558b5494dd671140e",
  "average-0.nii": "c15361d9f53d121e33075e6b6a2f7e608a378857834dc3f1a80db584ca0b02d5",
  "average-1.nii": "c7820698ca47562362b2ac47dbd679e3b5b1a6c45322088221dd5ce98841da47",
});

const withSeed = (seed) => ARGV.map((token, i) => (ARGV[i - 1] === "--random-seed" ? seed : token));

/**
 * The steps of validation/native-reference.sh, through `run(argv, inputs) -> outputs`: two
 * registrations, AverageAffineTransform, --apply with each interpolator and through the inverse
 * of the average (the SHORELine template step), and AverageImages without and with normalization.
 * @returns {Promise<Record<string, Uint8Array>>} every file named in NATIVE_SHA256, and the two registrations
 */
export async function runNativeReferenceSteps(run, { fixed, moving }) {
  const pair = () => ({ "fixed.nii": fixed, "moving.nii": moving });
  const files = {};
  for (const seed of ["1234", "4321"]) {
    const outputs = await run(withSeed(seed).map((token) => (token === "[out]" ? `[seed${seed}]` : token)), pair());
    files[`seed${seed}0GenericAffine.mat`] = outputs[`seed${seed}0GenericAffine.mat`];
  }
  const average = await run(["AverageAffineTransform", "3", "average.mat", "a.mat", "b.mat"], {
    "a.mat": files["seed12340GenericAffine.mat"],
    "b.mat": files["seed43210GenericAffine.mat"],
  });
  files["average.mat"] = average["average.mat"];
  for (const interpolation of INTERPOLATIONS) {
    const name = `apply-${interpolation.replace(/[[\]]/g, "")}.nii`;
    const outputs = await run(["--apply", "fixed.nii", "moving.nii", name, interpolation, "0", "t.mat"], { ...pair(), "t.mat": files["seed12340GenericAffine.mat"] });
    files[name] = outputs[name];
  }
  const inverseName = "apply-inverse-HammingWindowedSinc.nii";
  const inverse = await run(["--apply", "fixed.nii", "moving.nii", inverseName, "HammingWindowedSinc", "0", "inverse:average.mat"], {
    ...pair(),
    "average.mat": files["average.mat"],
  });
  files[inverseName] = inverse[inverseName];
  for (const normalize of ["0", "1"]) {
    const name = `average-${normalize}.nii`;
    const outputs = await run(["AverageImages", "3", name, normalize, "fixed.nii", "apply-Linear.nii"], { "fixed.nii": fixed, "apply-Linear.nii": files["apply-Linear.nii"] });
    files[name] = outputs[name];
  }
  return files;
}

/** The voxels of a NIfTI-1 file with int16 or float32 data, as numbers. */
export function niftiVoxels(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = view.getFloat32(108, true);
  const type = view.getInt16(70, true);
  const count = [1, 2, 3].reduce((product, axis) => product * view.getInt16(40 + 2 * axis, true), 1);
  const size = { 4: 2, 16: 4 }[type];
  if (!size) throw new Error(`Unsupported NIfTI datatype ${type}.`);
  return Array.from({ length: count }, (_, i) => (type === 4 ? view.getInt16(offset + 2 * i, true) : view.getFloat32(offset + 4 * i, true)));
}

/** max |a - b| / max |b| over the central 16^3 voxels of two 32^3 volumes. */
export function centralRelativeError(a, b) {
  let difference = 0;
  let maximum = 0;
  for (let k = 8; k < 24; k++) {
    for (let j = 8; j < 24; j++) {
      for (let i = 8; i < 24; i++) {
        const index = i + 32 * (j + 32 * k);
        difference = Math.max(difference, Math.abs(a[index] - b[index]));
        maximum = Math.max(maximum, Math.abs(b[index]));
      }
    }
  }
  return difference / maximum;
}
