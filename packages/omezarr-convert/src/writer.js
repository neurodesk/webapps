// Convert a source (see sources/source.js) to an OME-Zarr image, one plane at a time: each
// plane is read once (t, then z, then channel, so a reader decodes an RGB page once), cut into
// chunks at every pyramid level and released, so memory holds one plane and its smaller
// copies whatever the image size. Chunks are (1, 1, 1, Y, X) tiles, padded with the fill
// value 0 at the image edge as Zarr requires. The page thread is handed back between chunks
// (pacing.js), so a conversion in a browser tab can be cancelled and shows its progress.
import { gzipSync, zlibSync } from "fflate";
import { pacer } from "./pacing.js";
import { AXES, arrayDocument, chunkKey, groupDocuments, multiscalesEntry, omeroMetadata, VERSIONS } from "./ngff.js";
import { ARRAY_TYPES, downsamplePlane, levelShapes, METHODS } from "./pyramid.js";
import pkg from "../package.json" with { type: "json" };

export const GENERATOR = Object.freeze({ name: "omezarr-convert", version: pkg.version });

export const DEFAULTS = Object.freeze({ version: "0.5", method: "mean", chunk: 256, compressionLevel: 6 });

/** The options a conversion runs with, completed and checked. */
export function conversionOptions(options = {}) {
  const merged = { ...DEFAULTS, ...options };
  if (!VERSIONS.includes(merged.version)) throw new Error(`OME-NGFF ${merged.version} is not supported; choose 0.4 or 0.5.`);
  if (!METHODS.includes(merged.method)) throw new Error(`Unknown downsampling method ${merged.method}.`);
  for (const key of ["chunk", "compressionLevel"]) {
    if (!Number.isSafeInteger(merged[key])) throw new Error(`${key} must be an integer.`);
  }
  if (merged.chunk < 16 || merged.chunk > 4096) throw new Error("The chunk size must be between 16 and 4096 pixels.");
  if (merged.compressionLevel < 0 || merged.compressionLevel > 9) throw new Error("The compression level must be between 0 and 9.");
  merged.target = options.target ?? merged.chunk;
  return merged;
}

/** Level shapes and chunk shapes (5D) a conversion of `shape` writes. */
export function conversionPlan(shape, options) {
  const { chunk, target } = conversionOptions(options);
  return levelShapes(shape.y, shape.x, target).map(([height, width]) => ({
    shape: [shape.t, shape.c, shape.z, height, width],
    chunks: [1, 1, 1, Math.min(chunk, height), Math.min(chunk, width)],
  }));
}

// Worst-case bytes added to one chunk by its codec (deflate stored blocks: 5 bytes per 65 535,
// plus the gzip or zlib header and trailer) and by its zip entry (local header, data
// descriptor and central directory record, with its key twice).
const CODEC_OVERHEAD = (bytes) => Math.ceil(bytes / 65535) * 5 + 18;
const ENTRY_OVERHEAD = 256;
const METADATA_BYTES = 65536;

/**
 * The most a conversion of `shape` can write: every chunk of every level at its padded size
 * if it does not compress at all, with codec and zip overhead (`bytes`), and the number of
 * store files (`entries`). Checked before an archive is built in memory.
 */
export function archiveBudget(shape, dtype, options) {
  const ArrayType = ARRAY_TYPES[dtype];
  if (!ArrayType) throw new Error(`Pixel type ${dtype} is not supported.`);
  const plan = conversionPlan(shape, options);
  let bytes = METADATA_BYTES;
  // The group's metadata files (.zgroup and .zattrs, or zarr.json) and one per level.
  let entries = (conversionOptions(options).version === "0.4" ? 2 : 1) + plan.length;
  for (const { shape: [t, c, z, height, width], chunks: [, , , chunkHeight, chunkWidth] } of plan) {
    const count = t * c * z * Math.ceil(height / chunkHeight) * Math.ceil(width / chunkWidth);
    const chunkBytes = chunkHeight * chunkWidth * ArrayType.BYTES_PER_ELEMENT;
    bytes += count * (chunkBytes + CODEC_OVERHEAD(chunkBytes) + ENTRY_OVERHEAD);
    entries += count;
  }
  return { bytes, entries };
}

function encoder(version, level) {
  return version === "0.4" ? (bytes) => zlibSync(bytes, { level }) : (bytes) => gzipSync(bytes, { level, mtime: 0 });
}

