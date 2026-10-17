// Browser image IO. Every source becomes the scalar float32 ITK-Wasm image
// elastix registers, plus a NIfTI file NiiVue displays:
// - NIfTI, and DICOM converted by dcm2niix, read with @itk-wasm/image-io;
// - other ITK formats read with image-io, written to NIfTI for display;
// - OME-Zarr (.ozx, a dropped .zarr folder, a URL) read with ngff-zarr;
// - TIFF and OME-TIFF (a local file, or a URL read by range request) read with fiff.
// ITK-Wasm IO runs on one shared worker, one call at a time: concurrent
// readImage calls deadlock.
import { createWebWorker } from "itk-wasm";
import { readImage, writeImage } from "@itk-wasm/image-io";
import { writeTransform } from "@itk-wasm/transform-io";
import { readParameterFiles, transformix, writeParameterFiles } from "@itk-wasm/elastix";
import {
  fromOmeZarr,
  itkDisplacementFieldToNgffTransform,
  itkImageToNgffImage,
  itkTransformToNgffTransform,
  ngffImageToItkImage,
  storeToZip,
  toMultiscales,
  toOmeZarr,
  toOmeZarrOzx,
} from "@fideus-labs/ngff-zarr/browser";
import { TiffStore } from "@fideus-labs/fiff";
import FetchStore from "@zarrita/storage/fetch";
import ZipFileStore from "@zarrita/storage/zip";
import { createSourceReader } from "@neurodesk/elastix/source-reader";
import { voxelCount, VOXEL_BUDGET } from "@neurodesk/elastix/sources";
import { outputStem, plainBytes, withTypedParameterArrays } from "@neurodesk/elastix/outputs";
import { writeOmeTiff } from "@neurodesk/elastix/ome-tiff";
import { registrationImage, transformParameterFiles } from "@neurodesk/elastix/pipeline";
import { affineTransform, estimateTransform, namedTransformation, spatialDims } from "@neurodesk/elastix/transform-export";
import { createIoWorkerQueue } from "./io-worker.js";

const io = createIoWorkerQueue(() => createWebWorker(null));

/** Run one ITK-Wasm call on the shared IO worker after the calls before it. */
const onIoWorker = io.run;

/** Abandon in-flight IO: its pipeline promise never settles once the worker is gone. */
export const resetIo = io.reset;

