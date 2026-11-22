import { Inflate } from 'fflate';
import { readVolumeHeader, resolveWorldAffine } from '@neurodesk/topofit';

const HEADER_PREFIX_BYTES = 544;
const GZIP_CHUNK_BYTES = 256;
const GZIP_SCAN_BYTES = 512;

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

async function readSlice(file, start, end, isCurrent) {
  if (!isCurrent()) return null;
  const buffer = await file.slice(start, end).arrayBuffer();
  if (!isCurrent()) return null;
  return new Uint8Array(buffer);
}

async function scanPastZeroByte(file, startOffset, isCurrent) {
  let offset = startOffset;
  while (offset < file.size) {
    const end = Math.min(offset + GZIP_SCAN_BYTES, file.size);
    const view = await readSlice(file, offset, end, isCurrent);
    if (!view) return null;
    const zeroIndex = view.indexOf(0);
    if (zeroIndex >= 0) return offset + zeroIndex + 1;
    offset = end;
  }
  throw new Error('The NIfTI gzip header is truncated.');
}

async function findGzipPayloadOffset(file, isCurrent) {
  if (file.size < 10) throw new Error('The NIfTI image is truncated.');
  const fixed = await readSlice(file, 0, 10, isCurrent);
  if (!fixed) return null;
  if (fixed[0] !== 0x1f || fixed[1] !== 0x8b || fixed[2] !== 0x08 || (fixed[3] & 0xe0) !== 0) {
    throw new Error('The NIfTI gzip header is invalid.');
  }
  const flags = fixed[3];
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > file.size) throw new Error('The NIfTI gzip header is truncated.');
    const lenBytes = await readSlice(file, offset, offset + 2, isCurrent);
    if (!lenBytes) return null;
    const extraLength = lenBytes[0] | (lenBytes[1] << 8);
    offset += 2 + extraLength;
    if (offset > file.size) throw new Error('The NIfTI gzip header is truncated.');
  }
  if (flags & 0x08) {
    offset = await scanPastZeroByte(file, offset, isCurrent);
    if (offset === null) return null;
  }
  if (flags & 0x10) {
    offset = await scanPastZeroByte(file, offset, isCurrent);
    if (offset === null) return null;
  }
  if (flags & 0x02) {
    offset += 2;
    if (offset > file.size) throw new Error('The NIfTI gzip header is truncated.');
  }
  return offset;
}

function targetHeaderBytes(bytes, offset) {
  if (offset < 4) return HEADER_PREFIX_BYTES;
  const view = new DataView(bytes.buffer, bytes.byteOffset, offset);
  const le = view.getInt32(0, true);
  const be = view.getInt32(0, false);
  if (le === 348 || be === 348) return 348;
  if (le === 540 || be === 540) return 540;
  return 0;
}

// Inflates only the NIfTI header prefix from a gzipped File/Blob by feeding
// fixed 256-byte slices synchronously into raw DEFLATE. Stopping as soon as the
// format-specific NIfTI header (348 bytes for NIfTI-1, 540 for NIfTI-2) is
// decoded, when the leading bytes cannot be NIfTI, or when the first DEFLATE
// stream finishes bounds reads and inflation in Node and Chromium, skips the
// gzip CRC32 trailer so bad-CRC scans match readVolume(), and halts on
// cancellation before the next slice is read.
async function inflateGzipHeaderPrefix(file, isCurrent) {
  const start = await findGzipPayloadOffset(file, isCurrent);
  if (start === null) return null;
  if (start >= file.size) throw new Error('The NIfTI image is truncated.');
  const output = new Uint8Array(HEADER_PREFIX_BYTES);
  let offset = 0;
  let target = HEADER_PREFIX_BYTES;
  let done = false;
  const inflater = new Inflate((chunk, final) => {
    if (offset < HEADER_PREFIX_BYTES) {
      const take = Math.min(chunk.byteLength, HEADER_PREFIX_BYTES - offset);
      output.set(chunk.subarray(0, take), offset);
      offset += take;
      if (target === HEADER_PREFIX_BYTES && offset >= 4) {
        target = targetHeaderBytes(output, offset);
      }
    }
    if (final) done = true;
  });
  let position = start;
  while (offset < target && !done && position < file.size) {
    const end = Math.min(position + GZIP_CHUNK_BYTES, file.size);
    const slice = await readSlice(file, position, end, isCurrent);
    if (!slice) return null;
    position = end;
    inflater.push(slice, position >= file.size);
    if (inflater.s?.f && !inflater.s.l) break;
  }
  return output.buffer.slice(0, offset);
}

// Reads only the header prefix of a NIfTI File/Blob without copying or inflating
// the full voxel payload. Returns null when cancelled before completion.
async function readHeaderBytes(file, isCurrent) {
  const head = await readSlice(file, 0, HEADER_PREFIX_BYTES, isCurrent);
  if (!head) return null;
  if (head.byteLength < 2 || head[0] !== 0x1f || head[1] !== 0x8b) {
    return head.buffer.slice(head.byteOffset, head.byteOffset + head.byteLength);
  }
  return inflateGzipHeaderPrefix(file, isCurrent);
}

// Validates the original untouched NIfTI header (before NiiVue normalizes zero
// or non-finite pixDims to 1) and returns the millimetre world affine, or null
// if the load is cancelled while reading.
export async function readFileWorldAffine(file, { isCurrent = () => true } = {}) {
  const bytes = await readHeaderBytes(file, isCurrent);
  if (!bytes || !isCurrent()) return null;
  const header = readVolumeHeader(bytes);
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
