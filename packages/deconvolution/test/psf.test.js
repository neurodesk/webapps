// The Gibson-Lanni PSF of the committed module against two references recorded by
// validation/psf_reference.py: adaptive quadrature of the same integral (every case), and
// psfmodels 0.3.3's scalar_psf on its central row, where psfmodels integrates at exact pixel
// radii (cases without evanescent light; see README.md for the evanescent case).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { loadDeconvolution } from "../src/node.js";

const reference = JSON.parse(readFileSync(new URL("../validation/psf-reference.json", import.meta.url), "utf8"));
const { gibsonLanniPsf } = loadDeconvolution();

function psfFor(c) {
  return gibsonLanniPsf(c.na, c.ni, c.ns, c.emission, c.excitation, c.dxy, c.dz, c.xy, c.nz, c.pz);
}

for (const c of reference.cases) {
  test(`${c.id}: equals adaptive quadrature within 1e-6 of the peak`, () => {
    const psf = psfFor(c);
    const centre = (c.xy - 1) / 2;
    let worst = 0;
    for (const [zi, dx, want] of c.quadrature) {
      const got = psf[(zi * c.xy + centre) * c.xy + centre + dx];
      worst = Math.max(worst, Math.abs(got - want));
    }
    assert.ok(worst < 1e-6, `max |difference| ${worst}`);
  });

  test(`${c.id}: ${c.evanescent ? "differs from" : "equals"} psfmodels on its exact central row`, () => {
    const psf = psfFor(c);
    const centre = (c.xy - 1) / 2;
    let worst = 0;
    c.psfmodelsCentralRow.forEach((line, zi) => {
      line.forEach((want, x) => {
        worst = Math.max(worst, Math.abs(psf[(zi * c.xy + centre) * c.xy + x] - want));
      });
    });
    // psfmodels' own integration error is about 2e-5 here, and 1.6e-3 where light is
    // evanescent in the sample (ns < NA), which adaptive quadrature attributes to psfmodels.
    if (c.evanescent) assert.ok(worst < 5e-3, `max |difference| ${worst}`);
    else assert.ok(worst < 1e-4, `max |difference| ${worst}`);
  });
}

test("the PSF peaks at 1 on the centre voxel for an index-matched sample", () => {
  const psf = gibsonLanniPsf(1.4, 1.518, 1.518, 0.52, 0, 0.1, 0.2, 15, 11, 0);
  const centre = (5 * 15 + 7) * 15 + 7;
  assert.equal(psf[centre], 1);
  assert.equal(Math.max(...psf), 1);
});

test("bad optics and even sizes are refused", () => {
  assert.throws(() => gibsonLanniPsf(1.6, 1.518, 1.518, 0.52, 0, 0.1, 0.2, 15, 11, 0), /NA below the immersion index/);
  assert.throws(() => gibsonLanniPsf(1.4, 1.518, 1.518, 0.52, 0, 0.1, 0.2, 14, 11, 0), /odd/);
});
