import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createNiftiFromData } from "@neurodesk/webapp-components/file-io/nifti";
import { correctFiles, loadHmcNode, nodeRuntime } from "../src/node.js";
import { correctNiFreeze } from "../src/nifreeze.js";
import { readSeries } from "../src/pipeline.js";
import { makeSeries, sphereMask, SIZE } from "./synthetic.js";

const CLI = fileURLToPath(new URL("../bin/hmc.js", import.meta.url));

test("CLI rejects invalid options before loading input files", async () => {
  for (const options of [{ method: "shoreline" }, { workers: 0 }, { seed: 0 }, { seed: 2147483648 }]) {
    await assert.rejects(correctFiles({ dwi: "absent", bval: "absent", bvec: "absent", output: "absent", ...options }), /--method|--workers|--seed/);
  }
  const help = execFileSync(process.execPath, [CLI, "--help"], { encoding: "utf8" });
  assert.match(help, /default: gp/);
  assert.match(help, /--workers INTEGER\s+Concurrent registration workers \(default: 2\)/);
  assert.throws(() => execFileSync(process.execPath, [CLI, "--unknown"], { stdio: "pipe" }));
  const report = JSON.parse(execFileSync(process.execPath, [CLI, "self-check"], { encoding: "utf8" }));
  assert.equal(report.executable, process.execPath);
  assert.equal(report.phantom, "512 identity-resampled voxels unchanged");
});

test("GP and trivial CLI outputs equal an independent low-level Node invocation", { timeout: 240000 }, async () => {
  const work = await mkdtemp(join(tmpdir(), "hmc-cli-test-"));
  try {
    const original = await readSeries(makeSeries().nifti);
    const voxels = SIZE ** 3;
    const data = new Float32Array(voxels * 10);
    const bvals = [0, ...Array(8).fill(1000), 0];
    const bvecs = [Array(10).fill(0), Array(10).fill(0), Array(10).fill(0)];
    for (let v = 0; v < 10; v++) {
      const source = v === 0 || v === 9 ? 0 : [1, 2, 4, 5][(v - 1) % 4];
      data.set(original.data.subarray(source * voxels, (source + 1) * voxels), v * voxels);
      if (v > 0 && v < 9) {
        const z = -0.9 + 1.8 * (v - 1) / 7;
        const r = Math.sqrt(1 - z * z);
        bvecs[0][v] = r * Math.cos(2.399963 * v);
        bvecs[1][v] = r * Math.sin(2.399963 * v);
        bvecs[2][v] = z;
      }
    }
    const nifti = new Uint8Array(createNiftiFromData(data, original.headerBytes, { dims: [SIZE, SIZE, SIZE, 10] }));
    const series = await readSeries(nifti);
    const mask = sphereMask();
    const fileName = "sub-01_ses-01_dwi.nii.gz";
    const dwi = join(work, fileName);
    const bval = join(work, "dwi.bval");
    const bvec = join(work, "dwi.bvec");
    const maskFile = join(work, "mask.nii");
    const sidecarFile = join(work, "metadata.json");
    await writeFile(dwi, nifti);
    await writeFile(bval, `${bvals.join(" ")}\n`);
    await writeFile(bvec, bvecs.map(row => row.join(" ")).join("\n"));
    await writeFile(maskFile, new Uint8Array(createNiftiFromData(Float32Array.from(mask), series.headerBytes, { dims: [SIZE, SIZE, SIZE] })));
    await writeFile(sidecarFile, JSON.stringify({ RepetitionTime: 3 }));
    const hmc = await loadHmcNode();
    for (const method of ["trivial", "gp"]) {
      const output = join(work, method);
      execFileSync(process.execPath, [CLI, dwi, bval, bvec, output, "--mask", maskFile, "--sidecar", sidecarFile, "--method", method], { timeout: 110000, stdio: "pipe" });
      const expected = await correctNiFreeze({
        series: await readSeries(nifti), bvals, bvecs, mask, maskProvenance: { Source: "supplied" }, model: method, seed: 1234,
        fileName, sidecar: { RepetitionTime: 3 }, hmc, runtime: nodeRuntime({ workers: 1 }),
      });
      assert.deepEqual((await readdir(output)).sort(), Object.keys(expected.files).sort());
      for (const [name, bytes] of Object.entries(expected.files)) {
        assert.deepEqual(new Uint8Array(await readFile(join(output, name))), bytes, `${method}: ${name}`);
      }
      await assert.rejects(correctFiles({ dwi, bval, bvec, output, maskFile }), /new or empty/);
    }
    await writeFile(sidecarFile, '[]');
    await assert.rejects(correctFiles({ dwi, bval, bvec, output: join(work, "bad-sidecar"), maskFile, sidecarFile }), /JSON object/);
    await writeFile(bval, "0 1000\n");
    await assert.rejects(correctFiles({ dwi, bval, bvec, output: join(work, "bad"), maskFile }), /bvec row|volumes/);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("the CLI refuses a series no GP fit can hold before it starts MindGrab", async () => {
  const work = await mkdtemp(join(tmpdir(), "hmc-cli-limit-"));
  try {
    // 2 × 2 × 2 voxels and 4,000 DWI volumes: tiny on disk, but the fit's (DWI − 1)² matrices need 1.4 GB.
    const frames = 4001;
    const original = await readSeries(makeSeries().nifti);
    const data = Float32Array.from({ length: 8 * frames }, (_, i) => 100 + i % 7);
    const bvals = Array.from({ length: frames }, (_, i) => i ? 1000 : 0);
    const bvecs = [bvals.map((b, i) => b ? Math.cos(i) : 0), bvals.map((b, i) => b ? Math.sin(i) : 0), bvals.map(() => 0)];
    const options = { dwi: join(work, "dwi.nii"), bval: join(work, "dwi.bval"), bvec: join(work, "dwi.bvec"), output: join(work, "out") };
    await writeFile(options.dwi, new Uint8Array(createNiftiFromData(data, original.headerBytes, { dims: [2, 2, 2, frames] })));
    await writeFile(options.bval, `${bvals.join(" ")}\n`);
    await writeFile(options.bvec, bvecs.map(row => row.join(" ")).join("\n"));
    // A stub that fails loudly replaces MindGrab, so the message shows which check ran first.
    const script = `
      import { mock } from "node:test";
      mock.module("@neurodesk/node-drivers/mindgrab", { namedExports: { loadMindgrabCpu: () => { throw new Error("MindGrab started"); } } });
      const { correctFiles } = await import(${JSON.stringify(new URL("../src/node-files.js", import.meta.url).href)});
      await correctFiles(JSON.parse(process.argv[1])).catch(error => console.log(error.message));
    `;
    const message = execFileSync(process.execPath, ["--experimental-test-module-mocks", "--no-warnings", "--input-type=module", "-e", script, JSON.stringify(options)],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" }).trim();
    assert.match(message, /^GP model too large \(1\.54 of 1\.06 GB\)/);
    await assert.rejects(readdir(options.output), { code: "ENOENT" });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
