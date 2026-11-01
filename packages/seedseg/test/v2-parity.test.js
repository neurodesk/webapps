import assert from "node:assert/strict";
import test from "node:test";
import { compareV2Outputs } from "../validation/v2-parity.mjs";

const dims = [16, 16, 8];
const voxels = dims[0] * dims[1] * dims[2];
const index = (x, y, z) => x + dims[0] * (y + dims[1] * z);

// A cube of `side` voxels labelled `rank`, centred on (8, 8, 4).
function cube(side, rank = 1, map = new Float32Array(voxels)) {
  const lo = [8, 8, 4].map((c) => c - Math.floor(side / 2));
  for (let z = lo[2]; z < lo[2] + side; z++)
    for (let y = lo[1]; y < lo[1] + side; y++)
      for (let x = lo[0]; x < lo[0] + side; x++) map[index(x, y, z)] = rank;
  return map;
}

test("rounding-sized differences pass", () => {
  const native = {
    markers: cube(4),
    probability: new Float32Array(voxels).fill(0.3),
  };
  const markers = cube(4);
  markers[index(6, 6, 2)] = 0;
  const browser = { markers, probability: new Float32Array(voxels).fill(0.33) };
  const {
    markers: [agreement],
  } = compareV2Outputs({ native, browser, dims });
  assert.equal(agreement.disagreeing, 1);
});

test("a 27-voxel and a 343-voxel marker on one centroid fail, as does a 0.94 probability difference", () => {
  const probability = new Float32Array(voxels);
  const native = { markers: cube(3), probability };
  const browser = { markers: cube(7), probability };
  assert.throws(
    () => compareV2Outputs({ native, browser, dims }),
    /disagreeing voxels/,
  );
  assert.throws(
    () =>
      compareV2Outputs({
        native,
        browser,
        dims,
        limits: {
          maxProbabilityDifference: 1,
          maxProbabilityDifferenceMirrored: 1,
          maxDisagreeingVoxelsPerMarker: Infinity,
          minMarkerDice: 0.9,
          maxCentroidShiftVoxels: 1,
        },
      }),
    /Dice/,
  );
  const shifted = {
    markers: cube(3),
    probability: new Float32Array(voxels).fill(0.94),
  };
  assert.throws(
    () => compareV2Outputs({ native, browser: shifted, dims }),
    /probability difference 0.93\d+ exceeds 0.05/,
  );
  assert.throws(
    () => compareV2Outputs({ native, browser: shifted, dims, mirror: true }),
    /exceeds 0.2/,
  );
});

test("a different number of markers fails", () => {
  const probability = new Float32Array(voxels);
  assert.throws(
    () =>
      compareV2Outputs({
        native: { markers: cube(3), probability },
        browser: { markers: cube(1, 2, cube(3)), probability },
        dims,
      }),
    /marker count/,
  );
});
