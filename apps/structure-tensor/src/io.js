// Reading inputs and writing outputs in the browser. Images become
// { data: Float64Array, dims, spacing, unit, kind, header }; `header` is a NIfTI header for the
// viewer and the NIfTI outputs (the input's own for NIfTI, one built from the TIFF otherwise).
import { createNiftiFromData, createNiftiHeaderFromVolume, createRgb24Nifti, decodeNiftiBuffer, parseNiftiVolume } from "@neurodesk/webapp-components/file-io";
import { gzipFile } from "@neurodesk/webapp-components/file-io/bids-derivatives";
import { readTiff, writeTiff } from "./tiff.js";
import { inputKind, outputPlan, summary } from "./config.js";
import { distributionCsv } from "./tensor.js";

/**
 * A NIfTI header for a TIFF-ordered grid: row 0 is the top of the image, so world y runs
 * downwards with the row index and NiiVue shows the image the right way up.
 */
function rasterHeader(dims, spacing) {
  const [dx, dy, dz] = spacing;
  return createNiftiHeaderFromVolume({
    hdr: {
      dims: [3, ...dims, 1, 1, 1, 1],
      pixDims: [1, dx, dy, dz, 1, 1, 1, 1],
      affine: [[dx, 0, 0, 0], [0, -dy, 0, (dims[1] - 1) * dy], [0, 0, dz, 0], [0, 0, 0, 1]],
    },
  });
}

async function readRaster(file) {
  const bitmap = await createImageBitmap(file);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext("2d");
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const { data: rgba } = context.getImageData(0, 0, canvas.width, canvas.height);
  const data = new Float64Array(canvas.width * canvas.height);
  for (let i = 0; i < data.length; i++) data[i] = (rgba[4 * i] + rgba[4 * i + 1] + rgba[4 * i + 2]) / 3;
  return { data, dims: [canvas.width, canvas.height, 1], spacing: [1, 1, 1], unit: "pixel" };
}

/**
 * Reads the chosen files: one image, or several 2D slices of the same size stacked in name order
 * (ImageJ's image sequence) with cubic voxels of the first slice's pixel size.
 * Returns { name, image }; throws a message for the status bar when they are not usable.
 */
export async function readImages(files) {
  if (files.length === 1) return { name: files[0].name, image: await readImage(files[0]) };
  const sorted = [...files].sort((a, b) => a.name.localeCompare(b.name, "en", { numeric: true }));
  const slices = [];
  for (const file of sorted) {
    const slice = await readImage(file);
    if (slice.kind === "nifti" || slice.dims[2] !== 1) throw new Error("Choose one image, or several 2D TIFF, PNG or JPEG slices of one stack.");
    if (slices.length && (slice.dims[0] !== slices[0].dims[0] || slice.dims[1] !== slices[0].dims[1])) {
      throw new Error(`${file.name} is ${slice.dims[0]} × ${slice.dims[1]}; every slice must match ${sorted[0].name}.`);
    }
    slices.push(slice);
  }
  const [nx, ny] = slices[0].dims;
  const data = new Float64Array(nx * ny * slices.length);
  slices.forEach((slice, z) => data.set(slice.data, z * nx * ny));
  const dims = [nx, ny, slices.length];
  const spacing = [slices[0].spacing[0], slices[0].spacing[1], slices[0].spacing[0]];
  const image = { data, dims, spacing, unit: slices[0].unit, kind: "tiff" };
  return { name: sorted[0].name, image: { ...image, header: rasterHeader(dims, spacing) } };
}

