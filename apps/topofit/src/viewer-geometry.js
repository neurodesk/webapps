import { readVolumeHeader, resolveWorldAffine } from '@neurodesk/topofit';

const HEADER_PREFIX_BYTES = 544;

function affineDiffers(actual, expected) {
  for (let row = 0; row < 4; row += 1) {
    for (let column = 0; column < 4; column += 1) {
      if (!(Math.abs(actual[row][column] - expected[row][column]) <= 1e-12)) return true;
    }
  }
  return false;
}

function pixDimsDiffer(pixDims, spacing) {
  for (let axis = 0; axis < 3; axis += 1) {
    if (!(Math.abs(pixDims[axis + 1] - spacing[axis]) <= 1e-6 * Math.max(1, spacing[axis]))) return true;
  }
  return false;
}

// Reads only the header prefix of a NIfTI File/Blob without copying voxels,
// falling back to nifti-reader-js (fflate) only when DecompressionStream rejects
// a small gzip stream with a bad CRC trailer.
async function readHeaderBytes(file) {
  const head = await file.slice(0, HEADER_PREFIX_BYTES).arrayBuffer();
  const bytes = new Uint8Array(head);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return head;
  if (typeof DecompressionStream === 'function' && typeof file.stream === 'function') {
    const output = new Uint8Array(HEADER_PREFIX_BYTES);
    let offset = 0;
    let streamFailed = false;
    try {
      const reader = file.stream().pipeThrough(new DecompressionStream('gzip')).getReader();
      try {
        while (offset < HEADER_PREFIX_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          const take = Math.min(value.byteLength, HEADER_PREFIX_BYTES - offset);
          output.set(value.subarray(0, take), offset);
          offset += take;
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
    } catch {
      streamFailed = true;
    }
    if (!streamFailed || offset >= HEADER_PREFIX_BYTES) return output.buffer.slice(0, offset);
  }
  return file.arrayBuffer();
}

// Validates the original untouched NIfTI header (before NiiVue normalizes zero
// or non-finite pixDims to 1) and returns the millimetre world affine.
export async function readFileWorldAffine(file) {
  const header = readVolumeHeader(await readHeaderBytes(file));
  return resolveWorldAffine(header);
}

// Re-aligns every loaded NiiVue volume onto TopoFit's millimetre world grid
// without copying voxel arrays. Updating pixDims and xyzt_units before
// setVolumeAffine keeps NiiVue's orthogonal extents and oblique basis in
// millimetres, and marking the volume dirty forces a full GPU texture
// re-orientation when the resolved affine changes permRAS or overlay framing.
export async function alignViewerVolumes(nv, isCurrent = () => true, expectedAffines = []) {
  let aligned = false;
  for (let index = 0; index < nv.volumes.length; index += 1) {
    if (!isCurrent()) return false;
    const volume = nv.volumes[index];
    if (!volume?.hdr) continue;
    const affine = expectedAffines[index] ?? resolveWorldAffine(volume.hdr);
    const spacing = [0, 1, 2].map((column) => Math.hypot(affine[0][column], affine[1][column], affine[2][column]));
    const unit = volume.hdr.xyzt_units & 7;
    if (!affineDiffers(volume.hdr.affine, affine) && !pixDimsDiffer(volume.hdr.pixDims, spacing) && (unit === 0 || unit === 2)) continue;
    volume.hdr.pixDims[1] = spacing[0];
    volume.hdr.pixDims[2] = spacing[1];
    volume.hdr.pixDims[3] = spacing[2];
    volume.hdr.xyzt_units = (volume.hdr.xyzt_units & ~7) | 2;
    volume.originalAffine = affine.map((row) => [...row]);
    volume.isDirty = true;
    await nv.setVolumeAffine(index, affine);
    if (!isCurrent()) return false;
    aligned = true;
  }
  if (aligned) nv.createOnLocationChange?.();
  return true;
}
