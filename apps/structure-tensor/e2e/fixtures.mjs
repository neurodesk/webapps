// Test images for the browser tests: the pinned examples and synthetic images with known angles,
// written as TIFF or NIfTI the way a user would drop them.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { createNiftiFromData, createNiftiHeaderFromVolume } from "@neurodesk/webapp-components/file-io";
import { readTiff, writeTiff } from "../src/io.js";
import { cylinders3d, grating2d } from "../test/synthetic.mjs";

export const examples = JSON.parse(await readFile(new URL("../examples.json", import.meta.url), "utf8"));
export const reference = JSON.parse(await readFile(new URL("../validation/reference.json", import.meta.url), "utf8"));

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
export const inflate = (bytes) => (bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes) : Buffer.from(bytes));

/** An example's image bytes, downloaded and checked against its pinned SHA-256. */
export async function exampleBytes(example) {
  const [file] = example.files;
  const response = await fetch(file.url);
  if (!response.ok) throw new Error(`${file.name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha256(bytes) !== file.sha256) throw new Error(`${file.name}: SHA-256 does not match examples.json`);
  return bytes;
}

const tiffFile = (name, image) => ({ name, mimeType: "image/tiff", buffer: Buffer.from(writeTiff({ ...image, data: Float32Array.from(image.data) })) });

/** A float32 TIFF of a grating whose stripes run at `degrees`. */
export function gratingTiff(degrees, size = 128, name = `grating_${degrees}.tif`) {
  return tiffFile(name, grating2d({ size, degrees }));
}

/** A float32 NIfTI of a cylinder lattice on an anisotropic grid. */
export function cylindersNifti({ azimuth, elevation, spacing = [1, 1, 2], size = [40, 40, 20] }) {
  const image = cylinders3d({ size, spacing, azimuth, elevation });
  const header = createNiftiHeaderFromVolume({ hdr: { dims: [3, ...size, 1, 1, 1, 1], pixDims: [1, ...spacing, 1, 1, 1, 1] } });
  const buffer = Buffer.from(createNiftiFromData(Float32Array.from(image.data), header, { dims: size }));
  return { file: { name: "cylinders.nii", mimeType: "application/octet-stream", buffer }, direction: image.direction };
}

/** Reads a downloaded TIFF map. */
export async function readTiffBytes(bytes) {
  return readTiff(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}

/** Float32 voxels of a downloaded (gzipped) NIfTI and its dims, frames included. */
export function readNiftiFloat32(bytes) {
  const raw = inflate(bytes);
  const offset = raw.readFloatLE(108);
  const dims = Array.from({ length: raw.readInt16LE(40) }, (_, k) => raw.readInt16LE(42 + 2 * k));
  const data = new Float32Array(raw.buffer.slice(raw.byteOffset + offset, raw.byteOffset + raw.length));
  return { dims, data, datatype: raw.readInt16LE(70) };
}

/** Signed difference of two orientations on the 180° circle. */
export function angleDifference(a, b) {
  return ((((a - b) % 180) + 270) % 180) - 90;
}
