import { createHash } from "node:crypto";

const axes = ["tx", "ty", "tz", "rx", "ry", "rz"];
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

// The plan's Q53 pivot is the world grid centre. The public motion TSV follows QSIPrep,
// whose pivot omits the affine origin; keep both comparisons visible in the report.
function parameters(hmc, transform, grid, convention) {
  const row = hmc.motionParams([transform], grid)[0];
  const translation = [...row.translation];
  if (convention === "world") {
    const sign = [-1, -1, 1];
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const rotation = sign[i] * sign[j] * transform.parameters[3 * i + j];
        translation[i] += (rotation - Number(i === j)) * grid.affine[j][3];
      }
    }
  }
  const values = [...translation, ...row.rotation.map(value => value * 180 / Math.PI)];
  if (!values.every(Number.isFinite)) throw new Error("Nonfinite motion cannot pass the native-float gate.");
  return values;
}

export function nativeFloatGate({ hmc, grid, cases }) {
  if (!cases.length) throw new Error("The native-float gate requires registration cases.");
  const conventions = {};
  for (const convention of ["world", "qsiprep"]) {
    const rows = cases.map(({ volume, rawVolume, wasm, nativeFloat, nativeDouble, secondSeed }) => {
      const [actual, reference, original, seed] = [wasm, nativeFloat, nativeDouble, secondSeed]
        .map(bytes => parameters(hmc, hmc.readMat(bytes), grid, convention));
      const difference = actual.map((value, k) => Math.abs(value - reference[k]));
      const spread = original.map((value, k) => Math.abs(value - seed[k]));
      const doubleDifference = actual.map((value, k) => Math.abs(value - original[k]));
      return {
        volume, rawVolume, difference, spread, doubleDifference,
        failingAxes: axes.filter((_, k) => difference[k] > spread[k]),
        doubleFailingAxes: axes.filter((_, k) => doubleDifference[k] > spread[k]),
        equalsNativeFloat: hash(wasm) === hash(nativeFloat),
      };
    });
    conventions[convention] = {
      failingVolumes: rows.filter(row => row.failingAxes.length).length,
      failingCells: rows.reduce((count, row) => count + row.failingAxes.length, 0),
      rows,
    };
  }
  return {
    rule: "2026-10-24 #451: |WASM - native float| <= per-volume, per-axis native-double seed spread, about the world grid centre; QSIPrep convention and double comparison are also reported.",
    pass: conventions.world.failingCells === 0,
    ...conventions,
  };
}
