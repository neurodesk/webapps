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

// The apps start the affine from aligned image centres (Greedy's `-ia-image-centers`),
// as they always have; the command line defaults to Greedy's identity start.
export function registerGreedy({ api, fixed, moving, mode = "affine", iterations = "100x50x10", onProgress = () => {} }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  if (!new Set(["affine", "deformable"]).has(mode)) throw new Error("Registration mode must be affine or deformable.");
  onProgress("Running affine NMI registration");
  const fixedBytes = bytes(fixed);
  const movingBytes = bytes(moving);
  const matrix = api.register_affine_wasm(fixedBytes, movingBytes, "NMI", iterations, true);
  if (mode === "affine") {
    onProgress("Reslicing the moving image");
    return { image: api.reslice_affine(fixedBytes, movingBytes, matrix), matrix, warp: null };
  }
  onProgress("Affine complete; running deformable NMI registration");
  const warp = api.register_nmi_svf_wasm(fixedBytes, movingBytes, matrix, iterations);
  onProgress("Reslicing the moving image");
  return { image: api.reslice_warp_affine(fixedBytes, movingBytes, warp, matrix), matrix, warp };
}

export function registerAffineGreedy({ api, fixed, moving, iterations = "100x50x10" }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  return api.register_affine_wasm(bytes(fixed), bytes(moving), "NMI", iterations, true);
}

// A rigid (6 DOF) NMI registration from the identity, so from the scanner alignment.
export function registerRigidGreedy({ api, fixed, moving, iterations = "100x50x10" }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  return api.register_rigid_masked_wasm(bytes(fixed), bytes(moving), null, "NMI", iterations, false, null);
}

// `greedy -sv -m METRIC [-gm MASK] -it MATRIX`: the stationary-velocity warp (raw .nii, physical
// LPS displacement on the fixed grid) that acts before `matrix`, Greedy's RAS text mapping fixed
// points to moving points. `mask`, raw .nii bytes on the fixed grid, limits where the metric counts.
export function registerSvfGreedy({ api, fixed, moving, matrix, mask = null, metric = "NCC 2x2x2", iterations = "100x50x0" }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  return api.register_svf_masked_wasm(bytes(fixed), bytes(moving), mask === null ? null : bytes(mask), matrix, metric, iterations);
}

export function resliceGreedy({ api, fixed, moving, registration, precedingMatrix = null, interpolation = "linear", fill = 0 }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  if (!registration?.matrix || !registration?.warp) throw new Error("Greedy deformable transforms are required.");
  if (!new Set(["linear", "nearest"]).has(interpolation) || !Number.isFinite(fill)) throw new Error("Invalid resampling settings.");
  return api.reslice_warp_affine_options(
    bytes(fixed),
    bytes(moving),
    bytes(registration.warp),
    registration.matrix,
    precedingMatrix,
    interpolation === "nearest",
    fill,
  );
}

export function resliceAffineGreedy({ api, fixed, moving, matrix, interpolation = "linear", fill = 0 }) {
  if (!api) throw new Error("Greedy WebAssembly is not initialized.");
  if (!matrix) throw new Error("A Greedy affine transform is required.");
  if (!new Set(["linear", "nearest"]).has(interpolation) || !Number.isFinite(fill)) throw new Error("Invalid resampling settings.");
  return api.reslice_affine_options(bytes(fixed), bytes(moving), matrix, interpolation === "nearest", fill);
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
