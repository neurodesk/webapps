// Pick the reader for the files a user chose or dropped.
import { openNiftiSource } from "./nifti.js";
import { openRasterSequence } from "./raster.js";
import { openTiffSequence, openTiffSource } from "./tiff.js";

export { openNiftiSource } from "./nifti.js";
export { openRasterSequence, decodeRaster, unpackBits } from "./raster.js";
export { openTiffSequence, openTiffSource } from "./tiff.js";
export { imageStem, rgbaColour, withMetadata } from "./source.js";

const KINDS = [
  ["tiff", /\.(tiff?|btf|tf8|tf2)$/i],
  ["nifti", /\.nii(\.gz)?$/i],
  ["png", /\.png$/i],
  ["jpeg", /\.jpe?g$/i],
];

/** The kind of an image file from its name, or null. */
export function fileKind(name) {
  return KINDS.find(([, pattern]) => pattern.test(name))?.[0] ?? null;
}

/**
 * Open the chosen files as one source: one TIFF, OME-TIFF or NIfTI file, or a sequence of
 * single-page TIFF, PNG or JPEG files (one per Z plane). Other files are refused by name.
 */
export async function openSource(files, options = {}) {
  const images = files.filter((file) => !/^\./.test(file.name));
  if (!images.length) throw new Error("Choose a TIFF, OME-TIFF, PNG or JPEG sequence, or NIfTI image.");
  const unknown = images.find((file) => !fileKind(file.name));
  if (unknown) throw new Error(`${unknown.name} is not a TIFF, PNG, JPEG or NIfTI file.`);
  const kinds = new Set(images.map((file) => fileKind(file.name)));
  if (kinds.size > 1) throw new Error("Choose files of one kind: a TIFF, a NIfTI image, or a PNG or JPEG sequence.");
  const [kind] = kinds;
  if (kind === "nifti") {
    if (images.length > 1) throw new Error("Choose one NIfTI image at a time.");
    return openNiftiSource(images[0], options);
  }
  if (kind === "tiff") return images.length === 1 ? openTiffSource(images[0], options) : openTiffSequence(images, options);
  return openRasterSequence(images, options);
}
