import assert from "node:assert/strict";
import test from "node:test";
import { loadHmcRegistration } from "../src/node.js";

// A float64 NIfTI-1 volume on the 1.2 mm SyN-SDC grid of #462 (193 x 193 x 115, as sdcflows writes
// the anat reference), holding a smooth deterministic pattern.
function float64Volume([nx, ny, nz]) {
  const voxels = nx * ny * nz;
  const bytes = new Uint8Array(352 + voxels * 8);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  [3, nx, ny, nz, 1, 1, 1, 1].forEach((value, i) => view.setInt16(40 + 2 * i, value, true));
  view.setInt16(70, 64, true); // DT_FLOAT64
  view.setInt16(72, 64, true);
  [1, 1.2, 1.2, 1.2, 1, 0, 0, 0].forEach((value, i) => view.setFloat32(76 + 4 * i, value, true));
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  bytes[123] = 2; // millimetres
  bytes.set([0x6e, 0x2b, 0x31, 0], 344); // "n+1"
  for (let z = 0, offset = 352; z < nz; z++) for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++, offset += 8) {
    view.setFloat64(offset, 1000 * Math.sin(x / 9) * Math.cos(y / 7) * Math.sin(z / 5), true);
  }
  return bytes;
}

test("a Laplacian on the 1.2 mm SDC grid runs inside the kernel's initial 256 MiB (#462)", async () => {
  // With the toolchain's mimalloc, this call grew the heap past 256 MiB: mimalloc reserves arenas
  // through emmalloc and never returns them, which took 1.2 mm SyN to the 4 GiB maximum.
  const ants = await loadHmcRegistration();
  const { outputs } = ants.run(["ImageMath", "3", "laplacian.nii", "Laplacian", "image.nii", "1.5", "1"], { "image.nii": float64Volume([193, 193, 115]) });
  assert.ok(outputs["laplacian.nii"].length > 193 * 193 * 115 * 4);
  assert.equal(ants.memoryBytes(), 256 * 2 ** 20);
});
