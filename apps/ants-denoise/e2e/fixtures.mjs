// Test images for the browser tests and the native reference recorder: the pinned example, a
// mask of its nonzero voxels, a small noisy phantom with a mask on its grid, and a 4D series.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync, gzipSync } from "node:zlib";
import { syntheticNifti } from "../../../test-utils/nifti-fixture.mjs";

const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
export const example = examples[0];
export const exampleFile = example.files.find((file) => file.role === "image");

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const inflate = (bytes) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes));

/** The example image, downloaded and checked against its pinned SHA-256. */
export async function exampleBytes() {
  const response = await fetch(exampleFile.url);
  if (!response.ok) throw new Error(`${exampleFile.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== exampleFile.sha256) throw new Error(`${exampleFile.name}: SHA-256 does not match examples.json`);
  return bytes;
}

/**
 * A uint8 NIfTI of the nonzero voxels of a float32 NIfTI, on its grid (its header with the
 * datatype changed). The example's background outside the head is zero, so this is a head mask.
 */
export function nonzeroMask(niftiBytes) {
  const image = inflate(niftiBytes);
  const offset = image.readFloatLE(108);
  if (image.readInt16LE(70) !== 16) throw new Error("nonzeroMask expects float32 voxels");
  const voxels = (image.length - offset) / 4;
  const mask = Buffer.alloc(offset + voxels);
  image.copy(mask, 0, 0, offset);
  mask.writeInt16LE(2, 70);
  mask.writeInt16LE(8, 72);
  mask.writeFloatLE(1, 112);
  mask.writeFloatLE(0, 116);
  mask.writeFloatLE(1, 124);
  mask.writeFloatLE(0, 128);
  for (let i = 0; i < voxels; i++) mask[offset + i] = image.readFloatLE(offset + 4 * i) === 0 ? 0 : 1;
  return gzipSync(mask);
}

// A bright sphere on a dark background with seeded uniform noise, N^3 voxels of 1 mm.
export function phantom(n = 24) {
  let state = 12345;
  const c = (n - 1) / 2;
  return syntheticNifti({
    dims: [n, n, n],
    spacing: [1, 1, 1],
    gzip: false,
    value: (i) => {
      state = (Math.imul(state, 1103515245) + 12345) >>> 0;
      const x = i % n;
      const y = Math.floor(i / n) % n;
      const z = Math.floor(i / (n * n));
      const inside = (x - c) ** 2 + (y - c) ** 2 + (z - c) ** 2 < (n / 3) ** 2;
      return (inside ? 100 : 20) + 20 * (state / 2 ** 32 - 0.5);
    },
  });
}

/** The lower half (z < n / 2) of the phantom's grid, as a gzipped float32 mask. */
export function halfMask(n = 24) {
  return syntheticNifti({ dims: [n, n, n], spacing: [1, 1, 1], value: (i) => (Math.floor(i / (n * n)) < n / 2 ? 1 : 0) });
}

/** A gzipped 4D series: three volumes of a small grid. */
export function series4d() {
  const volume = syntheticNifti({ dims: [8, 8, 8], spacing: [2, 2, 2], gzip: false, value: (i) => i % 17 });
  const header = Buffer.from(volume.subarray(0, 352));
  header.writeInt16LE(4, 40);
  header.writeInt16LE(3, 48);
  const data = volume.subarray(352);
  return gzipSync(Buffer.concat([header, data, data, data]));
}