/** Reads one image file; throws a message for the status bar when it is not a usable image. */
export async function readImage(file) {
  const kind = inputKind(file.name);
  if (!kind) throw new Error(`${file.name} is not a TIFF, NIfTI, PNG or JPEG image.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  if (kind === "nifti") {
    const volume = parseNiftiVolume(await decodeNiftiBuffer(await file.arrayBuffer()), { OutputCtor: Float64Array });
    return { data: volume.imageData, dims: volume.dims, spacing: volume.voxelSize, unit: "mm", kind, header: volume.headerBytes };
  }
  let image;
  try {
    image = kind === "tiff" ? await readTiff(await file.arrayBuffer()) : await readRaster(file);
  } catch (error) {
    throw new Error(`${file.name} could not be read: ${error.message}`);
  }
  return { ...image, kind, header: rasterHeader(image.dims, image.spacing) };
}

/** A NIfTI file of float32 voxels on the image's grid, for the viewer. */
export function niftiFile(values, image, name, dims = image.dims) {
  return new File([createNiftiFromData(Float32Array.from(values), image.header, { dims, range: "auto", clampCalMax: false })], name);
}

/** An RGB24 NIfTI file on the image's grid, for the viewer. */
export function rgbNiftiFile(rgb, image, name) {
  return new File([createRgb24Nifti(rgb, image.header, image.dims)], name);
}

async function pngFile(rgb, [nx, ny], name) {
  const canvas = new OffscreenCanvas(nx, ny);
  const context = canvas.getContext("2d");
  const pixels = context.createImageData(nx, ny);
  for (let i = 0; i < nx * ny; i++) {
    pixels.data.set(rgb.subarray(3 * i, 3 * i + 3), 4 * i);
    pixels.data[4 * i + 3] = 255;
  }
  context.putImageData(pixels, 0, 0);
  return new File([await canvas.convertToBlob({ type: "image/png" })], name, { type: "image/png" });
}

/**
 * The downloads and viewer images of one result. Maps are TIFF for TIFF, PNG and JPEG input
 * and gzipped NIfTI for NIfTI input; the viewer always gets NIfTI.
 */
export async function buildOutputs({ name, image, settings, result, signal }) {
  const mapFormat = image.kind === "nifti" ? "nifti" : "tiff";
  const plan = outputPlan(name, result.dimensions, mapFormat);
  const outputs = {};
  const add = (key, file, view = null) => {
    const [, description] = plan[key];
    outputs[key] = { description, file, view, viewable: Boolean(view) };
  };
  const writeMap = async (key, values) => {
    const [fileName] = plan[key];
    const view = niftiFile(values, image, fileName.replace(/\.(tif|nii\.gz)$/, ".nii"));
    const file = mapFormat === "nifti"
      ? await gzipFile(await view.arrayBuffer(), fileName, signal)
      : new File([writeTiff({ data: values, dims: image.dims, spacing: image.spacing, unit: image.unit })], fileName, { type: "image/tiff" });
    add(key, file, { file: view, ...displayOf(key) });
  };
  for (const key of result.dimensions === 2 ? ["orientation", "coherency", "energy"] : ["azimuth", "elevation", "coherency", "energy"]) {
    await writeMap(key, result.maps[key]);
  }
  if (result.dimensions === 2) {
    const colourView = rgbNiftiFile(result.colour, image, plan.colour[0].replace(/\.png$/, ".nii"));
    add("colour", await pngFile(result.colour, image.dims, plan.colour[0]), { file: colourView, rgb: true });
  } else {
    const [colourName] = plan.colour;
    const colourView = rgbNiftiFile(result.colour, image, colourName.replace(/\.(tif|nii\.gz)$/, ".nii"));
    const colourFile = mapFormat === "nifti"
      ? await gzipFile(await colourView.arrayBuffer(), colourName, signal)
      : new File([writeTiff({ data: result.colour, dims: image.dims, spacing: image.spacing, unit: image.unit, rgb: true })], colourName, { type: "image/tiff" });
    add("colour", colourFile, { file: colourView, rgb: true });
    const vectors = niftiFile(frameMajor(result.maps.vectors), image, "vectors.nii", [...image.dims, 3]);
    add("vectors", await gzipFile(await vectors.arrayBuffer(), plan.vectors[0], signal));
  }
  add("distribution", new File([distributionCsv(result.distributions)], plan.distribution[0], { type: "text/csv" }));
  const report = summary({ input: name, dims: image.dims, spacing: image.spacing, unit: image.unit, settings, dominant: result.dominant, distributions: result.distributions });
  add("summary", new File([`${JSON.stringify(report, null, 2)}\n`], plan.summary[0], { type: "application/json" }));
  return { outputs, report };
}

/** Interleaved x, y, z per voxel to three frames, the NIfTI vector layout. */
function frameMajor(vectors) {
  const n = vectors.length / 3;
  const frames = new Float32Array(vectors.length);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) frames[k * n + i] = vectors[3 * i + k];
  return frames;
}

/** How the viewer shows each map: a circular hue for angles, a sequential map for magnitudes. */
function displayOf(key) {
  if (key === "orientation" || key === "azimuth") return { colormap: "hsv", range: [-90, 90] };
  if (key === "elevation") return { colormap: "hsv", range: [-90, 90] };
  if (key === "coherency") return { colormap: "viridis", range: [0, 1] };
  return { colormap: "inferno" };
}
