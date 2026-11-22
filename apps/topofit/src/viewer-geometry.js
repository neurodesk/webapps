import { readVolumeHeader, resolveWorldAffine } from '@neurodesk/topofit';

const HEADER_PREFIX_BYTES = 544;
const MIN_NIFTI_HEADER_BYTES = 348;
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

async function scanPastZeroByte(file, startOffset) {
  let offset = startOffset;
  while (offset < file.size) {
    const end = Math.min(offset + GZIP_SCAN_BYTES, file.size);
    const view = new Uint8Array(await file.slice(offset, end).arrayBuffer());
    const zeroIndex = view.indexOf(0);
    if (zeroIndex >= 0) return offset + zeroIndex + 1;
    offset = end;
  }
  throw new Error('The NIfTI gzip header is truncated.');
}

async function findGzipPayloadOffset(file) {
  if (file.size < 10) throw new Error('The NIfTI image is truncated.');
  const fixed = new Uint8Array(await file.slice(0, 10).arrayBuffer());
  if (fixed[0] !== 0x1f || fixed[1] !== 0x8b || fixed[2] !== 0x08 || (fixed[3] & 0xe0) !== 0) {
    throw new Error('The NIfTI gzip header is invalid.');
  }
  const flags = fixed[3];
  let offset = 10;
  if (flags & 0x04) {
    if (offset + 2 > file.size) throw new Error('The NIfTI gzip header is truncated.');
    const lenBytes = new Uint8Array(await file.slice(offset, offset + 2).arrayBuffer());
    const extraLength = lenBytes[0] | (lenBytes[1] << 8);
    offset += 2 + extraLength;
    if (offset > file.size) throw new Error('The NIfTI gzip header is truncated.');
  }
  if (flags & 0x08) offset = await scanPastZeroByte(file, offset);
  if (flags & 0x10) offset = await scanPastZeroByte(file, offset);
  if (flags & 0x02) {
    offset += 2;
    if (offset > file.size) throw new Error('The NIfTI gzip header is truncated.');
  }
  return offset;
}

// Inflates only the NIfTI header prefix from a gzipped File/Blob by feeding
// fixed-size 256-byte slices sequentially into raw DEFLATE, draining any output
// produced by each slice before reading the next. This bounds every slice to
// 256 compressed bytes (~256 KiB max expansion), never re-reads earlier bytes,
// and skips the gzip CRC32 trailer so bad-CRC scans match readVolume().
async function inflateGzipHeaderPrefix(file) {
  const start = await findGzipPayloadOffset(file);
  if (start >= file.size) throw new Error('The NIfTI image is truncated.');
  const decompressor = new DecompressionStream('deflate-raw');
  const writer = decompressor.writable.getWriter();
  const reader = decompressor.readable.getReader();
  const output = new Uint8Array(HEADER_PREFIX_BYTES);
  let offset = 0;
  let position = start;
  let pendingRead = reader.read();

  const channel = typeof MessageChannel === 'function' ? new MessageChannel() : null;
  let nextTurnId = 0;

  const consumeChunk = (value) => {
    const take = Math.min(value.byteLength, HEADER_PREFIX_BYTES - offset);
    output.set(value.subarray(0, take), offset);
    offset += take;
  };

  const waitNextTurn = (afterWrite) => {
    let cancelled = false;
    let timer;
    const promise = afterWrite.then(() => {
      if (cancelled) return new Promise(() => {});
      if (channel) {
        const id = (nextTurnId += 1);
        return new Promise((resolve) => {
          channel.port1.onmessage = (event) => {
            if (event.data === id) resolve({ kind: 'next' });
          };
          channel.port2.postMessage(id);
        });
      }
      return new Promise((resolve) => {
        timer = setTimeout(() => resolve({ kind: 'next' }), 0);
      });
    });
    return {
      promise,
      cancel: () => {
        cancelled = true;
        clearTimeout(timer);
        if (channel) channel.port1.onmessage = null;
      },
    };
  };

  try {
    let streamDone = false;
    while (offset < HEADER_PREFIX_BYTES && position < file.size && !streamDone) {
      const end = Math.min(position + GZIP_CHUNK_BYTES, file.size);
      const chunk = new Uint8Array(await file.slice(position, end).arrayBuffer());
      position = end;
      const writeSettled = writer.write(chunk).catch(() => {});
      while (offset < HEADER_PREFIX_BYTES && !streamDone) {
        const nextTurn = waitNextTurn(writeSettled);
        const turn = await Promise.race([
          pendingRead.then(
            (result) => ({ kind: 'read', result }),
            (error) => ({ kind: 'error', error }),
          ),
          nextTurn.promise,
        ]);
        nextTurn.cancel();
        if (turn.kind === 'next') break;
        if (turn.kind === 'error') {
          if (offset >= MIN_NIFTI_HEADER_BYTES) {
            streamDone = true;
            break;
          }
          throw turn.error;
        }
        if (turn.result.done) {
          streamDone = true;
          break;
        }
        consumeChunk(turn.result.value);
        if (offset < HEADER_PREFIX_BYTES) pendingRead = reader.read();
      }
    }
    if (offset < HEADER_PREFIX_BYTES && !streamDone) {
      writer.close().catch(() => {});
      while (offset < HEADER_PREFIX_BYTES) {
        let result;
        try {
          result = await pendingRead;
        } catch (error) {
          if (offset >= MIN_NIFTI_HEADER_BYTES) break;
          throw error;
        }
        if (result.done) break;
        consumeChunk(result.value);
        if (offset < HEADER_PREFIX_BYTES) pendingRead = reader.read();
      }
    }
  } finally {
    channel?.port1.close();
    channel?.port2.close();
    pendingRead.catch(() => {});
    await reader.cancel().catch(() => {});
    await writer.abort().catch(() => {});
  }
  return output.buffer.slice(0, offset);
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
