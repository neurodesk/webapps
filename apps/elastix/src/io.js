// Browser image IO. Every source becomes the scalar float32 ITK-Wasm image
// elastix registers, plus a NIfTI file NiiVue displays:
// - NIfTI, and DICOM converted by dcm2niix, read with @itk-wasm/image-io;
// - other ITK formats read with image-io, written to NIfTI for display;
// - OME-Zarr (.ozx, a dropped .zarr folder, a URL) read with ngff-zarr;
// - TIFF and OME-TIFF (a local file, or a URL read by range request) read with fiff.
// ITK-Wasm IO runs on one shared worker, one call at a time: concurrent
// readImage calls deadlock.
import { createWebWorker, castImage, FloatTypes } from "itk-wasm";
import { readImage, writeImage } from "@itk-wasm/image-io";
import { writeTransform } from "@itk-wasm/transform-io";
import { readParameterFiles, writeParameterFiles } from "@itk-wasm/elastix";
import { fromOmeZarr, ngffImageToItkImage, itkImageToNgffImage, toMultiscales, toOmeZarrOzx } from "@fideus-labs/ngff-zarr/browser";
import { TiffStore } from "@fideus-labs/fiff";
import ZipFileStore from "@zarrita/storage/zip";
import { chooseLevel, classifySource, squeezeSingletons, urlName, voxelCount, VOXEL_BUDGET, zarrFolderEntries } from "./sources.js";
import { outputStem, plainBytes, withTypedParameterArrays } from "./outputs.js";

let ioWorker = null;
let queue = Promise.resolve();

/** Run one ITK-Wasm call on the shared IO worker after the calls before it. */
function onIoWorker(task) {
  const run = queue.then(async () => {
    ioWorker ??= await createWebWorker(null);
    const result = await task(ioWorker);
    if (result?.webWorker) ioWorker = result.webWorker;
    return result;
  });
  queue = run.catch(() => {});
  return run;
}

/** Abandon in-flight IO: its pipeline promise never settles once the worker is gone. */
export function resetIo() {
  ioWorker?.terminate();
  ioWorker = null;
  queue = Promise.resolve();
}

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
export async function writeImageFile(image, name) {
  const { serializedImage } = await onIoWorker((webWorker) => writeImage(image, name, { webWorker }));
  return toFile(serializedImage.data, name);
}

// The display copy keeps the source pixel type; elastix gets float32 so any
// pair of pixel types registers and the result is never wrapped into an integer range.
async function prepared(image, name, kind, displayFile, detail = "") {
  const scalar = squeezeSingletons(image);
  const display = displayFile ?? await writeImageFile(scalar, `${outputStem(name)}.nii.gz`);
  const float = scalar.imageType.componentType === FloatTypes.Float32 ? scalar : castImage(scalar, { componentType: FloatTypes.Float32 });
  const large = voxelCount(scalar) > VOXEL_BUDGET ? " · above the voxel budget, registration may be slow" : "";
  return { image: float, displayFile: display, name, kind, note: `${describe(scalar)}${detail}${large}` };
}

/** A NIfTI file (as is, or converted from DICOM by dcm2niix). */
export async function readNiftiFile(file) {
  const { image } = await onIoWorker((webWorker) => readImage(file, { webWorker }));
  return prepared(image, file.name, "nifti", file);
}

// Zip archives may wrap the OME-Zarr root in a folder; read below it.
function stripZarrPrefix(entries) {
  const root = Object.keys(entries)
    .filter((key) => /(^|\/)(zarr\.json|\.zattrs)$/.test(key))
    .sort((a, b) => a.length - b.length)[0];
  const prefix = root ? root.slice(0, root.lastIndexOf("/") + 1) : "";
  if (!prefix) return entries;
  return Object.fromEntries(Object.entries(entries)
    .filter(([key]) => key.startsWith(prefix))
    .map(([key, entry]) => [key.slice(prefix.length), entry]));
}

function folderStore(entries) {
  return {
    async get(key) {
      const file = entries.get(key.replace(/^\//, ""));
      return file ? new Uint8Array(await file.arrayBuffer()) : undefined;
    },
  };
}

// bioformats2raw layouts hold the image one group below the root.
async function readMultiscales(store, options = {}) {
  try {
    return await fromOmeZarr(store, options);
  } catch (error) {
    try {
      return await fromOmeZarr(store, { ...options, path: "0" });
    } catch {
      throw error;
    }
  }
}

async function readOmeZarr(store, name, kind, options) {
  const multiscales = await readMultiscales(store, options);
  const { image: level, level: index } = chooseLevel(multiscales.images);
  const image = await ngffImageToItkImage(level, { tIndex: 0, cIndex: 0 });
  const count = multiscales.images.length;
  return prepared(image, name, kind, null, ` · pyramid level ${index + 1} of ${count}`);
}

async function fetchFile(url, signal) {
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`${urlName(url)} returned HTTP ${response.status}.`);
  return new File([await response.blob()], urlName(url));
}

/** Read any source except NIfTI/DICOM files: ITK formats, OME-Zarr or TIFF, local or by URL. */
export async function readSource(source, { signal } = {}) {
  const kind = classifySource(source);
  const name = typeof source === "string" ? urlName(source) : source[0].name;
  switch (kind) {
    case "file-url": {
      const file = await fetchFile(source, signal);
      return /\.nii(\.gz)?$/i.test(file.name) ? readNiftiFile(file) : readSource([file], { signal });
    }
    case "itk": {
      const { image } = await onIoWorker((webWorker) => readImage(source[0], { webWorker }));
      return prepared(image, name, kind);
    }
    case "tiff":
      return readOmeZarr(await TiffStore.fromBlob(source[0]), name, kind, { version: "0.5" });
    case "tiff-url":
      return readOmeZarr(await TiffStore.fromUrl(source), name, kind, { version: "0.5" });
    case "ozx":
      return readOmeZarr(ZipFileStore.fromBlob(source[0], { transformEntries: stripZarrPrefix }), name, kind);
    case "ozx-url":
      return readOmeZarr(ZipFileStore.fromUrl(source, { transformEntries: stripZarrPrefix }), name, kind);
    case "zarr-folder": {
      const { root, entries } = zarrFolderEntries(source);
      return readOmeZarr(folderStore(entries), root.split("/").filter(Boolean).pop(), kind);
    }
    case "zarr-url":
      return readOmeZarr(source, name, kind);
    default:
      throw new Error("Read NIfTI and DICOM files with readNiftiFile.");
  }
}

/** Custom elastix parameter files (.txt or .toml) as a parameter object. */
export async function readCustomParameters(files) {
  const { parameterObject } = await onIoWorker((webWorker) => readParameterFiles({ parameterFiles: files, webWorker }));
  return parameterObject;
}

export async function writeOmeZarrFile(image, name) {
  const ngffImage = await itkImageToNgffImage(image);
  const multiscales = await toMultiscales(ngffImage, { scaleFactors: [] });
  return toFile(await toOmeZarrOzx(multiscales), name, "application/zip");
}

export async function writeTransformFile(transform, name) {
  const { serializedTransform } = await onIoWorker((webWorker) => writeTransform(withTypedParameterArrays(transform), name, { webWorker }));
  return toFile(serializedTransform.data, name);
}

export async function writeParameterTextFiles(maps, names) {
  const { parameterFiles } = await onIoWorker((webWorker) => writeParameterFiles(maps, names, { webWorker }));
  if (parameterFiles.some((file) => !file.data)) throw new Error("elastix wrote an empty parameter file.");
  return parameterFiles.map((file, index) => new File([file.data], names[index], { type: "text/plain" }));
}
