// Structural disconnection in the browser: open a TVX atlas once, query a lesion mask against
// every tract. The WebAssembly module is nii2tvx.c compiled with no filesystem and no zlib, so
// this wrapper owns decompression and the memory rules the C side documents:
//
//   - HEAPU8 is replaced whenever WASM memory grows, so it is never cached across a call.
//   - tvx_open keeps the buffer it is handed and frees it in tvx_close; mask_open copies out of
//     its buffer, so that one is freed immediately.
//   - The only channel for a failure reason is stderr, so printErr is captured and attached to
//     the thrown error.
import createModule from '../wasm/nii2tvx.mjs';

const GZIP = [0x1f, 0x8b];

export async function gunzip(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (input[0] !== GZIP[0] || input[1] !== GZIP[1]) return input;
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** C's printf("%g") for a float, default precision 6, so a browser TSV matches the CLI's byte
 *  for byte. Number(x.toPrecision(6)) does not: it prints NaN as "NaN", writes 3.24086e-05 as
 *  0.0000324086 (JavaScript only uses exponent form below 1e-6), and 1e-7 rather than 1e-07. */
export function formatG(x) {
  if (Number.isNaN(x)) return 'nan';
  if (x === 0) return '0';
  if (!Number.isFinite(x)) return x > 0 ? 'inf' : '-inf';
  const exponent = Number(x.toExponential(5).split('e')[1]);
  const strip = (s) => (s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s);
  if (exponent < -4 || exponent >= 6) {
    const [mantissa, e] = x.toExponential(5).split('e');
    return `${strip(mantissa)}e${e.startsWith('-') ? '-' : '+'}${e.replace(/^[-+]/, '').padStart(2, '0')}`;
  }
  return strip(x.toFixed(Math.max(0, 5 - exponent)));
}

/** _malloc returns 0 when the heap is exhausted, and the module is built without
 *  ABORTING_MALLOC, so an unchecked write would land on address 0 — ordinary writable memory
 *  holding the shadow stack and static data — and corrupt the module instead of failing.
 */
function allocate(module, bytes) {
  const pointer = module._malloc(bytes.length);
  if (!pointer) throw new Error(`Out of memory: ${bytes.length} bytes for the tract atlas.`);
  module.HEAPU8.set(bytes, pointer);
  return pointer;
}

/** Read a NUL-terminated C string as UTF-8.
 *
 *  Not `Module.UTF8ToString`: for names longer than 16 bytes that hands a view of the WASM
 *  heap to `TextDecoder`, and a growable `WebAssembly.Memory` backs a resizable ArrayBuffer,
 *  which `TextDecoder.decode` rejects in the browser. Copying first is the whole fix. The
 *  HCP1065 names are all shorter than the threshold, so only a long-named atlas hits it.
 */
function readName(module, pointer) {
  const heap = module.HEAPU8;
  let end = pointer;
  while (heap[end]) end += 1;
  return new TextDecoder().decode(heap.slice(pointer, end));
}

/** The CLI's table: a header of tract names, then one row per lesion. */
export function toTsv(tracts, rows) {
  return [['id', ...tracts].join('\t'), ...rows.map(({ id, fractions }) => [id, ...Array.from(fractions, formatG)].join('\t'))]
    .join('\n') + '\n';
}

/**
 * @param {Uint8Array|ArrayBuffer} atlas  a .tvx file, gzipped or not
 * @returns {Promise<{tracts: string[], query: (lesion: Uint8Array|ArrayBuffer) => Float32Array, close: () => void}>}
 */
export async function openAtlas(atlas) {
  const log = [];
  const module = await createModule({ printErr: (line) => log.push(line) });
  const reason = (fallback) => new Error(log.length ? log[log.length - 1] : fallback);

  const bytes = await gunzip(atlas);
  const atlasPtr = allocate(module, bytes);
  log.length = 0;
  const handle = module._tvx_open(atlasPtr, bytes.length); // takes ownership of atlasPtr
  if (!handle) throw reason('Not a valid TVX atlas.');

  const count = module._tvx_ntract(handle);
  const tracts = Array.from({ length: count }, (_, k) => readName(module, module._tvx_name(handle, k)));
  let closed = false;

  return {
    tracts,
    async query(lesion) {
      if (closed) throw new Error('This atlas is closed.');
      const nii = await gunzip(lesion); // mask_open does not inflate
      if (closed) throw new Error('This atlas is closed.');
      const niiPtr = allocate(module, nii);
      log.length = 0;
      const mask = module._mask_open(niiPtr, nii.length);
      module._free(niiPtr);
      if (!mask) throw reason('Could not read the lesion mask.');
      try {
        const fractions = new Float32Array(count);
        for (let k = 0; k < count; k += 1) {
          const fraction = module._tvx_query(handle, k, mask);
          // -1 is a grid mismatch or a corrupt stream, and is fatal for every tract in the
          // file. NaN is not an error: that tract simply has no streamlines in the volume.
          if (fraction < 0) throw reason('This lesion does not match the atlas grid.');
          fractions[k] = fraction;
        }
        return fractions;
      } finally {
        module._mask_close(mask);
      }
    },
    close() {
      if (closed) return;
      closed = true;
      module._tvx_close(handle);
    },
  };
}
