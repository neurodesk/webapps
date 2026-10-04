// Full-volume activations can exceed Chromium's per-ArrayBuffer limit. Keep
// channel-major offsets unchanged while bounding each backing allocation.
export function createActivationStorage(length, chunkLength = 16 * 1024 * 1024) {
  if (length <= chunkLength) return new Float32Array(length);
  const chunks = [];
  for (let offset = 0; offset < length; offset += chunkLength) {
    chunks.push(new Float32Array(Math.min(chunkLength, length - offset)));
  }
  const storage = {
    length,
    set(source, offset = 0) {
      if (offset < 0 || offset + source.length > length) throw new RangeError('Activation write exceeds storage.');
      let copied = 0;
      while (copied < source.length) {
        const position = offset + copied;
        const chunk = chunks[Math.floor(position / chunkLength)];
        const within = position % chunkLength;
        const count = Math.min(source.length - copied, chunk.length - within);
        chunk.set(source.subarray(copied, copied + count), within);
        copied += count;
      }
    },
    subarray(start, end) {
      if (start === end) return new Float32Array(0);
      const first = Math.floor(start / chunkLength);
      if (first === Math.floor((end - 1) / chunkLength)) {
        return chunks[first].subarray(start % chunkLength, start % chunkLength + end - start);
      }
      const result = new Float32Array(end - start);
      let copied = 0;
      while (start + copied < end) {
        const position = start + copied;
        const chunk = chunks[Math.floor(position / chunkLength)];
        const within = position % chunkLength;
        const count = Math.min(end - position, chunk.length - within);
        result.set(chunk.subarray(within, within + count), copied);
        copied += count;
      }
      return result;
    },
    slice(start, end) {
      return storage.subarray(start, end).slice();
    },
  };
  return storage;
}