export function abortable(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function describe(image) {
  return `${Array.from(image.size).join("×")} ${image.imageType.componentType}`;
}

function toFile(bytes, name, type = "application/octet-stream") {
  return new File([plainBytes(bytes)], name, { type });
}

/** Write an ITK-Wasm image in the format its file name selects. */
export async function writeImageFile(image, name, { signal } = {}) {
  signal?.throwIfAborted();
  const { serializedImage } = await onIoWorker((webWorker) => writeImage(image, name, { webWorker }), { signal });
  signal?.throwIfAborted();
  return toFile(serializedImage.data, name);
}

// The display copy keeps the source pixel type; elastix gets the float32 copy.
async function prepared(image, name, kind, displayFile, detail = "", signal) {
  signal?.throwIfAborted();
  const { scalar, image: float } = registrationImage(image);
  const display = displayFile ?? await writeImageFile(scalar, `${outputStem(name)}.nii.gz`, { signal });
  signal?.throwIfAborted();
  const large = voxelCount(scalar) > VOXEL_BUDGET ? " · above the voxel budget, registration may be slow" : "";
  return { image: float, displayFile: display, name, kind, note: `${describe(scalar)}${detail}${large}` };
}

/** A NIfTI file (as is, or converted from DICOM by dcm2niix). */
export async function readNiftiFile(file, { signal } = {}) {
  signal?.throwIfAborted();
  const { image } = await onIoWorker((webWorker) => readImage(file, { webWorker }), { signal });
  signal?.throwIfAborted();
  return prepared(image, file.name, "nifti", file, "", signal);
}

export const readSource = createSourceReader({
  fromOmeZarr,
  ngffImageToItkImage,
  TiffStore,
  ZipFileStore,
  FetchStore,
  prepared,
  readNiftiFile,
  readItkFile: (file, signal) => onIoWorker((webWorker) => readImage(file, { webWorker }), { signal }),
});

/** Custom elastix parameter files (.txt or .toml) as a parameter object. */
export async function readCustomParameters(files) {
  const { parameterObject } = await onIoWorker((webWorker) => readParameterFiles({ parameterFiles: files, webWorker }));
  return parameterObject;
}

// One scale and nothing downsampled, so drop the downsampling method that
// toMultiscales records by default.
async function singleScale(ngffImage) {
  const multiscales = await toMultiscales(ngffImage, { scaleFactors: [] });
  delete multiscales.metadata.type;
  delete multiscales.metadata.metadata;
  return multiscales;
}

export async function writeOmeZarrFile(image, name) {
  return toFile(await toOmeZarrOzx(await singleScale(await itkImageToNgffImage(image))), name, "application/zip");
}

export async function writeOmeTiffFile(image, spatialUnits, name, { signal } = {}) {
  return toFile(await writeOmeTiff(image, spatialUnits, { signal }), name, "image/tiff");
}

export async function writeTransformFile(transform, name) {
  const { serializedTransform } = await onIoWorker((webWorker) => writeTransform(withTypedParameterArrays(transform), name, { webWorker }));
  return toFile(serializedTransform.data, name);
}

/** The run's chained TransformParameters files, in elastix's TOML format. */
export async function writeTransformParameterFiles(transformParameterObject, stem) {
  const write = (maps, names) => onIoWorker((webWorker) => writeParameterFiles(maps, names, { webWorker }));
  const files = await transformParameterFiles(transformParameterObject, stem, write);
  return files.map((file) => new File([file.data], file.name, { type: "application/toml" }));
}

// The images' RFC-4 orientation and origin are all the RFC-5 frames need, so
// a one-voxel image with the same geometry stands in for each.
function frameImage(image) {
  const dimension = image.imageType.dimension;
  return itkImageToNgffImage({
    imageType: { dimension, componentType: "float32", pixelType: "Scalar", components: 1 },
    name: image.name || "frame",
    origin: Array.from(image.origin),
    spacing: Array.from(image.spacing),
    direction: new Float64Array(image.direction),
    size: Array(dimension).fill(1),
    metadata: new Map(),
    data: new Float32Array(1),
  });
}

// elastix's own transformix maps each coordinate image; see transform-export.js.
const transformixOnIoWorker = (image, options) => onIoWorker((webWorker) => transformix(image, { ...options, webWorker }));

/**
 * The stationary-to-moving transform as an RFC-5 OME-Zarr archive: one
 * affine when every stage is linear, else a displacement field sampled on
 * the stationary grid. Coordinates are the images' intrinsic systems.
 */
export async function writeTransformOmeZarrFile({ transform, transformParameterObject, fixed, moving }, name) {
  const dims = spatialDims(fixed.imageType.dimension);
  const estimate = await estimateTransform({ transform, transformParameterObject, fixed, moving }, { transformix: transformixOnIoWorker });
  const frames = { fixed: await frameImage(fixed), moving: await frameImage(moving) };
  if (estimate.type === "affine") {
    const affine = itkTransformToNgffTransform([affineTransform(estimate.matrix, estimate.offset)], dims, true, frames);
    return toFile(await toOmeZarrOzx(namedTransformation(affine)), name, "application/zip");
  }
  const converted = await itkDisplacementFieldToNgffTransform(estimate.field, dims, { path: "displacements", ...frames });
  const store = new Map();
  await toOmeZarr(store, await singleScale(converted.field), { path: "displacements", version: "0.6" });
  await toOmeZarr(store, namedTransformation(converted.transform), { overwrite: false });
  return toFile(storeToZip(store), name, "application/zip");
}
