// DOM-free steps of the dwidenoise workflow: b-values, voxel chunks and BIDS derivative names.

/** The BIDS stem and suffix of an image name: sub-01_dwi.nii.gz gives ["sub-01", "dwi"]. */
export function splitName(fileName) {
  const base = fileName.replace(/\.nii(\.gz)?$/i, "");
  const match = base.match(/^(.*)_([A-Za-z0-9]+)$/);
  return match ? [match[1], match[2]] : [base, ""];
}

/** The derivative name of the denoised image and of its passed-through gradient files. */
export function outputNames(fileName) {
  const [stem, suffix] = splitName(fileName);
  const sourceStem = stem.split("_").filter((entity) => !entity.startsWith("desc-")).join("_");
  const base = suffix ? `${sourceStem}_desc-denoised_${suffix}` : `${sourceStem}_desc-denoised`;
  return { image: `${base}.nii.gz`, bval: `${base}.bval`, bvec: `${base}.bvec`, sidecar: `${base}.json` };
}

/** The sidecar of a denoised image: the input's, with the step recorded as BIDS derivatives do. */
export function derivativeSidecar(sidecar) {
  return { ...(sidecar ?? {}), Description: "Patch2Self denoising (DIPY 1.12.1 version 1 port, patch radius 0, OLS)" };
}

/** The b-values of an FSL .bval file, one per volume of the image. */
export function parseBvals(text, frames) {
  const bvals = text.trim().split(/\s+/).filter(Boolean).map(Number);
  if (bvals.length === 0) throw new Error("The bval file is empty.");
  if (!bvals.every((b) => Number.isFinite(b) && b >= 0)) throw new Error("The bval file holds a value that is not a b-value.");
  if (bvals.length !== frames) throw new Error(`The image has ${frames} volumes but the bval file lists ${bvals.length}.`);
  return bvals;
}

/** Splits nvox voxels into ranges of at most `size` voxels: [[first, count], …]. */
export function voxelRanges(nvox, size) {
  const ranges = [];
  for (let first = 0; first < nvox; first += size) ranges.push([first, Math.min(size, nvox - first)]);
  return ranges;
}

/** Copies voxels first..first + count of every volume into one volume-major chunk. */
export function gatherChunk(data, nvox, frames, first, count) {
  const chunk = new Float32Array(count * frames);
  for (let t = 0; t < frames; t++) chunk.set(data.subarray(t * nvox + first, t * nvox + first + count), t * count);
  return chunk;
}

/** Writes a chunk from gatherChunk back to voxels first..first + count of every volume. */
export function scatterChunk(out, chunk, nvox, frames, first, count) {
  for (let t = 0; t < frames; t++) out.set(chunk.subarray(t * count, (t + 1) * count), t * nvox + first);
}
