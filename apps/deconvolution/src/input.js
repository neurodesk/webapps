// Read one microscopy volume, TIFF or NIfTI, into `{ name, format, dims: [nz, ny, nx], data,
// spacingUm, spacingSource, niftiHeader }` with data `[z][y][x]` (x fastest), as the module takes
// it. DOM-free, so Node tests read the same files the app does.
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError, assertInputSize, assertNiftiDecodedSize } from "@neurodesk/webapp-components/file-io/input-limits";
import { checkSquarePixels, niftiSpacingUm } from "./config.js";

/** Decoded voxel bytes the app accepts before refusing a file (512 MiB). */
export const MAX_INPUT_BYTES = 2 ** 29;

/**
 * File bytes allowed beyond the voxels, for page directories, OME-XML and NIfTI headers, so a
 * stack exactly at the voxel limit is not refused for its metadata (64 MiB).
 */
const METADATA_BYTES = 2 ** 26;

export function formatOf(name) {
  if (/\.(ome\.)?tiff?$/i.test(name)) return "tiff";
  if (/\.nii(\.gz)?$/i.test(name)) return "nifti";
  return null;
}

/**
 * Refuses a TIFF that is not one z stack of one channel at one time point, from the metadata
 * the shared reader returns. Pages the file does not label (a plain TIFF, an unlabelled ImageJ
 * stack) are z planes.
 * @param {import("@neurodesk/webapp-components/file-io/tiff").TiffStackInfo} stack
 */
export function checkZStack({ pages, metadata }, name) {
  if (metadata.sizeC > 1) throw new Error(`${name} has ${metadata.sizeC} channels; save the channel to deconvolve as its own stack.`);
  if (metadata.unlabelledStack) return;
  if (metadata.sizeT > 1) throw new Error(`${name} has ${metadata.sizeT} time points; save one time point as its own stack.`);
  if (metadata.sizeZ !== pages) throw new Error(`${name} declares ${metadata.sizeZ} z planes but holds ${pages} pages; save the stack again.`);
}

const SPACING_SOURCE = { ome: "OME-XML", imagej: "ImageJ" };

/**
 * `maxBytes` limits the decoded voxels (the Float32 array for NIfTI, checked from the header
 * before inflating), `maxFileBytes` the file and a NIfTI's inflated bytes.
 */
export async function readVolume(file, { signal, maxBytes = MAX_INPUT_BYTES, maxFileBytes = maxBytes + METADATA_BYTES } = {}) {
  const format = formatOf(file.name);
  if (!format) throw new Error(`${file.name} is not a TIFF or NIfTI file.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  signal?.throwIfAborted();
  assertInputSize([file], maxFileBytes);
  if (format === "nifti") {
    await assertNiftiDecodedSize(file, maxBytes);
    signal?.throwIfAborted();
  }
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (format === "tiff") {
    const stack = await readTiffStack(bytes, { maxBytes, signal, Type: Float32Array });
    checkZStack(stack, file.name);
    const spacingUm = stack.metadata.pixelSize;
    checkSquarePixels(spacingUm, file.name);
    return {
      name: file.name,
      format,
      dims: [stack.pages, stack.height, stack.width],
      data: stack.data,
      spacingUm,
      spacingSource: Object.values(spacingUm).some(Boolean) ? SPACING_SOURCE[stack.metadata.kind] : null,
      niftiHeader: null,
    };
  }
  // A header can understate what the stream inflates to: stop reading one byte past the limit.
  const buffer = await decodeNiftiBuffer(bytes, { maxBytes: maxFileBytes + 1 });
  signal?.throwIfAborted();
  if (buffer.byteLength > maxFileBytes) throw new InputTooLargeError(buffer.byteLength, maxFileBytes, { subject: "Decompressed NIfTI" });
  const { data, header, frames } = readNiftiFrames(buffer, Float32Array);
  if (frames !== 1) throw new Error(`${file.name} has ${frames} volumes; choose a single 3D stack.`);
  const spacingUm = niftiSpacingUm(header);
  checkSquarePixels(spacingUm, file.name);
  return {
    name: file.name,
    format,
    dims: [header.nz, header.ny, header.nx],
    data,
    spacingUm,
    spacingSource: "NIfTI header",
    niftiHeader: buffer.slice(0, Math.ceil(header.voxOffset)),
  };
}
