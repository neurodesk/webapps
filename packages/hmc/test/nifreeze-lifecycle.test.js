import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { IDENTITY, loadHmc } from "../src/wasm.js";

// Change only the memory declaration: the production model code runs unchanged,
// with the full-data arena/heap ratio reproduced using a much smaller input.
function withHeapLimit(source, pages) {
  const bytes = Uint8Array.from(source);
  let offset = 8;
  const unsigned = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[offset++];
      result |= (byte & 127) << shift;
      shift += 7;
    } while (byte & 128);
    return result >>> 0;
  };
  while (offset < bytes.length) {
    const section = bytes[offset++];
    const length = unsigned();
    const end = offset + length;
    if (section === 5) {
      assert.equal(unsigned(), 1, "one defined memory");
      assert.equal(unsigned(), 1, "memory has a maximum");
      assert.ok(unsigned() <= pages, "initial memory fits the test limit");
      const start = offset;
      unsigned();
      // Padded unsigned LEB128 is valid and preserves the section length.
      for (let index = start; index < offset; index++) {
        bytes[index] = (pages & 127) | (index < offset - 1 ? 128 : 0);
        pages >>>= 7;
      }
      assert.equal(pages, 0);
      assert.ok(WebAssembly.validate(bytes));
      return bytes;
    }
    offset = end;
  }
  throw new Error("The model has no defined memory");
}

function series() {
  const dims = [32, 32, 32];
  const voxels = 32768;
  const frames = 101;
  const data = new Float32Array(voxels * frames);
  const bvals = Array(11).fill(0);
  const bvecs = [Array(11).fill(0), Array(11).fill(0), Array(11).fill(0)];
  for (let frame = 0; frame < frames; frame++) {
    let x = 0;
    if (frame >= 11) {
      const index = frame - 11;
      const z = -0.95 + 1.9 * index / 89;
      const radius = Math.sqrt(1 - z * z);
      x = radius * Math.cos(2.399963 * index);
      bvals.push(index < 45 ? 1000 : 3000);
      bvecs[0].push(x);
      bvecs[1].push(radius * Math.sin(2.399963 * index));
      bvecs[2].push(z);
    }
    for (let voxel = 0; voxel < voxels; voxel++) {
      data[frame * voxels + voxel] = frame < 11
        ? 1000 + voxel % 13
        : Math.round((600 + voxel % 13) * Math.exp(-0.7 * x * x));
    }
  }
  const mask = new Uint8Array(voxels);
  mask.fill(1, 0, Math.floor(voxels * 0.15));
  return { data, dims, frames, bvals, bvecs, mask, model: "gp" };
}

test("released GP models and serialized results leave room for the next series", async () => {
  const bytes = await readFile(new URL("../src/hmc.wasm", import.meta.url));
  const hmc = await loadHmc(withHeapLimit(bytes, 512)); // 32 MiB, not the production 1 GiB.
  const input = series();
  const transforms = Array(input.frames).fill(IDENTITY);
  const affine = [[2, 0, 0, 0], [0, 2, 0, 0], [0, 0, 2, 0], [0, 0, 0, 1]];
  const grid = { shape: input.dims, affine };
  for (let run = 0; run < 3; run++) {
    hmc.nifreezeArguments(1234);
    const model = hmc.createNifreezeModel(input);
    const prediction = model.predict(0).volume;
    const mat = hmc.writeMat(IDENTITY);
    hmc.motionParams(transforms, grid);
    const gradients = hmc.rotateGradients("nifreeze", input.bvals, input.bvecs, transforms, affine);
    const motion = hmc.motionTsv(transforms, grid);
    model.release();
    assert.equal(createHash("sha256").update(new Uint8Array(prediction.buffer)).digest("hex"), "5a2be5938ac11c64288b3b670e11d93e2251c8c546de9c2fc53108833e8a1488");
    assert.deepEqual(hmc.readMat(mat).parameters, IDENTITY.parameters);
    assert.equal(gradients.bval.trim().split(/\s+/).length, input.frames);
    assert.equal(motion.trim().split("\n").length, input.frames + 1);
  }
});
