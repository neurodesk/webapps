// Writes the synthetic 3D example: a 64 x 64 x 32 float32 TIFF stack, 1 µm voxels, of two
// fibre lattices with known directions. In the left half (x < 32) fibres run at azimuth 30°,
// elevation 0°; in the right half at azimuth -45°, elevation 40°. Angles follow the app:
// azimuth counterclockwise from +x with rows pointing down, elevation towards +z.
//
//   node scripts/make-synthetic-example.mjs <output.tif>
import { writeFile } from "node:fs/promises";
import { writeTiff } from "../src/io.js";
import { cylinders3d } from "../test/synthetic.mjs";

export const DOMAINS = [
  { azimuth: 30, elevation: 0, xs: [0, 32] },
  { azimuth: -45, elevation: 40, xs: [32, 64] },
];

export function syntheticExample() {
  const dims = [64, 64, 32];
  const data = new Float32Array(dims[0] * dims[1] * dims[2]);
  for (const { azimuth, elevation, xs } of DOMAINS) {
    const lattice = cylinders3d({ size: dims, azimuth, elevation, period: 8 });
    for (let z = 0; z < dims[2]; z++) {
      for (let y = 0; y < dims[1]; y++) {
        for (let x = xs[0]; x < xs[1]; x++) {
          const i = x + dims[0] * (y + dims[1] * z);
          data[i] = lattice.data[i];
        }
      }
    }
  }
  return { data, dims, spacing: [1, 1, 1], unit: "micron" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await writeFile(process.argv[2], Buffer.from(writeTiff(syntheticExample())));
}
