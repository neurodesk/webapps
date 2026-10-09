// Ground truth for LCModel's water scaling with the library's FID-A basis sets,
// from the synthetic spectrum of validation/synthetic.mjs (8 mM Cr, 10 mM NAA).
//
// The app's control file (buildControl, with its default widened
// line-broadening prior, DESDT2 = 2 and RFWBAS = 80) recovers both. With
// LCModel's defaults it returns 0.87 of that. Native gfortran LCModel 6.3-1N
// gives the same numbers, so this is LCModel's behaviour with these basis
// sets, not the port: the reference Cr singlet of a 1.5 Hz Lorentzian basis is
// integrated over +-5 FWHMBA only (RFWBAS = 10; 92 % of its area), and the
// prior on Lorentzian broadening (DESDT2 = 0.4) keeps the fit from following
// Lorentzian tails. The second test pins that, the "LCModel defaults" option.
// The command line's release check (validation/cli-check.mjs) holds the
// packaged command line to the same numbers.
//
// The basis set comes from exes/fida/validation/fetch_reference.py
// (LCMODEL_BASIS_DIR, as in CI) or LCMODEL_BASIS; FIDA_REQUIRE_REFERENCE
// turns a missing basis set into a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadLcmodel } from "../src/wasm.js";
import { buildControl, FILES } from "../src/lcmodel-io.js";
import { assessSynthetic, syntheticSpectrum, tableConcentration } from "../validation/synthetic.mjs";

const basisPath = process.env.LCMODEL_BASIS
  ?? `${process.env.LCMODEL_BASIS_DIR ?? `${process.env.TMPDIR}/basis-out`}/press-3t-te35.basis`;

/** Fit the synthetic spectrum with the app's control file for `lineBroadening`. */
async function fitSynthetic(basisText, lineBroadening) {
  const { raw, h2o, nunfil, deltat, hzpppm } = syntheticSpectrum(basisText);
  const control = buildControl({ nunfil, deltat, hzpppm, water: true, ecc: false, lineBroadening });
  const lcm = await loadLcmodel(await readFile(new URL("../src/lcmodel.wasm", import.meta.url)));
  const r = lcm.run({ control, files: { [FILES.basis]: basisText, [FILES.raw]: raw, [FILES.h2o]: h2o } });
  assert.equal(r.error, null, r.error);
  const table = r.outputs[FILES.table];
  return { cr: tableConcentration(table, "Cr+PCr"), naa: tableConcentration(table, "NAA+NAAG") };
}

async function basisOrSkip(t) {
  try {
    return await readFile(basisPath, "utf8");
  } catch {
    if (process.env.FIDA_REQUIRE_REFERENCE) throw new Error(`no FID-A basis set at ${basisPath}: FIDA_REQUIRE_REFERENCE is set`);
    t.skip(`no FID-A basis set at ${basisPath} (set LCMODEL_BASIS_DIR or LCMODEL_BASIS)`);
    return null;
  }
}

function assertChecks(checks) {
  for (const [passed, line] of checks) assert.ok(passed, line);
}

test("the app's default fit returns the concentrations synthetic data were built with", async (t) => {
  const basis = await basisOrSkip(t);
  if (!basis) return;
  assertChecks(assessSynthetic("widened", await fitSynthetic(basis, undefined)));
});

test("LCModel's own prior, the LCModel defaults option, scales 13 % low with these basis sets", async (t) => {
  const basis = await basisOrSkip(t);
  if (!basis) return;
  assertChecks(assessSynthetic("lcmodel", await fitSynthetic(basis, "lcmodel")));
});
