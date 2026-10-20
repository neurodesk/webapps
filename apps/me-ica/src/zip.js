// Store-only ZIP (no compression: the NIfTI outputs are already gzipped) for "download all".

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** A ZIP archive of `{ name, bytes }` entries, dated 1980-01-01 so it is reproducible. */
export function zipStore(files) {
  const encoder = new TextEncoder();
  const entries = files.map((f) => ({ name: encoder.encode(f.name), bytes: f.bytes, crc: crc32(f.bytes) }));
  const size = entries.reduce((n, e) => n + 30 + e.name.length + e.bytes.length + 46 + e.name.length, 22);
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const u16 = (v) => { view.setUint16(at, v, true); at += 2; };
  const u32 = (v) => { view.setUint32(at, v, true); at += 4; };
  const header = (e, central) => {
    u32(central ? 0x02014b50 : 0x04034b50);
    if (central) u16(20);
    u16(20); u16(0x0800); u16(0); u16(0); u16(0x0021); // version, UTF-8 names, stored, 00:00, 1980-01-01
    u32(e.crc); u32(e.bytes.length); u32(e.bytes.length); u16(e.name.length); u16(0);
  };
  for (const e of entries) {
    e.offset = at;
    header(e, false);
    out.set(e.name, at); at += e.name.length;
    out.set(e.bytes, at); at += e.bytes.length;
  }
  const directory = at;
  for (const e of entries) {
    header(e, true);
    u16(0); u16(0); u16(0); u32(0); u32(e.offset); // comment, disk, attributes, offset
    out.set(e.name, at); at += e.name.length;
  }
  const directorySize = at - directory;
  u32(0x06054b50); u16(0); u16(0); u16(entries.length); u16(entries.length);
  u32(directorySize); u32(directory); u16(0);
  return out;
}
