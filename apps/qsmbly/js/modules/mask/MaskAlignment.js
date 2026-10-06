import { createMaskNifti, parseNiftiHeader } from '../file-io/NiftiUtils.js';

/** Explicit voxel-axis repair. This does not estimate registration or resample anatomy. */
export function repairMaskAlignment(raw, maskHeader, referenceHeader, flips = [false, false, false]) {
  const mask = parseNiftiHeader(maskHeader);
  const reference = parseNiftiHeader(referenceHeader);
  if (mask.dims.slice(4).some(dim => dim > 1)) throw new Error('Expected a single 3D mask volume.');
  const dims = reference.dims.slice(1, 4);
  if (dims.some((dim, axis) => dim !== mask.dims[axis + 1])) {
    throw new Error('Axis flips require matching image and mask dimensions. Resample the mask first.');
  }
  const unitScale = header => ({ 1: 1000, 2: 1, 3: 0.001 }[new DataView(header).getUint8(123) & 7] || 1);
  if (dims.some((_, axis) => Math.abs(
    mask.voxelSize[axis] * unitScale(maskHeader) - reference.voxelSize[axis] * unitScale(referenceHeader)
  ) > 0.001)) {
    throw new Error('Axis flips require matching voxel sizes. Resample the mask first.');
  }
  const [nx, ny, nz] = dims;
  if (raw.length !== nx * ny * nz) throw new Error('Expected a single 3D mask volume.');
  const data = new Float32Array(raw.length);
  let count = 0;
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const sx = flips[0] ? nx - 1 - x : x;
        const sy = flips[1] ? ny - 1 - y : y;
        const sz = flips[2] ? nz - 1 - z : z;
        const value = raw[sx + nx * (sy + ny * sz)] > 0.5 ? 1 : 0;
        data[x + nx * (y + ny * z)] = value;
        count += value;
      }
    }
  }
  if (!count) throw new Error('The uploaded mask contains no foreground voxels.');
  return { data, header: referenceHeader, buffer: createMaskNifti(data, referenceHeader), count };
}

/** Preview state is separate from the accepted pipeline mask. */
export class MaskAlignmentSession {
  constructor(file, reference, raw, maskHeader, referenceHeader) {
    Object.assign(this, { file, reference, raw, maskHeader, referenceHeader });
    this.candidate = null;
  }

  preview(flips) {
    this.candidate = repairMaskAlignment(this.raw, this.maskHeader, this.referenceHeader, flips);
    this.flips = [...flips];
    return this.candidate;
  }

  invalidate() { this.candidate = null; }

  accept(file, reference) {
    if (file !== this.file || reference !== this.reference) throw new Error('Inputs changed. Start alignment repair again.');
    if (!this.candidate) throw new Error('Preview the selected alignment before applying it.');
    const axes = ['X', 'Y', 'Z'].filter((_, i) => this.flips[i]).join('') || 'header';
    return new File([this.candidate.buffer], `${file.name.replace(/\.nii(\.gz)?$/i, '')}_aligned_${axes}.nii`,
      { type: 'application/octet-stream' });
  }
}
