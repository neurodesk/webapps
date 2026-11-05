// Read one microscopy volume, TIFF or NIfTI, into `{ name, format, dims: [nz, ny, nx], data,
// spacingUm, spacingSource, niftiHeader }` with data `[z][y][x]` (x fastest), as the module takes
// it. DOM-free, so Node tests read the same files the app does.
import { readTiffStack, DEFAULT_MAX_BYTES } from "@neurodesk/microscopy-tiff";
import { decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { niftiSpacingUm } from "./config.js";

/** Decoded input bytes the app accepts before refusing a file. */
export const MAX_INPUT_BYTES = DEFAULT_MAX_BYTES / 2;

export function formatOf(name) {
  if (/\.(ome\.)?tiff?$/i.test(name)) return "tiff";
  if (/\.nii(\.gz)?$/i.test(name)) return "nifti";
  return null;
}

export async function readVolume(file, { signal, maxBytes = MAX_INPUT_BYTES } = {}) {
  const format = formatOf(file.name);
  if (!format) throw new Error(`${file.name} is not a TIFF or NIfTI file.`);
  if (!file.size) throw new Error(`${file.name} is empty.`);
  const bytes = await file.arrayBuffer();
  signal?.throwIfAborted();
  if (format === "tiff") {
    const stack = await readTiffStack(bytes, { maxBytes, signal });
    return {
      name: file.name,
      format,
      dims: [stack.depth, stack.height, stack.width],
      data: stack.data,
      spacingUm: stack.spacingUm,
      spacingSource: stack.spacingSource,
      niftiHeader: null,
    };
  }
  const buffer = await decodeNiftiBuffer(bytes);
  if (buffer.byteLength > maxBytes) throw new Error(`${file.name} needs ${(buffer.byteLength / 2 ** 20).toFixed(0)} MB decoded, above the ${(maxBytes / 2 ** 20).toFixed(0)} MB limit.`);
  const { data, header, frames } = readNiftiFrames(buffer, Float32Array);
  if (frames !== 1) throw new Error(`${file.name} has ${frames} volumes; choose a single 3D stack.`);
  return {
    name: file.name,
    format,
    dims: [header.nz, header.ny, header.nx],
    data,
    spacingUm: niftiSpacingUm(header),
    spacingSource: "NIfTI header",
    niftiHeader: buffer.slice(0, Math.ceil(header.voxOffset)),
  };
}
