// Minimal random-access ZIP reader built on Blob.slice / Uint8Array.subarray and fflate.Inflate.
// Reads only the central directory on open and slices + inflates individual entries on demand
// with a strict pre-decompression and streaming byte cap, avoiding loading multi-GB archives into RAM.
import { Inflate } from 'fflate';

const EOCD_SIG = 0x06054b50;
const ZIP64_LOCATOR_SIG = 0x07064b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const CD_ENTRY_SIG = 0x02014b50;
const LFH_SIG = 0x04034b50;
const MAX_EOCD_SCAN = 65557; // 22-byte EOCD + 65535-byte max comment

const utf8Decoder = new TextDecoder('utf-8');
const latin1Decoder = new TextDecoder('latin1');

function readUint64LE(dv, offset) {
  const lo = dv.getUint32(offset, true);
  const hi = dv.getUint32(offset + 4, true);
  const value = hi * 4294967296 + lo;
  if (!Number.isSafeInteger(value)) {
    throw new Error('ZIP64 offset exceeds JavaScript safe integer range.');
  }
  return value;
}

function makeSliceReader(source) {
  if (source instanceof Uint8Array) {
    return {
      size: source.byteLength,
      readSlice: async (start, end) => source.subarray(start, end),
    };
  }
  if (source instanceof ArrayBuffer) {
    const view = new Uint8Array(source);
    return {
      size: view.byteLength,
      readSlice: async (start, end) => view.subarray(start, end),
    };
  }
  if (source && typeof source.slice === 'function' && typeof source.size === 'number') {
    return {
      size: source.size,
      readSlice: async (start, end) => new Uint8Array(await source.slice(start, end).arrayBuffer()),
    };
  }
  return null;
}

function inflateBounded(compressed, maxBytes, name) {
  const chunks = [];
  let total = 0;
  let overflow = false;
  const inflator = new Inflate((chunk) => {
    total += chunk.byteLength;
    if (total > maxBytes) {
      overflow = true;
      return;
    }
    if (!overflow) chunks.push(chunk);
  });
  inflator.push(compressed, true);
  if (overflow) {
    throw new Error(
      `Archive entry "${name}" exceeded the ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB decompression limit.`,
    );
  }
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1 && chunks[0].byteOffset === 0) return chunks[0];
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.byteLength;
  }
  return out;
}

function parseZip64Extra(extra, uncompSize, compSize, localHeaderOffset) {
  const dv = new DataView(extra.buffer, extra.byteOffset, extra.byteLength);
  let pos = 0;
  while (pos + 4 <= extra.byteLength) {
    const headerId = dv.getUint16(pos, true);
    const dataSize = dv.getUint16(pos + 2, true);
    pos += 4;
    if (pos + dataSize > extra.byteLength) break;
    if (headerId === 0x0001) {
      let cur = pos;
      const end = pos + dataSize;
      if (uncompSize === 0xffffffff && cur + 8 <= end) {
        uncompSize = readUint64LE(dv, cur);
        cur += 8;
      }
      if (compSize === 0xffffffff && cur + 8 <= end) {
        compSize = readUint64LE(dv, cur);
        cur += 8;
      }
      if (localHeaderOffset === 0xffffffff && cur + 8 <= end) {
        localHeaderOffset = readUint64LE(dv, cur);
      }
      break;
    }
    pos += dataSize;
  }
  return { uncompSize, compSize, localHeaderOffset };
}

/**
 * Open a ZIP archive lazily from a `File`, `Blob`, `Uint8Array`, or `ArrayBuffer`.
 * Returns `{ entries, readEntry(name, { maxBytes }) }`.
 */
