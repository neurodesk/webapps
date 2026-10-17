import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fromArrayBuffer } from "geotiff";
import { DOMParser } from "@xmldom/xmldom";
import { readInput } from "../src/node.js";
import { writeOmeTiff } from "../src/ome-tiff.js";
import { omeTiffIssue } from "../src/outputs.js";
import { calibrationCases, omeTiffFixture } from "../../../test-utils/ome-tiff-fixtures.mjs";

for (const fixture of calibrationCases) {
  test(`original XML calibration and selected pixels: ${fixture.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "elastix-original-xml-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, `${fixture.name}.ome.tif`);
    await writeFile(path, omeTiffFixture(fixture));
    const source = await readInput(path, "fixed");
    assert.deepEqual(source.image.size, [20, 20]);
    assert.deepEqual(source.image.spacing, fixture.spacing ?? (fixture.images?.[0].size ? [51.225, 153.675] : [0.25, 0.75]));
    if (fixture.name.startsWith("other-image") || fixture.name.startsWith("selected-second")) {
      assert.equal(source.tiffMetadata.imageId, "Image:1");
      assert.deepEqual(source.tiffMetadata.ifds, [1]);
      assert.equal(source.tiffMetadata.subIfdLevel, 0);
      assert.match(source.note, /OME Image 2 of 2/);
    }
    if (fixture.subIfd) {
      assert.equal(source.tiffMetadata.imageId, "Image:0");
      assert.deepEqual(source.tiffMetadata.ifds, [0]);
      assert.equal(source.tiffMetadata.subIfdLevel, 1);
    }
    const issue = omeTiffIssue(source.image, source.spatialUnits, source.tiffMetadata);
    if (fixture.issue) {
      assert.match(issue ?? "", fixture.issue);
      await assert.rejects(writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata }), fixture.issue);
      return;
    }
    assert.equal(issue, null);
    const bytes = await writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata });
    const output = await (await fromArrayBuffer(bytes.buffer)).getImage();
    const xml = new DOMParser().parseFromString(await output.fileDirectory.loadValue("ImageDescription"), "application/xml");
    const pixels = xml.getElementsByTagNameNS("http://www.openmicroscopy.org/Schemas/OME/2016-06", "Pixels")[0];
    for (const [axis, index] of [["X", 0], ["Y", 1]]) {
      assert.equal(pixels.getAttribute(`PhysicalSize${axis}Unit`), fixture.unit);
      assert.equal(Number(pixels.getAttribute(`PhysicalSize${axis}`)), (fixture.spacing ?? [0.25, 0.75])[index]);
    }
    const [decoded] = await output.readRasters();
    assert.deepEqual(decoded, source.image.data);
  });
}

for (const value of ["0.25junk", "1e-3junk", "NaN", "Infinity", "0", "-0.25"]) {
  test(`whole positive finite calibration required: ${value}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "elastix-invalid-calibration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const path = join(directory, "invalid.ome.tif");
    await writeFile(path, omeTiffFixture({ images: [{ calibration: `PhysicalSizeX="${value}" PhysicalSizeY="0.75"` }] }));
    const source = await readInput(path, "fixed");
    assert.match(omeTiffIssue(source.image, source.spatialUnits, source.tiffMetadata), /known physical pixel sizes/);
  });
}

test("XYZ calibration binds every original plane before exporting all slices", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "elastix-xyz-calibration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "volume.ome.tif");
  await writeFile(path, omeTiffFixture({ volume: true, images: [{ calibration: 'PhysicalSizeX="0.25" PhysicalSizeY="0.75" PhysicalSizeZ="1.5"' }, { value: 17 }] }));
  const source = await readInput(path, "fixed");
  assert.deepEqual(source.image.size, [20, 20, 2]);
  assert.deepEqual(source.image.spacing, [0.25, 0.75, 1.5]);
  assert.deepEqual(source.tiffMetadata.ifds, [0, 1]);
  assert.equal(omeTiffIssue(source.image, source.spatialUnits, source.tiffMetadata), null);
  const bytes = await writeOmeTiff(source.image, source.spatialUnits, { tiffMetadata: source.tiffMetadata });
  const output = await fromArrayBuffer(bytes.buffer);
  assert.equal(await output.getImageCount(), 2);
  for (let z = 0; z < 2; z += 1) {
    const [data] = await (await output.getImage(z)).readRasters();
    assert.deepEqual(data, source.image.data.subarray(z * 400, (z + 1) * 400));
  }
});

test("a SubIFD link without a reduced-resolution declaration cannot authorize scaling", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "elastix-subifd-calibration-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "subifd.ome.tif");
  await writeFile(path, omeTiffFixture({ subIfd: true, reduced: false, images: [{ size: [4098, 4098], value: 0 }, {}] }));
  const source = await readInput(path, "fixed");
  assert.deepEqual(source.image.size, [20, 20]);
  assert.match(omeTiffIssue(source.image, source.spatialUnits, source.tiffMetadata), /cannot verify a reduced-resolution SubIFD/);
});
