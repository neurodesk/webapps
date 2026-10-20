// Glue for ./dwidenoise.wasm (exes/dwi/denoise-wasm): a plain C ABI, no wasm-bindgen.
//
// Patch2Self (DIPY 1.12.1 version 1, patch radius 0, OLS). Data is volume-major Float32, as in
// NIfTI: voxel v of volume t is at t * nvox + v, first spatial index fastest. The computation is
// f64; only the stored result is f32.

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadDwidenoise(source) {
  const wasm = await instantiate(await source);
  const B0_THRESHOLD = wasm.b0_threshold();

  /**
   * Splits the volumes into b0 (b below B0_THRESHOLD) and diffusion-weighted volumes.
   * Throws when there are fewer than 2 diffusion-weighted volumes.
   */
  function groups(bvals) {
    const b0 = [];
    const dwi = [];
    bvals.forEach((b, t) => {
      if (!Number.isFinite(b)) throw new Error(`The b-value of volume ${t} is not a number.`);
      (b < B0_THRESHOLD ? b0 : dwi).push(t);
    });
    if (dwi.length < 2) {
      throw new Error(
        `Patch2Self needs at least 2 diffusion-weighted volumes (b >= ${B0_THRESHOLD} s/mm²). This data has ${dwi.length}.`,
      );
    }
    return { b0, dwi };
  }

  /** The groups that are fitted: those with two or more volumes. A single b0 is left unchanged. */
  function fittedGroups(bvals) {
    const { b0, dwi } = groups(bvals);
    return [b0, dwi].filter((g) => g.length >= 2);
  }

  /**
   * Float32 storage of `length` values in the module's memory. Decode the volumes straight into
   * `view()` so the page holds one copy of the data. Call `view()` again after any other call:
   * the module's memory can grow, which detaches earlier views.
   */
  function allocate(length) {
    const bytes = length * 4;
    const ptr = wasm.alloc(bytes) >>> 0;
    let freed = false;
    return {
      ptr,
      length,
      view: () => {
        if (freed) throw new Error("This buffer was freed.");
        return new Float32Array(wasm.memory.buffer, ptr, length);
      },
      free: () => {
        if (!freed) wasm.dealloc(ptr, bytes);
        freed = true;
      },
    };
  }

  function withF64(length, fill, use) {
    const bytes = length * 8;
    const ptr = wasm.alloc(bytes) >>> 0;
    try {
      if (fill) new Float64Array(wasm.memory.buffer, ptr, length).set(fill);
      return use(ptr);
    } finally {
      wasm.dealloc(ptr, bytes);
    }
  }

  function withGroup(group, use) {
    const bytes = group.length * 4;
    const ptr = wasm.alloc(bytes) >>> 0;
    try {
      new Uint32Array(wasm.memory.buffer, ptr, group.length).set(group);
      return use(ptr);
    } finally {
      wasm.dealloc(ptr, bytes);
    }
  }

  function volumesOf(buffer, nvox) {
    if (!Number.isInteger(nvox) || nvox <= 0 || buffer.length % nvox !== 0) {
      throw new Error(`The buffer of ${buffer.length} values is not a whole number of ${nvox}-voxel volumes.`);
    }
    return buffer.length / nvox;
  }

  /**
   * Adds the Gram sums of voxels first..first + count of the volumes in `group` to `gram`
   * (a Float64Array of gramLength(group.length) values; partial sums of separate voxel ranges
   * add element by element).
   */
  function accumulate(buffer, nvox, group, gram, first = 0, count = nvox) {
    const volumes = volumesOf(buffer, nvox);
    if (!Number.isSafeInteger(first) || !Number.isSafeInteger(count) || first < 0 || count < 0 || first + count > nvox) {
      throw new Error("Invalid voxel range or volume group.");
    }
    // Check the complete input range, including a single b0 that is copied without fitting.
    const data = buffer.view();
    for (let t = 0; t < volumes; t++) {
      for (let v = first; v < first + count; v++) {
        if (!Number.isFinite(data[t * nvox + v])) {
          throw new Error("The data holds values that are not finite numbers (NaN or infinity).");
        }
      }
    }
    const n = group.length;
    if (gram.length !== gramLength(n)) throw new Error(`The Gram matrix needs ${gramLength(n)} values.`);
    const status = withGroup(group, (g) =>
      withF64(gram.length, gram, (ptr) => {
        const s = wasm.gram_accumulate(buffer.ptr, nvox, volumes, first, count, g, n, ptr);
        if (s === 0) gram.set(new Float64Array(wasm.memory.buffer, ptr, gram.length));
        return s;
      }),
    );
    if (status !== 0) throw new Error("Invalid voxel range or volume group.");
    return gram;
  }

  /** The regression coefficients of `group` from its Gram matrix. */
  function solve(gram, group) {
    const n = group.length;
    const length = wasm.coefficients_length(n);
    return withF64(gram.length, gram, (g) =>
      withF64(length, null, (ptr) => {
        const status = wasm.solve_coefficients(g, n, ptr);
        if (status === -1) throw new Error("The data has no voxels.");
        if (status === -2) throw new Error("The data holds values that are not finite numbers (NaN or infinity).");
        if (status > 0) {
          throw new Error(
            `Volume ${group[status - 1]} (counting from 0) is a linear combination of other volumes of its group (for example, a copy of one), so Patch2Self cannot fit it.`,
          );
        }
        return new Float64Array(wasm.memory.buffer, ptr, length).slice();
      }),
    );
  }

  /** Replaces voxels first..first + count of the volumes in `group` with their predictions. */
  function apply(buffer, nvox, group, coefficients, first = 0, count = nvox) {
    const volumes = volumesOf(buffer, nvox);
    const status = withGroup(group, (g) =>
      withF64(coefficients.length, coefficients, (c) =>
        wasm.apply_coefficients(buffer.ptr, nvox, volumes, first, count, g, group.length, c),
      ),
    );
    if (status !== 0) throw new Error("Invalid voxel range or volume group.");
  }

  /**
   * Denoises an allocate()d buffer of bvals.length volumes of nvox voxels, in place.
   * @param options.chunk voxels per call (progress is reported between calls)
   * @param options.onProgress called with (done, total) work units
   */
  function denoise(buffer, nvox, bvals, { chunk = 65536, onProgress } = {}) {
    if (buffer.length !== nvox * bvals.length) {
      throw new Error(
        `Expected ${nvox * bvals.length} values (${nvox} voxels × ${bvals.length} volumes), received ${buffer.length}.`,
      );
    }
    const fitted = fittedGroups(bvals);
    const total = 2 * nvox * fitted.length;
    let done = 0;
    for (const group of fitted) {
      const gram = new Float64Array(gramLength(group.length));
      for (let first = 0; first < nvox; first += chunk) {
        const count = Math.min(chunk, nvox - first);
        accumulate(buffer, nvox, group, gram, first, count);
        onProgress?.((done += count), total);
      }
      const coefficients = solve(gram, group);
      for (let first = 0; first < nvox; first += chunk) {
        const count = Math.min(chunk, nvox - first);
        apply(buffer, nvox, group, coefficients, first, count);
        onProgress?.((done += count), total);
      }
    }
  }

  /** Denoises a copy of `data` (Float32Array, volume-major) and returns it. */
  function denoiseArray(data, nvox, bvals, options) {
    const buffer = allocate(data.length);
    try {
      buffer.view().set(data);
      denoise(buffer, nvox, bvals, options);
      return buffer.view().slice();
    } finally {
      buffer.free();
    }
  }

  function gramLength(n) {
    return wasm.gram_length(n);
  }

  return { B0_THRESHOLD, groups, fittedGroups, allocate, accumulate, solve, apply, denoise, denoiseArray, gramLength };
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}
