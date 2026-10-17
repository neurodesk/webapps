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