export async function openLazyZip(source) {
  const reader = makeSliceReader(source);
  if (!reader) {
    throw new Error('Expected a Bruker ParaVision .zip archive or study folder.');
  }
  if (reader.size < 22) {
    throw new Error('Expected a Bruker ParaVision .zip archive or study folder.');
  }

  const head = await reader.readSlice(0, 4);
  const sig0 = head[0] | (head[1] << 8) | (head[2] << 16) | (head[3] << 24);
  if (sig0 !== LFH_SIG && sig0 !== EOCD_SIG) {
    throw new Error('Expected a Bruker ParaVision .zip archive or study folder.');
  }

  const tailLen = Math.min(reader.size, MAX_EOCD_SCAN);
  const tailStart = reader.size - tailLen;
  const tail = await reader.readSlice(tailStart, reader.size);
  const tailDv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);

  let eocdPos = -1;
  for (let i = tailLen - 22; i >= 0; i--) {
    if (tailDv.getUint32(i, true) === EOCD_SIG) {
      const commentLen = tailDv.getUint16(i + 20, true);
      if (i + 22 + commentLen === tailLen) {
        eocdPos = i;
        break;
      }
    }
  }
  if (eocdPos === -1) {
    throw new Error('Invalid ZIP archive: End of Central Directory record not found.');
  }

  let cdEntries = tailDv.getUint16(eocdPos + 10, true);
  let cdSize = tailDv.getUint32(eocdPos + 12, true);
  let cdOffset = tailDv.getUint32(eocdPos + 16, true);

  const eocdAbs = tailStart + eocdPos;
  if (cdEntries === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    if (eocdAbs < 20) {
      throw new Error('Invalid ZIP64 archive: missing ZIP64 locator.');
    }
    const locBytes = await reader.readSlice(eocdAbs - 20, eocdAbs);
    const locDv = new DataView(locBytes.buffer, locBytes.byteOffset, locBytes.byteLength);
    if (locDv.getUint32(0, true) !== ZIP64_LOCATOR_SIG) {
      throw new Error('Invalid ZIP64 archive: bad ZIP64 locator signature.');
    }
    const z64Offset = readUint64LE(locDv, 8);
    const z64Bytes = await reader.readSlice(z64Offset, z64Offset + 56);
    const z64Dv = new DataView(z64Bytes.buffer, z64Bytes.byteOffset, z64Bytes.byteLength);
    if (z64Bytes.byteLength < 56 || z64Dv.getUint32(0, true) !== ZIP64_EOCD_SIG) {
      throw new Error('Invalid ZIP64 archive: bad ZIP64 EOCD record.');
    }
    cdEntries = readUint64LE(z64Dv, 32);
    cdSize = readUint64LE(z64Dv, 40);
    cdOffset = readUint64LE(z64Dv, 48);
  }

  if (cdOffset + cdSize > reader.size) {
    throw new Error('Invalid ZIP archive: central directory extends past end of file.');
  }

  const cdBytes = await reader.readSlice(cdOffset, cdOffset + cdSize);
  const cdDv = new DataView(cdBytes.buffer, cdBytes.byteOffset, cdBytes.byteLength);

  const entries = new Map();
  let pos = 0;
  for (let idx = 0; idx < cdEntries && pos + 46 <= cdBytes.byteLength; idx++) {
    if (cdDv.getUint32(pos, true) !== CD_ENTRY_SIG) {
      throw new Error('Invalid ZIP archive: corrupt central directory entry.');
    }
    const flags = cdDv.getUint16(pos + 8, true);
    const method = cdDv.getUint16(pos + 10, true);
    let compSize = cdDv.getUint32(pos + 20, true);
    let uncompSize = cdDv.getUint32(pos + 24, true);
    const nameLen = cdDv.getUint16(pos + 28, true);
    const extraLen = cdDv.getUint16(pos + 30, true);
    const commentLen = cdDv.getUint16(pos + 32, true);
    let localHeaderOffset = cdDv.getUint32(pos + 42, true);

    const nameStart = pos + 46;
    const extraStart = nameStart + nameLen;
    const nextPos = extraStart + extraLen + commentLen;
    if (nextPos > cdBytes.byteLength) {
      throw new Error('Invalid ZIP archive: truncated central directory entry.');
    }

    const nameBytes = cdBytes.subarray(nameStart, extraStart);
    const name = (flags & 0x0800 ? utf8Decoder : latin1Decoder).decode(nameBytes);

    if (uncompSize === 0xffffffff || compSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const extra = cdBytes.subarray(extraStart, extraStart + extraLen);
      ({ uncompSize, compSize, localHeaderOffset } = parseZip64Extra(
        extra,
        uncompSize,
        compSize,
        localHeaderOffset,
      ));
    }

    entries.set(name, {
      name,
      flags,
      method,
      compSize,
      uncompSize,
      localHeaderOffset,
    });
    pos = nextPos;
  }

  return {
    entries,
    async readEntry(name, { maxBytes = 1024 * 1024 * 1024 } = {}) {
      const entry = entries.get(name);
      if (!entry) throw new Error(`Missing archive entry: ${name}`);
      if (entry.flags & 0x0001) {
        throw new Error(`Encrypted ZIP entry "${name}" is not supported.`);
      }
      if (entry.uncompSize > maxBytes) {
        throw new Error(
          `Archive entry "${name}" (${(entry.uncompSize / (1024 * 1024)).toFixed(1)} MiB) exceeds the ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB browser limit.`,
        );
      }

      const lfh = await reader.readSlice(entry.localHeaderOffset, entry.localHeaderOffset + 30);
      if (lfh.byteLength < 30) {
        throw new Error(`Truncated ZIP local header for "${name}".`);
      }
      const lfhDv = new DataView(lfh.buffer, lfh.byteOffset, lfh.byteLength);
      if (lfhDv.getUint32(0, true) !== LFH_SIG) {
        throw new Error(`Corrupt ZIP local header for "${name}".`);
      }
      const lfhNameLen = lfhDv.getUint16(26, true);
      const lfhExtraLen = lfhDv.getUint16(28, true);
      const dataStart = entry.localHeaderOffset + 30 + lfhNameLen + lfhExtraLen;
      const dataEnd = dataStart + entry.compSize;
      if (dataEnd > reader.size) {
        throw new Error(`Truncated ZIP payload for "${name}".`);
      }

      const compressed = await reader.readSlice(dataStart, dataEnd);
      if (entry.method === 0) {
        if (compressed.byteLength > maxBytes) {
          throw new Error(
            `Archive entry "${name}" exceeds the ${(maxBytes / (1024 * 1024)).toFixed(0)} MiB browser limit.`,
          );
        }
        return compressed;
      }
      if (entry.method === 8) {
        return inflateBounded(compressed, maxBytes, name);
      }
      throw new Error(`Unsupported ZIP compression method ${entry.method} for "${name}".`);
    },
  };
}
