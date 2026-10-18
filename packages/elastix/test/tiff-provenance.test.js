import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readInput } from "../src/node.js";
import { writeOmeTiff } from "../src/ome-tiff.js";
import { omeTiffIssue } from "../src/outputs.js";
import { tiffFixture } from "./tiff-fixture.js";

async function readFixture(t, options) {
  const directory = await mkdtemp(join(tmpdir(), "elastix-tiff-provenance-"));
  t.after(() => rm(directory, { force: true, recursive: true }));
  const path = join(directory, "input.ome.tif");
  await writeFile(path, await tiffFixture(options));
  return { source: await readInput(path, "fixed"), path };
}

const issue = (source) => omeTiffIssue(source.image, source.spatialUnits, source.tiffMetadata);

for (const attributes of ["", 'PhysicalSizeX="0.25"', 'PhysicalSizeX="0" PhysicalSizeY="0.75"']) {
  test(`TIFF calibration must be known on every spatial axis (${attributes || "absent"})`, async (t) => {
    const { source } = await readFixture(t, { attributes });
    assert.match(issue(source), /known physical pixel sizes/);
    await assert.rejects(writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata }), /known physical pixel sizes/);
  });
}

test("known physical sizes with omitted units use the OME schema's micrometer default", async (t) => {
  const { source, path } = await readFixture(t);
  assert.equal(issue(source), null);
  assert.deepEqual(source.spatialUnits, { y: "micrometer", x: "micrometer" });
  await writeFile(path, await writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata }));
  const output = await readInput(path, "reimported");
  assert.equal(issue(output), null);
  assert.deepEqual(output.image.spacing, [0.25, 0.75]);
  assert.deepEqual(output.image.data, source.image.data);
});

for (const axis of ["X", "Y", "Z"]) {
  test(`TIFF Plane.Position${axis} provenance prevents a misleading zero-origin export`, async (t) => {
    const { source } = await readFixture(t, { planes: `<Plane TheZ="0" TheC="0" TheT="0" Position${axis}="100" Position${axis}Unit="µm"/>` });
    assert.deepEqual(source.image.origin, [0, 0]);
    assert.match(issue(source), /source plane positions/);
    await assert.rejects(writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata }), /source plane positions/);
  });
}

for (const [unit, expected] of [["m", "meter"], ["cm", "centimeter"], ["mm", "millimeter"], ["µm", "micrometer"], ["um", "micrometer"], ["μm", "micrometer"], ["nm", "nanometer"], ["pm", "picometer"], ["Å", "angstrom"]]) {
  test(`TIFF ${unit} units remain exportable after reimport`, async (t) => {
    const { source, path } = await readFixture(t, { attributes: `PhysicalSizeX="0.25" PhysicalSizeY="0.75" PhysicalSizeXUnit="${unit}" PhysicalSizeYUnit="${unit}"` });
    assert.deepEqual(source.spatialUnits, { y: expected, x: expected });
    assert.equal(issue(source), null);
    await writeFile(path, await writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata }));
    const output = await readInput(path, "reimported");
    assert.equal(issue(output), null);
    assert.deepEqual(output.spatialUnits, source.spatialUnits);
    assert.deepEqual(output.image.spacing, source.image.spacing);
    assert.deepEqual(output.image.data, source.image.data);
  });
}
