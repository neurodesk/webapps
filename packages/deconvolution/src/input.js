// Read one microscopy volume, TIFF or NIfTI, into `{ name, format, dims: [nz, ny, nx], data,
// spacingUm, spacingSource, niftiHeader }` with data `[z][y][x]` (x fastest), as the module takes
// it. DOM-free, so both the web app and the portable CLI read the exact same files.
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { decodeNiftiBuffer, isGzipped, parseNiftiHeader, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError, assertInputSize, assertNiftiDecodedSize } from "@neurodesk/webapp-components/file-io/input-limits";
import { checkSquarePixels, niftiSpacingUm } from "./format.js";

/** Decoded voxel bytes accepted before refusing a file (512 MiB). */
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
 */
export function checkZStack({ pages, metadata }, name) {
  if (metadata.sizeC > 1) throw new Error(`${name} has ${metadata.sizeC} channels; save the channel to deconvolve as its own stack.`);
  if (metadata.unlabelledStack) return;
  if (metadata.sizeT > 1) throw new Error(`${name} has ${metadata.sizeT} time points; save one time point as its own stack.`);
  if (metadata.sizeZ !== pages) throw new Error(`${name} declares ${metadata.sizeZ} z planes but holds ${pages} pages; save the stack again.`);
}

/** NiBabel affine precedence (`sform > qform > LAS-centered fallback`). */
export function niftiAffine(headerBuffer) {
  const header = parseNiftiHeader(headerBuffer);
  if (header.sformCode > 0 || header.qformCode > 0) return header.affine;
  const dx = Math.abs(header.pixDims[1]) || 1;
  const dy = Math.abs(header.pixDims[2]) || 1;
  const dz = Math.abs(header.pixDims[3]) || 1;
  const nx = Math.max(1, header.nx);
  const ny = Math.max(1, header.ny);
  const nz = Math.max(1, header.nz);
  return [
    new Float64Array([-dx, 0, 0, ((nx - 1) / 2) * dx]),
    new Float64Array([0, dy, 0, -((ny - 1) / 2) * dy]),
    new Float64Array([0, 0, dz, -((nz - 1) / 2) * dz]),
    new Float64Array([0, 0, 0, 1]),
  ];
}

function assertFiniteFloat32(data, name) {
  for (let i = 0; i < data.length; i += 1) {
    if (!Number.isFinite(data[i])) {
      throw new Error(`${name} has non-finite values (NaN or infinity) in float32.`);
    }
  }
}

const SPACING_SOURCE = { ome: "OME-XML", imagej: "ImageJ" };

/**
 * `maxBytes` limits the decoded voxels (the Float32 array for NIfTI, checked from the header
 * before inflating), `maxFileBytes` the file and a NIfTI's inflated bytes.
 * Callers in Node may pass `gunzip` (e.g. bounded native `gunzipSync` with CRC32 validation).
 */
export async function readVolume(file, { signal, maxBytes = MAX_INPUT_BYTES, maxFileBytes = maxBytes + METADATA_BYTES, gunzip } = {}) {
  const format = formatOf(file.name);
  if (!format) throw new Error(`${file.name} is not a TIFF or NIfTI file.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  signal?.throwIfAborted();
  assertInputSize([file], maxFileBytes);
  if (format === "nifti" && !gunzip) {
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
  let buffer;
  if (gunzip && isGzipped(bytes)) {
    buffer = gunzip(new Uint8Array(bytes), maxFileBytes, file.name);
  } else {
    // A header can understate what the stream inflates to: stop reading one byte past the limit.
    buffer = await decodeNiftiBuffer(bytes, { maxBytes: maxFileBytes + 1 });
  }
  signal?.throwIfAborted();
  if (buffer.byteLength > maxFileBytes) throw new InputTooLargeError(buffer.byteLength, maxFileBytes, { subject: "Decompressed NIfTI" });
  const { data, header, frames } = readNiftiFrames(buffer, Float32Array);
  if (frames !== 1) throw new Error(`${file.name} has ${frames} volumes; choose a single 3D stack.`);
  if (data.byteLength > maxBytes) throw new InputTooLargeError(data.byteLength, maxBytes, { subject: file.name });
  // Check finiteness after Float32Array narrowing (catches float64 values that overflow float32).
  assertFiniteFloat32(data, file.name);
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
    affine: niftiAffine(buffer),
  };
}
