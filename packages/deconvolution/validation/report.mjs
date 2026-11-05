// Print the agreement of the committed module with the recorded references (README numbers).
import { readFileSync } from "node:fs";
import { loadDeconvolution } from "../src/node.js";

const { gibsonLanniPsf, Deconvolver } = loadDeconvolution();
const read = (name) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const decode = (text) => {
  const bytes = Buffer.from(text, "base64");
  return new Float64Array(bytes.buffer, bytes.byteOffset, bytes.length / 8).slice();
};

for (const c of read("./psf-reference.json").cases) {
  const psf = gibsonLanniPsf(c.na, c.ni, c.ns, c.emission, c.excitation, c.dxy, c.dz, c.xy, c.nz, c.pz);
  const centre = (c.xy - 1) / 2;
  const quad = Math.max(...c.quadrature.map(([zi, dx, want]) => Math.abs(psf[(zi * c.xy + centre) * c.xy + centre + dx] - want)));
  const row = Math.max(...c.psfmodelsCentralRow.flatMap((line, zi) => line.map((want, x) => Math.abs(psf[(zi * c.xy + centre) * c.xy + x] - want))));
  console.log(`PSF ${c.id.padEnd(20)} vs quadrature ${quad.toExponential(1)}  vs psfmodels ${row.toExponential(1)}${c.evanescent ? " (evanescent)" : ""}`);
}
for (const c of read("./rl-reference.json").cases) {
  const d = new Deconvolver(decode(c.image), Uint32Array.from(c.dims), decode(c.psf), Uint32Array.from(c.psfDims), 0);
  d.iterate(c.iterations);
  const got = d.estimate();
  const want = decode(c.expected);
  let worst = 0;
  for (let i = 0; i < got.length; i += 1) worst = Math.max(worst, Math.abs(got[i] - want[i]) / Math.abs(want[i]));
  console.log(`RL  ${c.id.padEnd(20)} vs skimage max relative difference ${worst.toExponential(1)}`);
}
