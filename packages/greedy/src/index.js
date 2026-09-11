const bytes = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);

export async function loadGreedy(moduleUrl, threads = Math.min(8, navigator.hardwareConcurrency || 1)) {
  if (!self.crossOriginIsolated || typeof SharedArrayBuffer === "undefined") {
    throw new Error("Greedy needs cross-origin isolation for threaded WebAssembly.");
  }
  if (!Number.isInteger(threads) || threads < 1) throw new Error("Greedy thread count must be a positive integer.");
  const api = await import(/* @vite-ignore */ moduleUrl);
  await api.default();
  await api.initThreadPool(threads);
  return api;
}

export function registerGreedy({ api, fixed, moving, mode = "affine", iterations = "100x50x10", onProgress = () => {} }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  if (!new Set(["affine", "deformable"]).has(mode)) throw new Error("Registration mode must be affine or deformable.");
  onProgress("Running affine NMI registration");
  const fixedBytes = bytes(fixed);
  const movingBytes = bytes(moving);
  const matrix = api.register_affine_wasm(fixedBytes, movingBytes, "NMI", iterations);
  if (mode === "affine") {
    onProgress("Reslicing the moving image");
    return { image: api.reslice_affine(fixedBytes, movingBytes, matrix), matrix, warp: null };
  }
  onProgress("Affine complete; running deformable NMI registration");
  const warp = api.register_nmi_svf_wasm(fixedBytes, movingBytes, matrix, iterations);
  onProgress("Reslicing the moving image");
  return { image: api.reslice_warp_affine(fixedBytes, movingBytes, warp, matrix), matrix, warp };
}

export function isGzip(value) {
  const input = bytes(value);
  return input.length >= 2 && input[0] === 0x1f && input[1] === 0x8b;
}

async function gzipStream(value, Stream) {
  const reader = new Blob([bytes(value)]).stream().pipeThrough(new Stream("gzip")).getReader();
  const chunks = [];
  let length = 0;
  for (;;) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
    length += chunk.byteLength;
  }
  const output = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

export async function gunzip(value) {
  return isGzip(value) ? gzipStream(value, DecompressionStream) : bytes(value);
}

export function gzip(value) {
  return gzipStream(value, CompressionStream);
}
