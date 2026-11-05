// The morphometrics against NeuroM 4.0.6 (validation/neurom-reference.json, recorded by
// validation/neurom_reference.py). NeuroM's own BSD test morphologies are committed under
// test/fixtures/neurom, and test/fixtures/trifurcation.swc covers a three-way branch point; the hosted examples are checked in the browser (e2e/smoke.spec.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { readSwc } from "../src/morph/swc.js";
import { analyse, buildMorphology } from "../src/morph/morphometrics.js";

const reference = JSON.parse(readFileSync(new URL("../validation/neurom-reference.json", import.meta.url), "utf8"));
const RELATIVE_TOLERANCE = 1e-6;
/** Angles also pass within this absolute error, in radians: near 0 a relative error says nothing. */
const ANGLE_TOLERANCE = 1e-7;

/** Every scalar, angle and Sholl count of `mine` against NeuroM's `expected`; returns the worst relative error. */
function compareWithNeuroM(mine, expected) {
  let worst = 0;
  assert.deepEqual(mine.center, expected.somaCenter);
  for (const [type, features] of Object.entries(expected.features)) {
    for (const [name, value] of Object.entries(features)) {
      const got = mine.features[type][name];
      if (Array.isArray(value)) {
        assert.equal(got.length, value.length, `${type}.${name} count`);
        const sorted = [...got].sort((a, b) => a - b);
        value.forEach((v, k) => {
          const absolute = Math.abs(sorted[k] - v);
          const error = absolute / Math.max(Math.abs(v), 1e-9);
          worst = Math.max(worst, error);
          assert.ok(error <= RELATIVE_TOLERANCE || absolute <= ANGLE_TOLERANCE, `${type}.${name}[${k}]: ${sorted[k]} vs NeuroM ${v}`);
        });
      } else if (Number.isInteger(value) && !name.match(/Length|Area|volume|Distance/)) {
        assert.equal(got, value, `${type}.${name}`);
      } else {
        const error = Math.abs(got - value) / Math.max(Math.abs(value), 1e-9);
        worst = Math.max(worst, error);
        assert.ok(error <= RELATIVE_TOLERANCE, `${type}.${name}: ${got} vs NeuroM ${value}`);
      }
    }
  }
  assert.deepEqual(mine.sholl.radii, expected.sholl.radii);
  for (const [type, counts] of Object.entries(expected.sholl.crossings)) assert.deepEqual(mine.sholl.crossings[type], counts, `Sholl ${type}`);
  return worst;
}

for (const path of ["neurom/Neuron.swc", "neurom/strahler.swc", "neurom/simple.swc", "trifurcation.swc"]) {
  const name = path.split("/").at(-1);
  test(`${name} matches NeuroM to 1e-6 and its Sholl counts exactly`, () => {
    const bytes = readFileSync(new URL(`fixtures/${path}`, import.meta.url));
    const expected = reference.morphologies.find((m) => m.file === name);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expected.sha256);
    // NeuroM measures the file as written, so the comparison does not repair radii.
    const { samples } = readSwc(bytes.toString("utf8"), { repair: false });
    compareWithNeuroM(analyse(buildMorphology(samples), expected.sholl.step), expected);
  });
}

test("the reference covers both hosted examples by checksum", () => {
  const examples = JSON.parse(readFileSync(new URL("../examples.json", import.meta.url), "utf8"));
  for (const example of examples) {
    const file = example.files[0];
    const expected = reference.morphologies.find((m) => m.file === file.name);
    assert.equal(expected?.sha256, file.sha256, file.name);
  }
});

test("Strahler orders follow the textbook tree NeuroM's strahler.swc recreates", () => {
  const { samples } = readSwc(readFileSync(new URL("fixtures/neurom/strahler.swc", import.meta.url), "utf8"));
  const result = analyse(buildMorphology(samples), 10);
  assert.equal(result.features.all.maxStrahlerOrder, 4);
  assert.equal(result.features.all.terminals, 10);
});
