// Ground truth for LCModel's water scaling with the library's FID-A basis sets.
// Synthetic data are built from the basis itself (8 mM Cr, 10 mM NAA, 5 Hz extra
// Lorentzian broadening, as in vivo) together with a water reference of 2 protons
// x WCONC x ATTH2O at the basis' per-proton amplitude (1 at t = 0 for FID-A
// simulations), so a correct pipeline returns Cr+PCr 8 and NAA+NAAG 10.
//
// The app's control file (buildControl, with its default widened
// line-broadening prior, DESDT2 = 2 and RFWBAS = 80) recovers both. With
// LCModel's defaults it returns 0.87 of that. Native gfortran LCModel 6.3-1N
// gives the same numbers, so this is LCModel's behaviour with these basis
// sets, not the port: the reference Cr singlet of a 1.5 Hz Lorentzian basis is
// integrated over +-5 FWHMBA only (RFWBAS = 10; 92 % of its area), and the
// prior on Lorentzian broadening (DESDT2 = 0.4) keeps the fit from following
// Lorentzian tails. The second test pins that, the "LCModel defaults" option.
//
// The basis set comes from exes/fida/validation/fetch_reference.py
// (LCMODEL_BASIS_DIR, as in CI) or LCMODEL_BASIS; FIDA_REQUIRE_REFERENCE
// turns a missing basis set into a failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { loadLcmodel } from "../../../packages/lcmodel/src/wasm.js";
import { buildControl, FILES } from "../src/lcmodel-io.js";

const basisPath = process.env.LCMODEL_BASIS
  ?? `${process.env.LCMODEL_BASIS_DIR ?? `${process.env.TMPDIR}/basis-out`}/press-3t-te35.basis`;

/** In-place radix-2 FFT (sign -1 forward, +1 inverse, unnormalised). */
function fft(re, im, sign) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (sign * 2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k += 1) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Each metabolite's FID in LCModel's time-domain convention (inverse of MYBASI's CFFT). */
function basisFids(text) {
  const badelt = Number(text.match(/BADELT\s*=\s*([-\d.eE+]+)/)[1]);
  const n = Number(text.match(/NDATAB\s*=\s*(\d+)/)[1]);
  const fids = {};
  for (const block of text.split(/\$BASIS\s*\n/).slice(1)) {
    const name = block.match(/METABO\s*=\s*'([^']+)'/)[1];
    const v = block.split("$END")[1].trim().split(/\s+/).slice(0, 2 * n).map(Number);
    const re = Float64Array.from({ length: n }, (_, k) => v[2 * k]);
    const im = Float64Array.from({ length: n }, (_, k) => v[2 * k + 1]);
    fft(re, im, 1);
    const s = 1 / Math.sqrt(n);
    fids[name] = { re: re.map((x) => x * s), im: im.map((x) => x * s) };
  }
  return { badelt, fids };
}

const line = (re, im) => `${re.toExponential(6).toUpperCase().padStart(15)}${im.toExponential(6).toUpperCase().padStart(15)}`;
const lcmText = (re, im) => [" $NMID", " id='SYN', fmtdat='(2E15.6)'", " volume=1.0", " tramp=1.0", " $END", ...Array.from(re, (r, k) => line(r, im[k]))].join("\n") + "\n";

/** Fit the synthetic spectrum with the app's control file for `lineBroadening`. */
async function fitSynthetic(basisText, lineBroadening) {
  const { badelt, fids } = basisFids(basisText);
  const n = 2048;
  const dt = 0.0005;
  const step = Math.round(dt / badelt);
  const hz = Number(basisText.match(/HZPPPM\s*=\s*([-\d.eE+]+)/)[1]);
  const met = { re: new Float64Array(n), im: new Float64Array(n) };
  const water = { re: new Float64Array(n), im: new Float64Array(n) };
  let seed = 1;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 0.004;
  };
  for (let k = 0; k < n; k += 1) {
    const t = k * dt;
    const lb = Math.exp(-Math.PI * 5 * t);
    const j = k * step;
    met.re[k] = (8 * fids.Cr.re[j] + 10 * fids.NAA.re[j]) * lb + noise();
    met.im[k] = (8 * fids.Cr.im[j] + 10 * fids.NAA.im[j]) * lb + noise();
    water.re[k] = 2 * 35880 * 0.7 * Math.exp(-Math.PI * 6.5 * t);
  }
  const control = buildControl({ nunfil: n, deltat: dt, hzpppm: hz, water: true, ecc: false, lineBroadening });
  const lcm = await loadLcmodel(await readFile(new URL("../../../packages/lcmodel/src/lcmodel.wasm", import.meta.url)));
  const r = lcm.run({ control, files: { [FILES.basis]: basisText, [FILES.raw]: lcmText(met.re, met.im), [FILES.h2o]: lcmText(water.re, water.im) } });
  assert.equal(r.error, null, r.error);
  const conc = (name) => Number(r.outputs[FILES.table].split("\n").find((l) => l.trimEnd().endsWith(` ${name}`)).trim().split(/\s+/)[0]);
  return { cr: conc("Cr+PCr"), naa: conc("NAA+NAAG") };
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

test("the app's default fit returns the concentrations synthetic data were built with", async (t) => {
  const basis = await basisOrSkip(t);
  if (!basis) return;
  const { cr, naa } = await fitSynthetic(basis, undefined);
  assert.ok(Math.abs(cr / 8 - 1) < 0.01, `Cr+PCr ${cr}, built with 8`);
  assert.ok(Math.abs(naa / 10 - 1) < 0.01, `NAA+NAAG ${naa}, built with 10`);
});

test("LCModel's own prior, the LCModel defaults option, scales 13 % low with these basis sets", async (t) => {
  const basis = await basisOrSkip(t);
  if (!basis) return;
  const defaults = await fitSynthetic(basis, "lcmodel");
  assert.ok(Math.abs(defaults.cr / 8 - 0.872) < 0.01, `LCModel defaults: Cr+PCr ${defaults.cr}`);
  assert.ok(defaults.naa / 10 < 0.9, `LCModel defaults: NAA+NAAG ${defaults.naa}`);
});
