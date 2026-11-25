// Records packages/syncro/src/pipeline.js's de-shearing (commit 55199029d, before the Rust port replaced it)
// as exes/syncro/core/tests/fixtures/deshear.json. Run from the repository root at that commit.
import { writeFileSync } from 'node:fs';
import { orthogonalGrid, resampleOnto } from '../../../packages/syncro/src/pipeline.js';

// Deterministic pseudo-random values (xorshift32), so the fixture does not hinge on a linear field.
function values(n, seed) {
  let s = seed;
  return Float32Array.from({ length: n }, () => {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    return (s % 20000) / 10 - 1000;
  });
}
const cases = [
  { name: 'orthonormal', dims: [5, 5, 5], affine: [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0]] },
  { name: 'gantry-tilt', dims: [6, 8, 5], affine: [[-1, 0, 0, 5], [0, 1, 0, 0], [0, 0.15, 1, 0]] },
  { name: 'oblique-tolerance', dims: [5, 5, 5], affine: [[0.57735026, 0.57735026, 0.57735026, 0], [0.70704317, -0.70704317, 0, 0], [0.40821156, 0.40821156, -0.81642312, 0]] },
  { name: 'permuted-shear', dims: [7, 6, 5], affine: [[0, 0, -1.2, 10], [0.9, 0.1, 0, -5], [0, 1.1, 0.2, 3]] },
  { name: 'left-handed-shear', dims: [6, 5, 4], affine: [[1.5, 0, 0, -4], [0, 0.8, 0.3, 2], [0, -0.1, 2, 1]] },
  { name: 'oversized', dims: [512, 512, 256], affine: [[0.5, 0, 4, 0], [0, 0.5, 0, 0], [0, 0, 8, 0]] },
];
const out = cases.map(({ name, dims, affine }, index) => {
  const full = [...affine, [0, 0, 0, 1]];
  let grid;
  try {
    grid = orthogonalGrid({ dims, affine: full });
  } catch (error) {
    return { name, dims, affine, error: error.message };
  }
  if (!grid) return { name, dims, affine, grid: null };
  const data = values(dims[0] * dims[1] * dims[2], 2463534242 + index);
  const fill = Math.min(...data);
  const mask = Uint8Array.from(data, (value) => Number(value > 600));
  const linear = resampleOnto({ data, dims, affine: full }, grid, fill);
  const nearest = resampleOnto({ data: mask, dims, affine: full }, grid, 0, { nearest: true });
  return { name, dims, affine, data: [...data], mask: [...mask], fill,
    grid: { dims: grid.dims, affine: grid.affine.slice(0, 3) }, linear: [...linear.data], nearest: [...nearest.data] };
});
writeFileSync(new URL('../core/tests/fixtures/deshear.json', import.meta.url), JSON.stringify({ source: 'packages/syncro/src/pipeline.js at 55199029d', cases: out }) + '\n');
