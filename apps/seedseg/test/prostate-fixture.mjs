import { createNiftiFromVolume } from '../../../packages/components/src/file-io/NiftiUtils.js';

// Synthetic transport fixture, not a clinical accuracy reference or public app example.
// The three planted fiducials are its geometric ground truth: a signal void of in-plane
// radius 2 voxels and 3 slices around each of these voxel coordinates, inside a bright
// prostate ellipsoid within a uniform body-sized ellipse. The published ensemble marks all
// three here. It returned an empty mask for the earlier 64 x 64 x 32 fixture with
// one-voxel-radius voids, and missed one seed when the body carried a sinusoidal texture.
export const PROSTATE_FIXTURE_DIMS = [128, 128, 32];
export const PROSTATE_FIXTURE_SEEDS = [[52, 60, 16], [76, 60, 16], [64, 74, 16]];
const SEED_RADIUS = 2;
const SEED_HALF_HEIGHT = 1;

function insideSeed(x, y, z, [sx, sy, sz]) {
  return (x - sx) ** 2 + (y - sy) ** 2 <= SEED_RADIUS ** 2 && Math.abs(z - sz) <= SEED_HALF_HEIGHT;
}

// Binary mask of exactly the voxels the fixture darkens for the planted fiducials.
export function createProstateSeedMask() {
  const dims = PROSTATE_FIXTURE_DIMS;
  const mask = new Uint8Array(dims.reduce((a, b) => a * b));
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        if (PROSTATE_FIXTURE_SEEDS.some(seed => insideSeed(x, y, z, seed))) mask[x + dims[0] * (y + dims[1] * z)] = 1;
      }
    }
  }
  return mask;
}

export function createProstateFixture() {
  const dims = PROSTATE_FIXTURE_DIMS;
  const img = new Float32Array(dims.reduce((a, b) => a * b));
  for (let z = 0; z < dims[2]; z++) {
    for (let y = 0; y < dims[1]; y++) {
      for (let x = 0; x < dims[0]; x++) {
        const body = ((x - 64) / 57.6) ** 2 + ((y - 64) / 51.2) ** 2;
        const prostate = ((x - 64) / 22) ** 2 + ((y - 64) / 18) ** 2 + ((z - 16) / 12) ** 2;
        let value = body < 1 ? 70 : 0;
        if (prostate < 1) value = 110;
        if (PROSTATE_FIXTURE_SEEDS.some(seed => insideSeed(x, y, z, seed))) value = 3;
        img[x + dims[0] * (y + dims[1] * z)] = value;
      }
    }
  }
  return Buffer.from(createNiftiFromVolume({ img, hdr: { dims, pixDims: [1, 1, 1], affine: [[1, 0, 0, -64], [0, 1, 0, -64], [0, 0, 1, -16], [0, 0, 0, 1]] } }));
}
