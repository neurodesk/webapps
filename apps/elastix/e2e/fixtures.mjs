// Synthetic 2D microscopy-like pair for the OME-Zarr and TIFF tests: Gaussian
// blobs, and the same blobs shifted by a known number of pixels. Both are
// sampled from the analytic function, so the shift carries no resampling
// error. The OME-Zarr 0.5 store is written by hand (ngff-zarr's writer needs
// Web Workers, which Node lacks); fiff writes the OME-TIFF. Nothing here
// touches the app's code.
import { createAxis, createDataset, createMetadata, createNgffImage, createNgffMultiscales, memoryStoreToZip, toMultiscales } from "@fideus-labs/ngff-zarr";
import { toOmeTiff } from "@fideus-labs/fiff";

export const SIZE = 128;
export const SPACING = 0.5;
// The moving image shows the fixed content moved by this many pixels (x, y),
// so the stationary-to-moving transform translates by SHIFT_PX × SPACING.
export const SHIFT_PX = [5, -3];

const BLOBS = [
  [40, 44, 6, 900],
  [86, 50, 4, 1400],
  [64, 92, 8, 700],
  [30, 96, 3, 1800],
  [96, 98, 5, 1100],
];

function blobs([dx, dy] = [0, 0]) {
  const data = new Uint16Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      let value = 100;
      for (const [cx, cy, sigma, peak] of BLOBS) {
        value += peak * Math.exp(-((x - dx - cx) ** 2 + (y - dy - cy) ** 2) / (2 * sigma ** 2));
      }
      data[y * SIZE + x] = Math.round(value);
    }
  }
  return data;
}

export const fixedPixels = blobs();
export const movingPixels = blobs(SHIFT_PX);

const CHUNK = 64;
const json = (value) => new TextEncoder().encode(JSON.stringify(value));

/** An OME-Zarr 0.5 store (zarr v3, uncompressed 64² chunks) as key → bytes. */
function omeZarrStore(pixels, name) {
  const store = new Map();
  store.set("zarr.json", json({
    zarr_format: 3,
    node_type: "group",
    attributes: {
      ome: {
        version: "0.5",
        multiscales: [{
          name,
          axes: [{ name: "y", type: "space", unit: "micrometer" }, { name: "x", type: "space", unit: "micrometer" }],
          datasets: [{ path: "0", coordinateTransformations: [{ type: "scale", scale: [SPACING, SPACING] }, { type: "translation", translation: [0, 0] }] }],
        }],
      },
    },
  }));
  store.set("0/zarr.json", json({
    zarr_format: 3,
    node_type: "array",
    shape: [SIZE, SIZE],
    data_type: "uint16",
    chunk_grid: { name: "regular", configuration: { chunk_shape: [CHUNK, CHUNK] } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    dimension_names: ["y", "x"],
    attributes: {},
  }));
  for (let cy = 0; cy < SIZE / CHUNK; cy += 1) {
    for (let cx = 0; cx < SIZE / CHUNK; cx += 1) {
      const chunk = new Uint16Array(CHUNK * CHUNK);
      for (let y = 0; y < CHUNK; y += 1) chunk.set(pixels.subarray((cy * CHUNK + y) * SIZE + cx * CHUNK, (cy * CHUNK + y) * SIZE + cx * CHUNK + CHUNK), y * CHUNK);
      store.set(`0/c/${cy}/${cx}`, new Uint8Array(chunk.buffer));
    }
  }
  return store;
}

// createNgffImage cannot fill its array in Node either, so the plane comes from getPlane.
async function omeTiff(pixels, name) {
  const image = await createNgffImage(new ArrayBuffer(pixels.byteLength), [SIZE, SIZE], "uint16", ["y", "x"], { y: SPACING, x: SPACING }, { y: 0, x: 0 }, name);
  const multiscales = await toMultiscales(image, { scaleFactors: [] });
  const getPlane = async () => ({ data: pixels });
  return Buffer.from(await toOmeTiff(multiscales, { compression: "deflate", getPlane }));
}

/** The fixed image as a two-level OME-TIFF pyramid, its half-resolution level in a SubIFD. */
export async function pyramidalTiff() {
  const half = new Uint16Array((SIZE / 2) ** 2).map((_, index) => fixedPixels[Math.floor(index / (SIZE / 2)) * 2 * SIZE + (index % (SIZE / 2)) * 2]);
  const level = (pixels, size, spacing) => createNgffImage(new ArrayBuffer(pixels.byteLength), [size, size], "uint16", ["y", "x"], { y: spacing, x: spacing }, { y: 0, x: 0 }, "fixed");
  const axes = [createAxis("y", "space", "micrometer"), createAxis("x", "space", "micrometer")];
  const datasets = [createDataset("0", [SPACING, SPACING], [0, 0]), createDataset("1", [2 * SPACING, 2 * SPACING], [0, 0])];
  const multiscales = createNgffMultiscales([await level(fixedPixels, SIZE, SPACING), await level(half, SIZE / 2, 2 * SPACING)], createMetadata(axes, datasets, "fixed"));
  const getPlane = async (data) => ({ data: data.shape[0] === SIZE ? fixedPixels : half });
  return Buffer.from(await toOmeTiff(multiscales, { compression: "deflate", getPlane }));
}

/** The pair as OME-Zarr key → bytes maps, .ozx archives of them, and OME-TIFF files. */
export async function syntheticPair() {
  const pair = {};
  for (const [role, pixels] of [["fixed", fixedPixels], ["moving", movingPixels]]) {
    const store = omeZarrStore(pixels, role);
    pair[role] = { store, ozx: Buffer.from(memoryStoreToZip(store)), tiff: await omeTiff(pixels, role) };
  }
  return pair;
}

/** Sum of the translation parts of elastix TransformParameters files (rotation is ~0 for a pure shift). */
export function totalTranslation(parameterTexts) {
  const total = [0, 0];
  for (const text of parameterTexts) {
    const transform = /\(Transform "(\w+)"\)/.exec(text)[1];
    const values = /\(TransformParameters ([^)]*)\)/.exec(text)[1].trim().split(/\s+/).map(Number);
    const translation = transform === "EulerTransform" ? values.slice(1) : values;
    total[0] += translation[0];
    total[1] += translation[1];
  }
  return total;
}
