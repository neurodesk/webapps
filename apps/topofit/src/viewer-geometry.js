import { readVolumeHeader, resolveWorldAffine } from '@neurodesk/topofit';

const HEADER_PREFIX_BYTES = 544;
const MIN_NIFTI_HEADER_BYTES = 348;
const GZIP_CHUNK_BYTES = 256;
const MAX_GZIP_HEADER_BYTES = 65536;

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

async function findGzipPayloadOffset(file) {
  let limit = 512;
  for (;;) {
    const view = new Uint8Array(await file.slice(0, Math.min(file.size, limit)).arrayBuffer());
    if (view.length < 10) throw new Error('The NIfTI image is truncated.');
    if (view[0] !== 0x1f || view[1] !== 0x8b || view[2] !== 0x08) {
      throw new Error('The NIfTI gzip header is invalid.');
    }
    const flags = view[3];
    let offset = 10;
    let incomplete = false;
    if (flags & 0x04) {
      if (offset + 2 > view.length) {
        incomplete = true;
      } else {
        const extraLength = view[offset] | (view[offset + 1] << 8);
        offset += 2 + extraLength;
        if (offset > view.length) incomplete = true;
      }
    }
    for (const flag of [0x08, 0x10]) {
      if (incomplete) break;
      if (flags & flag) {
        const end = view.indexOf(0, offset);
        if (end < 0) incomplete = true;
        else offset = end + 1;
      }
    }
    if (!incomplete && (flags & 0x02)) {
      if (offset + 2 > view.length) incomplete = true;
      else offset += 2;
    }
    if (!incomplete) return offset;
    if (limit >= file.size || limit >= MAX_GZIP_HEADER_BYTES) {
      throw new Error('The NIfTI gzip header is truncated.');
    }
    limit = Math.min(limit * 2, MAX_GZIP_HEADER_BYTES);
  }
}

async function inflateDeflateSlice(chunk) {
  const decompressor = new DecompressionStream('deflate-raw');
  const writer = decompressor.writable.getWriter();
  const reader = decompressor.readable.getReader();
  const output = new Uint8Array(HEADER_PREFIX_BYTES);
  let offset = 0;
  let error = null;

  const feed = (async () => {
    try {
      await writer.write(chunk);
      await writer.close();
    } catch {
      // Expected when the reader cancels early or on a truncated prefix slice.
    }
  })();

  try {
    while (offset < HEADER_PREFIX_BYTES) {
      let result;
      try {
        result = await reader.read();
      } catch (readError) {
        error = readError;
        break;
      }
      if (result.done) break;
      const take = Math.min(result.value.byteLength, HEADER_PREFIX_BYTES - offset);
      output.set(result.value.subarray(0, take), offset);
      offset += take;
    }
  } finally {
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
    await feed;
  }
  return { bytes: output.buffer.slice(0, offset), offset, error };
}

// Inflates only the NIfTI header prefix from a gzipped File/Blob using bounded
// raw-DEFLATE prefix slices (starting at 256 bytes, doubling only if needed).
// Each slice caps expansion on highly compressible scans to ~256 KiB and skips
// the gzip CRC32 trailer so bad-CRC scans match readVolume() without reading or
// inflating the full file.
async function inflateGzipHeaderPrefix(file) {
  const start = await findGzipPayloadOffset(file);
  const remaining = file.size - start;
  if (remaining <= 0) throw new Error('The NIfTI image is truncated.');
  let windowBytes = GZIP_CHUNK_BYTES;
  for (;;) {
    const length = Math.min(windowBytes, remaining);
    const chunk = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    const { bytes, offset, error } = await inflateDeflateSlice(chunk);
    if (offset >= HEADER_PREFIX_BYTES) return bytes;
    if (length >= remaining) {
      // Tiny gzipped NIfTI-1 files (< 544 bytes uncompressed) can place the
      // 8-byte gzip trailer after the final DEFLATE block; once at least 348
      // header bytes were inflated, trailing trailer bytes are harmless.
      if (offset >= MIN_NIFTI_HEADER_BYTES) return bytes;
      if (error) throw error;
      return bytes;
    }
    windowBytes *= 2;
  }
}

// Reads only the header prefix of a NIfTI File/Blob without copying or inflating
// the full voxel payload.
async function readHeaderBytes(file) {
  const head = await file.slice(0, HEADER_PREFIX_BYTES).arrayBuffer();
  const bytes = new Uint8Array(head);
  if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) return head;
  if (typeof DecompressionStream === 'function') {
    return inflateGzipHeaderPrefix(file);
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
