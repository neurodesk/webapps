import { decodeNiftiBuffer, isGzipped, parseNiftiHeader } from '@neurodesk/webapp-components/file-io/nifti';

export const MAX_BUFFER_BYTES = 2 ** 31 - 1;
export const BYTES_PER_PADDED_VOXEL = 288;
const product = (dims) => dims.reduce((total, size) => total * size, 1);

/** Mirrors Rust resampling and padding. Axis permutations do not change the buffer size. */
export function planInputMemory(header, voxelSizeMm = 1) {
  const inputShape = header.dims.slice(1, 4);
  const resample = voxelSizeMm !== 1 || header.pixDims.slice(1, 4).some((p) => !(Math.abs(p) >= 0.95 && Math.abs(p) <= 1.05));
  const outputShape = resample ? inputShape.map((size, axis) => {
    const spacing = Math.sqrt([0, 1, 2].reduce((sum, row) => sum + header.affine[row][axis] ** 2, 0));
    if (!(spacing >= 0.05 && spacing <= 20)) throw new Error('Voxel spacing is outside the supported range (0.05–20 mm).');
    const factor = spacing / voxelSizeMm;
    const start = -(factor - 1) / (2 * factor);
    const step = 1 / factor;
    return Math.ceil(((start + step * Math.ceil(size * factor)) - start) / step);
  }) : inputShape;
  const paddedShape = outputShape.map((size) => Math.max(128, Math.ceil(size / 32) * 32));
  return { inputShape, outputShape, paddedShape, requiredBufferBytes: product(paddedShape) * BYTES_PER_PADDED_VOXEL };
}

export class InputMemoryError extends Error {
  constructor(header, voxelSizeMm, maxBufferBytes, preparation) {
    const plan = planInputMemory(header, voxelSizeMm);
    let recommendedVoxelSizeMm = null;
    for (let tenths = Math.floor(voxelSizeMm * 10) + 1; tenths <= 30; tenths++) {
      if (planInputMemory(header, tenths / 10).requiredBufferBytes <= maxBufferBytes) {
        recommendedVoxelSizeMm = tenths / 10;
        break;
      }
    }
    const message = recommendedVoxelSizeMm
      ? `${preparation.robustFov ? 'After neck cropping, the scan' : 'The scan'} still exceeds GPU memory. Use ${recommendedVoxelSizeMm} mm voxels to reduce detail and memory.`
      : 'This scan cannot fit this GPU at 1–3 mm. Use standalone SynthSeg or another device.';
    super(message);
    this.name = 'InputMemoryError';
    this.recommendation = { voxelSizeMm: recommendedVoxelSizeMm, maxBufferBytes, ...plan, preparation };
  }
}

/** Crop only oversized inputs; a coarser processing grid always requires an explicit choice. */
export async function prepareBrowserInput({ file, voxelSizeMm = 1, robustFov = true,
  maxBufferBytes = MAX_BUFFER_BYTES, crop, onProgress = () => {} }) {
  if (!Number.isFinite(voxelSizeMm) || voxelSizeMm < 1 || voxelSizeMm > 3) {
    throw new Error('Processing voxel size must be between 1 and 3 mm.');
  }
  maxBufferBytes = Math.min(maxBufferBytes, MAX_BUFFER_BYTES);
  const source = await file.arrayBuffer();
  let bytes = await decodeNiftiBuffer(source, { maxBytes: 2 ** 31 + 1 });
  if (isGzipped(source) && bytes.byteLength > 2 ** 31) throw new Error('The decompressed NIfTI exceeds 2 GB.');
  let header = parseNiftiHeader(bytes);
  const preparation = { robustFov: false, originalShape: header.dims.slice(1, 4), voxelSizeMm };
  // Test the normal 1 mm grid even on a downsampling retry, so cropping happens in the same order.
  if (robustFov && planInputMemory(header).requiredBufferBytes > maxBufferBytes) {
    onProgress(0.01, 'Cropping excess neck with robust FOV…');
    bytes = await decodeNiftiBuffer(await crop(new File([bytes], 'input.nii')));
    header = parseNiftiHeader(bytes);
    preparation.robustFov = true;
    preparation.croppedShape = header.dims.slice(1, 4);
    onProgress(0.02, `Neck crop ready · ${preparation.croppedShape.join(' × ')} voxels`);
  }
  if (planInputMemory(header, voxelSizeMm).requiredBufferBytes > maxBufferBytes) {
    throw new InputMemoryError(header, voxelSizeMm, maxBufferBytes, preparation);
  }
  return { buffer: bytes, preparation };
}
