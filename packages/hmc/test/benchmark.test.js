import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { createNiftiFromData, createNiftiHeaderFromVolume, readNiftiFrames } from "@neurodesk/webapp-components/file-io/nifti";
import { benchmarkSourceHashes } from "../validation/benchmark-sources.mjs";
import { prepareBenchmark } from "../validation/benchmark-task.js";
import { loadHmcNode, gzip } from "../src/node.js";
import { IDENTITY, readSeries } from "../src/pipeline.js";
import { makeSeries, SIZE, VOLUMES } from "./synthetic.js";

test("benchmark receipts cover worker adapters, generated kernels, shared IO and added runtime files", async () => {
  const actual = await benchmarkSourceHashes();
  for (const path of ["packages/hmc/src/pool.js", "packages/hmc/src/node-worker.js", "packages/hmc/src/browser.js",
    "packages/hmc-registration/src/worker.js", "packages/hmc-registration/wasm/hmc-registration.mjs",
    "packages/components/src/file-io/NiftiUtils.js", "packages/components/src/automation/files.js", "packages/hmc/validation/benchmark-matrix.mjs", "packages/hmc/validation/benchmark-memory.mjs"]) assert.ok(actual[path], path);
  const root = await mkdtemp(join(tmpdir(), "hmc-source-hashes-"));
  try {
    for (const path of Object.keys(actual)) {
      await mkdir(dirname(join(root, path)), { recursive: true });
      await writeFile(join(root, path), "initial");
    }
    const before = await benchmarkSourceHashes(root);
    await writeFile(join(root, "packages/hmc/src/node-worker.js"), "changed adapter");
    const changed = await benchmarkSourceHashes(root);
    assert.notDeepEqual(changed, before);
    await writeFile(join(root, "packages/hmc/src/new-runtime.js"), "new runtime");
    const added = await benchmarkSourceHashes(root);
    assert.ok(added["packages/hmc/src/new-runtime.js"]);
    assert.notDeepEqual(added, changed);
  } finally { await rm(root, { recursive: true, force: true }); }
});

async function injectedBenchmark({ image = bytes => bytes, hmcOptions = hmc => hmc } = {}) {
  const source = makeSeries();
  const series = await readSeries(source.nifti);
  const encoder = new TextEncoder();
  const files = {
    image: source.nifti,
    mask: createNiftiFromData(new Uint8Array(SIZE ** 3).fill(1), series.headerBytes, { dims: [SIZE, SIZE, SIZE] }),
    bval: encoder.encode(VOLUMES.map(volume => volume.bval).join(" ")),
    bvec: encoder.encode([0, 1, 2].map(axis => VOLUMES.map(volume => volume.bvec[axis]).join(" ")).join("\n")),
  };
  const hmc = hmcOptions(await loadHmcNode());
  const runtime = {
    workers: 1,
    gzip: bytes => gzip(image(bytes)),
    spawn: () => ({
      onmessage: null, terminate() {},
      postMessage(message) {
        const outputs = message.argv[0] === "--apply"
          ? { "resampled.nii": message.inputs["volume.nii"] }
          : { "out0GenericAffine.mat": hmc.writeMat(IDENTITY) };
        queueMicrotask(() => this.onmessage?.({ data: { id: message.id, outputs } }));
      },
    }),
  };
  return prepareBenchmark({ files: Object.fromEntries(Object.keys(files).map(key => [key, key])), model: "trivial", seed: 1234, fileName: "benchmark_dwi.nii.gz" }, {
    readBytes: async path => files[path], loadHmc: async () => hmc, runtime,
  });
}

function replaceFirstDwi(bytes, value) {
  const volume = readNiftiFrames(bytes);
  volume.data.fill(value, SIZE ** 3, 2 * SIZE ** 3);
  return new Uint8Array(createNiftiFromData(volume.data, bytes, { dims: [...volume.dims, volume.frames] }));
}

for (const [value, pattern] of [[NaN, /nonfinite value at voxel 32768/], [0, /DWI frame 1 contains no signal/]]) {
  test(`benchmark verification rejects ${value} corrected DWI before hashing`, async () => {
    const task = await injectedBenchmark({ image: bytes => replaceFirstDwi(bytes, value) });
    await task.run();
    await assert.rejects(task.verify(), pattern);
  });
}

for (const table of ["bval", "bvec"]) {
  test(`benchmark verification rejects nonfinite ${table} values`, async () => {
    const task = await injectedBenchmark({ hmcOptions: hmc => ({
      ...hmc,
      rotateGradients(...args) {
        const gradients = hmc.rotateGradients(...args);
        return { ...gradients, [table]: gradients[table].replace(/\S+/, "NaN") };
      },
    }) });
    await task.run();
    await assert.rejects(task.verify(), /gradient tables contain invalid numeric values/);
  });
}

test('benchmark verification rejects nonfinite motion values', async () => {
  const task = await injectedBenchmark({ hmcOptions: hmc => ({
    ...hmc,
    motionTsv(...args) {
      const rows = hmc.motionTsv(...args).trim().split('\n');
      rows[1] = rows[1].replace(/\S+/, 'NaN');
      return `${rows.join('\n')}\n`;
    },
  }) });
  await task.run();
  await assert.rejects(task.verify(), /motion table contains invalid numeric values/);
});

test('finite completed benchmark outputs pass all artifact checks', async () => {
  const task = await injectedBenchmark();
  await task.run();
  const result = await task.verify();
  assert.equal(result.verified, true);
  assert.equal(result.frames, VOLUMES.length);
  assert.equal(Object.keys(result.hashes).length, VOLUMES.length + 5);
});

test('benchmark verification preserves original b0 evidence when the pipeline mutates its input', async () => {
  let mutated = false;
  const task = await injectedBenchmark({ hmcOptions: hmc => ({
    ...hmc,
    createNifreezeModel(options) {
      options.data[0] += 1;
      mutated = true;
      return hmc.createNifreezeModel(options);
    },
  }) });
  await task.run();
  assert.equal(mutated, true);
  await assert.rejects(task.verify(), /changed b0 frame 0/);
});


test('benchmark verification rejects a corrected series on a shifted grid', async () => {
  const task = await injectedBenchmark({ image(bytes) {
    const volume = readNiftiFrames(bytes);
    const affine = volume.header.affine.map(row => Array.from(row));
    affine[0][3] += 1;
    const header = createNiftiHeaderFromVolume({ hdr: { affine, pixDims: volume.header.pixDims } });
    return new Uint8Array(createNiftiFromData(volume.data, header, { dims: [...volume.dims, volume.frames] }));
  } });
  await task.run();
  await assert.rejects(task.verify(), /not on the input grid/);
});
