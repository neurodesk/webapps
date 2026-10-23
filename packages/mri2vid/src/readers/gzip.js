// gzip helpers using the web-standard DecompressionStream, available in modern
// browsers and in Node 18+. No dependency, no network.

export function isGzip(bytes) {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

// Ceiling on decompressed output so a crafted "decompression bomb" (a tiny gzip
// that inflates to many GB) cannot OOM or freeze the tab. It is well above any
// legitimate single medical volume. Reading via a reader with a running total,
// and cancelling on overflow, bounds peak memory to roughly this ceiling.
export const MAX_DECOMPRESSED = 1536 * 1024 * 1024; // 1.5 GiB

export async function gunzip(arrayBuffer, maxBytes = MAX_DECOMPRESSED) {
  const ds = new DecompressionStream('gzip');
  const reader = new Blob([arrayBuffer]).stream().pipeThrough(ds).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Decompressed data exceeds the size limit; the file may be corrupt or a decompression bomb.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.byteLength; }
  return out.buffer;
}

export async function maybeGunzip(arrayBuffer) {
  const bytes = new Uint8Array(arrayBuffer);
  return isGzip(bytes) ? await gunzip(arrayBuffer) : arrayBuffer;
}
