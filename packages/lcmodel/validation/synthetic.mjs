// Synthetic ground truth for LCModel's water scaling with the library's FID-A
// basis sets: a spectrum built from the basis itself (8 mM Cr, 10 mM NAA, 5 Hz
// extra Lorentzian broadening, as in vivo) and a water reference of 2 protons
// x WCONC x ATTH2O at the basis' per-proton amplitude (1 at t = 0 for FID-A
// simulations). A correct pipeline returns Cr+PCr 8 and NAA+NAAG 10.
// test/water-scaling.test.js fits it with the app's control file;
// cli-check.mjs fits it with the command line.

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

/** The truth the spectrum is built with, in mM. */
export const TRUTH = Object.freeze({ "Cr+PCr": 8, "NAA+NAAG": 10 });

/**
 * The synthetic spectrum and water reference as LCModel .RAW text, with the
 * acquisition numbers a fit needs.
 * @returns {{raw: string, h2o: string, nunfil: number, deltat: number, hzpppm: number}}
 */
export function syntheticSpectrum(basisText) {
  const { badelt, fids } = basisFids(basisText);
  const n = 2048;
  const dt = 0.0005;
  const step = Math.round(dt / badelt);
  const hzpppm = Number(basisText.match(/HZPPPM\s*=\s*([-\d.eE+]+)/)[1]);
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
    met.re[k] = (TRUTH["Cr+PCr"] * fids.Cr.re[j] + TRUTH["NAA+NAAG"] * fids.NAA.re[j]) * lb + noise();
    met.im[k] = (TRUTH["Cr+PCr"] * fids.Cr.im[j] + TRUTH["NAA+NAAG"] * fids.NAA.im[j]) * lb + noise();
    water.re[k] = 2 * 35880 * 0.7 * Math.exp(-Math.PI * 6.5 * t);
  }
  return { raw: lcmText(met.re, met.im), h2o: lcmText(water.re, water.im), nunfil: n, deltat: dt, hzpppm };
}

/**
 * Checks of a fit of the synthetic spectrum, as [passed, line] pairs. The
 * widened prior (the default) recovers the truth within 1 %. LCModel's own
 * prior returns 0.872 of the creatine (native gfortran LCModel gives the same):
 * its RFWBAS = 10 integrates the reference singlet of a 1.5 Hz Lorentzian basis
 * over +-5 basis linewidths, 92 % of its area.
 */
export function assessSynthetic(lineBroadening, { cr, naa }) {
  if (lineBroadening === "lcmodel") {
    return [
      [Math.abs(cr / TRUTH["Cr+PCr"] - 0.872) < 0.01, `LCModel's prior: Cr+PCr ${cr} is 0.872 +- 0.01 of ${TRUTH["Cr+PCr"]}`],
      [naa / TRUTH["NAA+NAAG"] < 0.9, `LCModel's prior: NAA+NAAG ${naa} is below 0.9 of ${TRUTH["NAA+NAAG"]}`],
    ];
  }
  return [
    [Math.abs(cr / TRUTH["Cr+PCr"] - 1) < 0.01, `widened prior: Cr+PCr ${cr} within 1 % of ${TRUTH["Cr+PCr"]}`],
    [Math.abs(naa / TRUTH["NAA+NAAG"] - 1) < 0.01, `widened prior: NAA+NAAG ${naa} within 1 % of ${TRUTH["NAA+NAAG"]}`],
  ];
}

/** A metabolite's concentration in a .TABLE file. */
export function tableConcentration(table, name) {
  const row = table.split("\n").find((l) => l.trimEnd().endsWith(` ${name}`));
  return row ? Number(row.trim().split(/\s+/)[0]) : Number.NaN;
}
