// DOM-free steps of the n4 workflow: the b0 mean and BIDS derivative names.

/** The b0 volumes of a series (b < 50 s/mm²), or every volume of a series without b-values. */
export function b0Volumes(bvals, frames) {
  if (!bvals) return Array.from({ length: frames }, (_, i) => i);
  if (!bvals.every((value) => Number.isFinite(value) && value >= 0)) {
    throw new Error("The bval file must contain finite non-negative b-values.");
  }
  const b0 = bvals.map((b, i) => (b < 50 ? i : -1)).filter((i) => i >= 0);
  if (!b0.length) throw new Error("The bval file lists no b0 volume (b < 50 s/mm²) to estimate the bias field from.");
  return b0;
}

/** Mean of the given volumes, voxel by voxel. `data` is frame-major. */
export function meanVolumes(data, voxels, volumes) {
  const mean = new Float32Array(voxels);
  for (const v of volumes) {
    const offset = v * voxels;
    for (let i = 0; i < voxels; i++) mean[i] += data[offset + i];
  }
  for (let i = 0; i < voxels; i++) mean[i] /= volumes.length;
  return mean;
}

/** The BIDS stem and suffix of an image name: sub-01_dwi.nii.gz gives ["sub-01", "dwi"]. */
export function splitName(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  return match ? [match[1], match[2]] : [base, ""];
}

/** Derivative names for the corrected image, the bias field, the mask and passed-through files. */
export function outputNames(fileName) {
  const [originalStem, suffix] = splitName(fileName);
  const stem = originalStem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
  const base = suffix ? `${stem}_desc-n4_${suffix}` : `${stem}_desc-n4`;
  return {
    image: `${base}.nii.gz`,
    bias: `${stem}_desc-n4_biasfield.nii.gz`,
    mask: `${stem}_desc-brain_mask.nii.gz`,
    bval: `${base}.bval`,
    bvec: `${base}.bvec`,
    sidecar: `${base}.json`,
  };
}
