// A minimal animated GIF89a encoder for grey images: one 256-level grey palette, LZW
// compression, frames looped forever.

/** GIF bytes of `frames` (each width × height palette indices, 0 black to 255 white). */
export function encodeGif({ width, height, frames, delay = 15 }) {
  const out = [];
  const byte = (b) => out.push(b & 255);
  const word = (w) => {
    byte(w);
    byte(w >> 8);
  };
  for (const c of "GIF89a") byte(c.charCodeAt(0));
  word(width);
  word(height);
  byte(0xf7); // global colour table of 256 entries
  byte(0);
  byte(0);
  for (let i = 0; i < 256; i++) {
    byte(i);
    byte(i);
    byte(i);
  }
  // Loop forever (NETSCAPE2.0 application extension).
  out.push(0x21, 0xff, 11, ..."NETSCAPE2.0".split("").map((c) => c.charCodeAt(0)), 3, 1, 0, 0, 0);
  for (const frame of frames) {
    if (frame.length !== width * height) throw new Error("A GIF frame has the wrong size.");
    out.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0); // graphic control: delay in 1/100 s
    byte(0x2c);
    word(0);
    word(0);
    word(width);
    word(height);
    byte(0);
    byte(8); // LZW minimum code size
    const data = lzw(frame);
    for (let i = 0; i < data.length; i += 255) {
      const block = data.subarray(i, i + 255);
      byte(block.length);
      for (const b of block) out.push(b);
    }
    byte(0);
  }
  byte(0x3b);
  return Uint8Array.from(out);
}

/** GIF's variable-width LZW of 8-bit indices (clear code 256, end 257, codes up to 12 bits). */
export function lzw(indices) {
  const CLEAR = 256;
  const END = 257;
  const bytes = [];
  let buffer = 0;
  let bits = 0;
  let size = 9;
  const emit = (code) => {
    buffer |= code << bits;
    bits += size;
    while (bits >= 8) {
      bytes.push(buffer & 255);
      buffer >>>= 8;
      bits -= 8;
    }
  };
  let table = new Map();
  let next = END + 1;
  emit(CLEAR);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const code = table.get(key);
    if (code !== undefined) {
      prefix = code;
      continue;
    }
    emit(prefix);
    if (next < 4096) {
      table.set(key, next++);
      if (next > 1 << size && size < 12) size++;
    } else {
      emit(CLEAR);
      table = new Map();
      next = END + 1;
      size = 9;
    }
    prefix = k;
  }
  emit(prefix);
  emit(END);
  if (bits > 0) bytes.push(buffer & 255);
  return Uint8Array.from(bytes);
}