/**
 * Write `source` to `store` ({ set(key, bytes) }, keys relative to the image root).
 * `maxBytes` stops the conversion once the store passes it. Returns the plan, per-channel
 * level-0 ranges of the finite values, and the counts written.
 */
export async function writeOmeZarr(source, store, options = {}, { signal, onProgress, maxBytes = Infinity } = {}) {
  const settings = conversionOptions(options);
  const { version, method, compressionLevel } = settings;
  const { shape, dtype } = source;
  const ArrayType = ARRAY_TYPES[dtype];
  if (!ArrayType) throw new Error(`Pixel type ${dtype} is not supported.`);
  for (const key of AXES) {
    if (!Number.isSafeInteger(shape[key]) || shape[key] < 1) throw new Error(`The image size along ${key} must be a positive integer.`);
  }
  if (source.channels.length !== shape.c) throw new Error(`The source names ${source.channels.length} channels for ${shape.c}.`);
  const plan = conversionPlan(shape, settings);
  const encode = encoder(version, compressionLevel);
  // Windows cover finite values only: NaN and ±Infinity have no place in omero's JSON window.
  const windows = Array.from({ length: shape.c }, () => [Infinity, -Infinity]);
  const float = dtype.startsWith("float");
  const pace = pacer(signal);
  const planes = shape.t * shape.c * shape.z;
  let done = 0;
  let chunksWritten = 0;
  let bytesWritten = 0;
  const put = async (key, bytes) => {
    if (bytesWritten + bytes.byteLength > maxBytes) throw new Error(`The OME-Zarr store passed its limit of ${maxBytes} bytes; write it to a folder instead.`);
    await store.set(key, bytes);
    bytesWritten += bytes.byteLength;
  };

  for (let t = 0; t < shape.t; t += 1) {
    for (let z = 0; z < shape.z; z += 1) {
      for (let c = 0; c < shape.c; c += 1) {
        signal?.throwIfAborted();
        let plane = await source.readPlane(t, c, z, { signal });
        signal?.throwIfAborted();
        if (!(plane instanceof ArrayType) || plane.length !== shape.y * shape.x) {
          throw new Error(`Plane t=${t} c=${c} z=${z} is not ${shape.y} × ${shape.x} ${dtype}.`);
        }
        const window = windows[c];
        for (let i = 0; i < plane.length; i += 1) {
          const value = plane[i];
          if (float && !Number.isFinite(value)) continue;
          if (value < window[0]) window[0] = value;
          if (value > window[1]) window[1] = value;
        }
        for (let level = 0; level < plan.length; level += 1) {
          const [, , , height, width] = plan[level].shape;
          const [, , , chunkHeight, chunkWidth] = plan[level].chunks;
          for (let cy = 0; cy * chunkHeight < height; cy += 1) {
            for (let cx = 0; cx * chunkWidth < width; cx += 1) {
              const tile = new ArrayType(chunkHeight * chunkWidth);
              const rows = Math.min(chunkHeight, height - cy * chunkHeight);
              const columns = Math.min(chunkWidth, width - cx * chunkWidth);
              for (let row = 0; row < rows; row += 1) {
                const start = (cy * chunkHeight + row) * width + cx * chunkWidth;
                tile.set(plane.subarray(start, start + columns), row * chunkWidth);
              }
              await put(chunkKey(version, level, [t, c, z, cy, cx]), encode(new Uint8Array(tile.buffer)));
              chunksWritten += 1;
              await pace();
            }
          }
          if (level + 1 < plan.length) plane = downsamplePlane(plane, height, width, method, dtype);
        }
        done += 1;
        onProgress?.(done / planes, { t, c, z });
      }
    }
  }

  const ranges = windows.map(([min, max]) => (min <= max ? [min, max] : [0, 0]));
  for (let level = 0; level < plan.length; level += 1) {
    const [name, bytes] = arrayDocument(version, { ...plan[level], dtype, level: compressionLevel });
    await put(`${level}/${name}`, bytes);
  }
  const multiscales = multiscalesEntry({ name: source.name, scale: source.scale, units: source.units, levels: plan.length, method, generator: GENERATOR });
  const omero = omeroMetadata(source.channels, ranges, shape.z);
  for (const [name, bytes] of Object.entries(groupDocuments(version, multiscales, omero))) await put(name, bytes);
  return { version, method, plan, ranges, chunksWritten, bytesWritten, multiscales, omero };
}
