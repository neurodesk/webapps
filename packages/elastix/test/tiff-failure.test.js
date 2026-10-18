import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readImageNode } from "@itk-wasm/image-io";
import { tiffFixture } from "./tiff-fixture.js";

const bin = fileURLToPath(new URL("../bin/elastix-register.js", import.meta.url));
const mandatory = ["input_registered.nii.gz", "input_transform.h5", "input_transform.ome.zarr.ozx", "input_TransformParameters.0.toml", "input_TransformParameters.1.toml"].sort();

for (const failure of ["encoder", "partial-write", "abort", "mandatory"]) {
  test(`CLI ${failure} failure preserves the appropriate outputs`, async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "elastix-tiff-failure-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const input = join(directory, "input.ome.tif");
    const output = join(directory, "results");
    const preload = join(directory, "inject.mjs");
    await writeFile(input, await tiffFixture());
    await writeFile(preload, `
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const failure = ${JSON.stringify(failure)};
if (failure === 'encoder' || failure === 'abort') {
  globalThis.CompressionStream = class {
    constructor() { throw failure === 'abort' ? new DOMException('Injected TIFF cancellation', 'AbortError') : new Error('Injected TIFF encoder failure'); }
  };
}
if (failure === 'partial-write') {
  const writeFile = fs.writeFile;
  fs.writeFile = async (...args) => {
    if (String(args[0]).endsWith('_registered.ome.tif')) {
      await writeFile(args[0], args[1].subarray(0, 64), args[2]);
      throw new Error('Injected TIFF partial write failure');
    }
    return writeFile(...args);
  };
  const open = fs.open;
  fs.open = async (...args) => {
    const handle = await open(...args);
    if (String(args[0]).endsWith('_registered.ome.tif')) {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (bytes) => {
        await write(bytes.subarray(0, 64));
        throw new Error('Injected TIFF partial write failure');
      };
    }
    return handle;
  };
}
if (failure === 'mandatory') {
  const write = fs.writeFile;
  fs.writeFile = async (...args) => {
    if (String(args[0]).endsWith('_transform.ome.zarr.ozx')) throw new Error('Injected mandatory output failure');
    return write(...args);
  };
}
syncBuiltinESMExports();
`);
    const result = spawnSync(process.execPath, ["--import", preload, bin, input, input, output, "--method", "rigid", "--resolutions", "1"], { encoding: "utf8" });
    if (failure === "abort" || failure === "mandatory") {
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, failure === "abort" ? /Injected TIFF cancellation/ : /Injected mandatory output failure/);
      assert.deepEqual(await readdir(output), []);
      return;
    }
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stderr, /No input_registered\.ome\.tif: Injected TIFF/);
    assert.deepEqual((await readdir(output)).sort(), mandatory);
    assert.deepEqual(result.stdout.trim().split("\n").sort(), mandatory.map((name) => join(output, name)).sort());
    const image = await readImageNode(join(output, "input_registered.nii.gz"));
    assert.deepEqual(image.size.slice(0, 2), [20, 20]);
    assert.ok(image.data.some((value) => value > 100));
    assert.equal((await readFile(join(output, "input_transform.h5"))).subarray(0, 8).toString("latin1"), "\x89HDF\r\n\x1a\n");
    assert.match(await readFile(join(output, "input_TransformParameters.1.toml"), "utf8"), /InitialTransformParameterFileName = "input_TransformParameters.0.toml"/);
  });
}
