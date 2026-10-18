import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeTiff } from "./decode-tiff.js";
import { readVolume } from "../../../test-utils/registration-similarity.mjs";
import { calibrationCases, omeTiffFixture } from "../../../test-utils/ome-tiff-fixtures.mjs";

const bin = fileURLToPath(new URL("../bin/elastix-register.js", import.meta.url));
for (const fixture of calibrationCases) {
  test(`CLI decoded calibration: ${fixture.name}`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "elastix-cli-calibration-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = join(directory, "input.ome.tif");
    const output = join(directory, "output");
    await writeFile(input, omeTiffFixture(fixture));
    const run = spawnSync(process.execPath, [bin, input, input, output, "--method", "rigid", "--resolutions", "1"], { encoding: "utf8" });
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`);
    const files = await readdir(output);
    assert.ok(files.includes("input_transform.h5"));
    assert.ok(files.includes("input_transform.ome.zarr.ozx"));
    assert.ok(files.includes("input_TransformParameters.0.toml"));
    const registered = await readVolume(await readFile(join(output, "input_registered.nii.gz")));
    assert.deepEqual(registered.dims.slice(0, fixture.size?.length ?? 2), fixture.size ?? [20, 20]);
    assert.ok(registered.data.some((value) => value > 900), "the selected Gaussian image, not the unselected zero image");
    if (fixture.issue) {
      assert.match(run.stderr, fixture.issue);
      assert.ok(!files.includes("input_registered.ome.tif"));
      assert.ok(files.includes("input_TransformParameters.1.toml"));
      assert.equal(files.length, 5);
      return;
    }
    const bytes = await readFile(join(output, "input_registered.ome.tif"));
    const decoded = await decodeTiff(bytes);
    assert.deepEqual(decoded.units, [fixture.unit, fixture.unit]);
    assert.deepEqual(decoded.spacing, fixture.spacing ?? [0.25, 0.75]);
    assert.deepEqual(decoded.data, registered.data);
  });
}
