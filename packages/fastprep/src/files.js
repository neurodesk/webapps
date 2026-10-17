// In-memory files for one fastprep session: path -> Blob (user inputs, read lazily) or Uint8Array.
// `mtime` is a write counter, enough for the core's resume records within a session.

export class Files {
  #entries = new Map();
  #clock = 0;

  put(path, data) {
    this.#entries.set(path, { data, mtime: ++this.#clock });
  }

  has(path) {
    return this.#entries.has(path);
  }

  size(path) {
    const d = this.#entries.get(path)?.data;
    return d === undefined ? undefined : (d.size ?? d.byteLength);
  }

  stat(path) {
    const e = this.#entries.get(path);
    return e ? [e.data.size ?? e.data.byteLength, e.mtime] : null;
  }

  async bytes(path) {
    const e = this.#entries.get(path);
    if (!e) throw new Error(`${path}: no such file`);
    return e.data instanceof Uint8Array ? e.data : new Uint8Array(await e.data.arrayBuffer());
  }

  /** At most `len` bytes from `offset`: header reads never load a whole Blob. */
  async range(path, offset, len) {
    const e = this.#entries.get(path);
    if (!e) throw new Error(`${path}: no such file`);
    const d = e.data;
    return d instanceof Uint8Array ? d.subarray(offset, offset + len) : new Uint8Array(await d.slice(offset, offset + len).arrayBuffer());
  }

  async text(path) {
    return new TextDecoder().decode(await this.bytes(path));
  }

  /** Paths below `dir`, relative to it. */
  list(dir) {
    const prefix = dir.endsWith('/') ? dir : `${dir}/`;
    return [...this.#entries.keys()].filter((p) => p.startsWith(prefix)).map((p) => p.slice(prefix.length));
  }

  remove(path) {
    this.#entries.delete(path);
  }

  rename(from, to) {
    const e = this.#entries.get(from);
    if (!e) throw new Error(`${from}: no such file`);
    this.#entries.delete(from);
    this.#entries.set(to, { data: e.data, mtime: ++this.#clock });
  }

  copy(from, to) {
    const e = this.#entries.get(from);
    if (!e) throw new Error(`${from}: no such file`);
    this.#entries.set(to, { data: e.data, mtime: ++this.#clock });
  }
}

export const parent = (path) => path.slice(0, path.lastIndexOf('/')) || '/';

export const isGzip = (b) => b.length > 1 && b[0] === 0x1f && b[1] === 0x8b;

async function pipe(bytes, Stream) {
  return new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new Stream('gzip'))).arrayBuffer());
}

export const gunzip = (b) => (isGzip(b) ? pipe(b, DecompressionStream) : b);
export const gzip = (b) => pipe(b, CompressionStream);
/** Bytes as a file of this name expects: gzip for `.gz`. */
export const encodeFor = (path, b) => (path.endsWith('.gz') && !isGzip(b) ? gzip(b) : b);
