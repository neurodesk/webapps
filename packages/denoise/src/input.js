// DOM-free reader for one single-channel 2D image, 3D Z-stack or 2D+T time-series
// in TIFF, OME-TIFF, ImageJ TIFF or NIfTI format. Validates finiteness, dimensions,
// temporal units and working-memory bounds before processing or preview.
import { readTiffStack } from "@neurodesk/webapp-components/file-io/tiff";
import { decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { InputTooLargeError, assertInputSize, assertNiftiDecodedSize } from "@neurodesk/webapp-components/file-io/input-limits";
import { assertValidDims, niftiSpacingUm } from "./format.js";
import { assertFiniteVoxels } from "./core/metrics.js";

/**
 * Maximum decoded float32 voxel bytes accepted in the browser (64 MiB = 16.7M voxels) so input,
 * worker copy, denoised output, residual, and serialized TIFF/NIfTI buffers stay within tab memory.
 */
export const MAX_INPUT_BYTES = 2 ** 26;
const METADATA_BYTES = 2 ** 25;

/** Seconds per NIfTI-1 temporal unit code (`xyzt_units & 56`): unspecified/s, ms, us. */
const NIFTI_TIME_UNIT_SECONDS = Object.freeze({ 0: 1, 8: 1, 16: 1e-3, 24: 1e-6 });
const NIFTI_NON_TEMPORAL_UNITS = Object.freeze({ 32: "Hz", 40: "ppm", 48: "rad/s" });

export function formatOf(name) {
  if (/\.(ome\.)?tiff?$/i.test(name)) return "tiff";
  if (/\.nii(\.gz)?$/i.test(name)) return "nifti";
  return null;
}

/**
 * Validates that a TIFF stack is single-channel and either 2D, 3D (Z) or 2D+T (T).
 * Returns the third-axis kind (`"z"` or `"t"`).
 */
export function checkSingleChannelStack({ pages, metadata }, name) {
  if (metadata.sizeC > 1) {
    throw new Error(`${name} has ${metadata.sizeC} channels; save one channel to denoise as its own file.`);
  }
  if (metadata.unlabelledStack) return "z";
  if (metadata.sizeZ > 1 && metadata.sizeT > 1) {
    throw new Error(`${name} has both ${metadata.sizeZ} Z planes and ${metadata.sizeT} time points; save one 3D Z-stack or one 2D+T time-series.`);
  }
  if (metadata.sizeT > 1) {
    if (metadata.sizeT !== pages) {
      throw new Error(`${name} declares ${metadata.sizeT} frames but holds ${pages} pages; save the stack again.`);
    }
    return "t";
  }
  if (metadata.sizeZ !== pages) {
    throw new Error(`${name} declares ${metadata.sizeZ} Z planes but holds ${pages} pages; save the stack again.`);
  }
  return "z";
}

const SPACING_SOURCE = { ome: "OME-XML", imagej: "ImageJ" };

/**
 * Reads one TIFF or NIfTI File/Blob-like object into `{ name, format, dims: [nz, ny, nx],
 * axisKind, frameInterval, data, spacingUm, spacingSource, niftiHeader, previewBuffer }`
 * with `data` as finite Float32Array `[z][y][x]`.
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
    const axisKind = checkSingleChannelStack(stack, file.name);
    const dims = [stack.pages, stack.height, stack.width];
    assertValidDims(dims);
    assertFiniteVoxels(stack.data, file.name);
    const spacingUm = stack.metadata.pixelSize;
    return {
      name: file.name,
      format,
      dims,
      axisKind,
      frameInterval: stack.metadata.frameInterval > 0 ? stack.metadata.frameInterval : null,
      data: stack.data,
      spacingUm,
      spacingSource: Object.values(spacingUm).some(Boolean) ? SPACING_SOURCE[stack.metadata.kind] ?? null : null,
      niftiHeader: null,
      previewBuffer: null,
    };
  }

  const buffer = await decodeNiftiBuffer(bytes, { maxBytes: maxFileBytes + 1 });
  signal?.throwIfAborted();
  if (buffer.byteLength > maxFileBytes) {
    throw new InputTooLargeError(buffer.byteLength, maxFileBytes, { subject: "Decompressed NIfTI" });
  }

  // Validate NIfTI-1 rank, explicit axes dim[1..7], decoded Float32 memory budget, and time units
  // before allocating Float32 voxel buffers (prevents rank-2 dim[3]=0 size bypass and rank-5 vectors).
  const view = new DataView(buffer);
  const littleEndian = view.getInt32(0, true) === 348;
  const ndim = view.getInt16(40, littleEndian);
  if (ndim < 2 || ndim > 4) {
    throw new Error(`${file.name} has ${ndim} dimensions; choose a 2D image, 3D stack or 2D+T time-series.`);
  }
  const rawDims = Array.from({ length: 7 }, (_, i) => view.getInt16(42 + 2 * i, littleEndian));
  const nx = rawDims[0];
  const ny = rawDims[1];
  const rawNz = ndim >= 3 ? rawDims[2] : 1;
  const rawNt = ndim >= 4 ? rawDims[3] : 1;
  for (let axis = 4; axis < 7; axis += 1) {
    if (rawDims[axis] > 1) {
      throw new Error(`${file.name} has size ${rawDims[axis]} on axis ${axis + 1}; vector and 5D NIfTI images are not supported.`);
    }
  }
  if (!(nx >= 1 && ny >= 1)) {
    throw new Error(`${file.name} has invalid image dimensions (${nx} × ${ny}).`);
  }
  const nz = rawNz > 0 ? rawNz : 1;
  const nt = rawNt > 0 ? rawNt : 1;
  if (nz > 1 && nt > 1) {
    throw new Error(`${file.name} is a 4D volume (${nx} × ${ny} × ${nz} × ${nt}); choose a single 2D image, 3D stack or 2D+T time-series.`);
  }

  const decodedFloatBytes = nx * ny * nz * nt * 4;
  if (decodedFloatBytes > maxBytes) {
    throw new InputTooLargeError(decodedFloatBytes, maxBytes, { subject: file.name });
  }

  // Normalise rank-2 NIfTI headers (where dim[3] may be 0) so both readNiftiFrames and NiiVue
  // see a valid 3D-compatible header with dim[0] = 3, dim[3] = 1.
  let parseBuffer = buffer;
  let normalizedRank2 = false;
  if (ndim === 2 && rawDims[2] <= 0) {
    parseBuffer = buffer.slice(0);
    const patched = new DataView(parseBuffer);
    patched.setInt16(40, 3, littleEndian);
    patched.setInt16(46, 1, littleEndian);
    patched.setInt16(48, 1, littleEndian);
    normalizedRank2 = true;
  }

  const { data, header } = readNiftiFrames(parseBuffer, Float32Array);
  let dims;
  let axisKind = "z";
  let frameInterval = null;
  if (nt > 1) {
    const timeUnit = view.getUint8(123) & 56;
    if (!Object.hasOwn(NIFTI_TIME_UNIT_SECONDS, timeUnit)) {
      const label = NIFTI_NON_TEMPORAL_UNITS[timeUnit] ?? `unit code ${timeUnit}`;
      throw new Error(`${file.name} uses non-temporal 4th-axis units (${label}); only 2D+T time-series (seconds, ms, µs or unspecified) are supported.`);
    }
    dims = [nt, ny, nx];
    axisKind = "t";
    const scale = NIFTI_TIME_UNIT_SECONDS[timeUnit];
    const dt = view.getFloat32(92, littleEndian);
    frameInterval = Number.isFinite(dt) && dt > 0 ? dt * scale : null;
  } else {
    dims = [nz, ny, nx];
  }

  assertValidDims(dims);
  assertFiniteVoxels(data, file.name);
  return {
    name: file.name,
    format,
    dims,
    axisKind,
    frameInterval,
    data,
    spacingUm: niftiSpacingUm(header),
    spacingSource: "NIfTI header",
    niftiHeader: parseBuffer.slice(0, Math.ceil(header.voxOffset)),
    previewBuffer: normalizedRank2 ? parseBuffer : null,
  };
}
