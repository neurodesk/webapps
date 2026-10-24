// Glue for ./noddi.wasm (exes/dwi/noddi-wasm): a plain C ABI, no wasm-bindgen.
// Every typed-array view is taken again after an export call, because a call that grows the
// heap detaches the previous ArrayBuffer.

/** Maps that `dtiFit` returns, in the order the module writes them. */
export const DTI_MAPS = ['FA', 'MD', 'AD', 'RD', 'S0', 'V1x', 'V1y', 'V1z'];

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadNoddi(source) {
  const wasm = await instantiate(await source);
  const text = () => {
    const ptr = wasm.text_ptr();
    return new TextDecoder().decode(new Uint8Array(wasm.memory.buffer, ptr, wasm.text_len()).slice());
  };

  /** Copies a typed array into module memory; returns its pointer and a function that frees it. */
  const copyIn = (values) => {
    const bytes = values.byteLength;
    const ptr = wasm.alloc(bytes);
    new Uint8Array(wasm.memory.buffer, ptr, bytes).set(new Uint8Array(values.buffer, values.byteOffset, bytes));
    return { ptr, free: () => wasm.dealloc(ptr, bytes) };
  };

  const gradientArrays = (bvals, bvecs) => {
    const n = bvals.length;
    if (bvecs.length !== 3 || bvecs.some((row) => row.length !== n)) {
      throw new Error('bvecs must be three rows (x, y, z) with one value per volume.');
    }
    const flat = new Float64Array(3 * n);
    for (let i = 0; i < n; i++) {
      flat[3 * i] = bvecs[0][i];
      flat[3 * i + 1] = bvecs[1][i];
      flat[3 * i + 2] = bvecs[2][i];
    }
    return { n, bvals: Float64Array.from(bvals), bvecs: flat };
  };

  /**
   * The gradient table rules: b0 volumes, shells, the tensor-fit volumes and why NODDI or the
   * tensor fit cannot run (null when they can).
   */
  function describe(bvals, bvecs) {
    const g = gradientArrays(bvals, bvecs);
    const b = copyIn(g.bvals);
    const v = copyIn(g.bvecs);
    try {
      if (wasm.describe(b.ptr, v.ptr, g.n) !== 0) throw new Error(text());
      return JSON.parse(text());
    } finally {
      b.free();
      v.free();
    }
  }

  /**
   * Fits the diffusion tensor to the b0 volumes and the shells up to b = 1200 s/mm² (else the
   * lowest shell).
   * @param data Float32Array, volume-major: data[volume * voxels + voxel]
   * @param options.mask Uint8Array with one value per voxel, or null to fit every voxel
   * @param options.weighted false for ordinary least squares only
   * @returns {Record<string, Float32Array>} one map per name in DTI_MAPS
   */
  function dtiFit(data, voxels, bvals, bvecs, { mask = null, weighted = true } = {}) {
    const g = gradientArrays(bvals, bvecs);
    if (data.length !== voxels * g.n) {
      throw new Error(`The image has ${data.length / voxels} volumes but the gradient table has ${g.n}.`);
    }
    if (mask && mask.length !== voxels) throw new Error('The mask is not on the image grid.');
    const parts = [copyIn(data), copyIn(g.bvals), copyIn(g.bvecs)];
    const m = mask ? copyIn(mask) : { ptr: 0, free: () => {} };
    const outBytes = DTI_MAPS.length * voxels * 4;
    const out = wasm.alloc(outBytes);
    try {
      const status = wasm.dti_fit(parts[0].ptr, voxels, g.n, parts[1].ptr, parts[2].ptr, m.ptr, weighted ? 1 : 0, out);
      if (status !== 0) throw new Error(text());
      const all = new Float32Array(wasm.memory.buffer, out, DTI_MAPS.length * voxels);
      return Object.fromEntries(DTI_MAPS.map((name, i) => [name, all.slice(i * voxels, (i + 1) * voxels)]));
    } finally {
      wasm.dealloc(out, outBytes);
      m.free();
      for (const part of parts) part.free();
    }
  }

  /**
   * Prepares an AMICO NODDI fit for one gradient table. Throws when NODDI cannot run on it
   * (fewer than two shells, no b0).
   * @returns {{ fit: (data: Float32Array, voxels: number, mask?: Uint8Array|null) => Record<string, Float32Array>, free: () => void }}
   */
  function noddiModel(bvals, bvecs, { method = 'amico' } = {}) {
    if (!['amico', 'dmipy'].includes(method)) throw new Error('NODDI method is amico or dmipy.');
    const create = method === 'dmipy' ? wasm.dmipy_new : wasm.noddi_new;
    const fitModel = method === 'dmipy' ? wasm.dmipy_fit : wasm.noddi_fit;
    const freeModel = method === 'dmipy' ? wasm.dmipy_free : wasm.noddi_free;
    const g = gradientArrays(bvals, bvecs);
    const b = copyIn(g.bvals);
    const v = copyIn(g.bvecs);
    let dict;
    try {
      dict = create(b.ptr, v.ptr, g.n);
    } finally {
      b.free();
      v.free();
    }
    if (!dict) throw new Error(text());
    let diagnostics = null;

    /**
     * Fits a chunk of voxels. `data` is volume-major for these voxels only.
     * @returns one map per name in NODDI_MAPS
     */
    function fit(data, voxels, mask = null) {
      if (!dict) throw new Error('The NODDI model has been freed.');
      if (data.length !== voxels * g.n) {
        throw new Error(`The image has ${data.length / voxels} volumes but the gradient table has ${g.n}.`);
      }
      if (mask && mask.length !== voxels) throw new Error('The mask is not on the image grid.');
      if (method === 'dmipy') {
        for (let frame = 0; frame < g.n; frame++) {
          for (let voxel = 0; voxel < voxels; voxel++) {
            if (mask && !mask[voxel]) continue;
            if (!Number.isFinite(data[frame * voxels + voxel])) {
              throw new Error('dmipy signal must contain one finite value per measurement in selected voxels.');
            }
          }
        }
      }
      const d = copyIn(data);
      const m = mask ? copyIn(mask) : { ptr: 0, free: () => {} };
      const outBytes = NODDI_MAPS.length * voxels * 4;
      const out = wasm.alloc(outBytes);
      try {
        if (fitModel(dict, d.ptr, voxels, m.ptr, out) !== 0) throw new Error(text());
        diagnostics = method === 'dmipy' ? JSON.parse(text()) : null;
        const all = new Float32Array(wasm.memory.buffer, out, NODDI_MAPS.length * voxels);
        return Object.fromEntries(NODDI_MAPS.map((name, i) => [name, all.slice(i * voxels, (i + 1) * voxels)]));
      } finally {
        wasm.dealloc(out, outBytes);
        m.free();
        d.free();
      }
    }

    const free = () => {
      if (dict) {
        freeModel(dict);
        dict = 0;
      }
    };
    return { fit, free, get diagnostics() { return diagnostics; } };
  }

  return { describe, dtiFit, noddiModel };
}

/** Maps that a NODDI model's `fit` returns, in the order the module writes them. */
export const NODDI_MAPS = ['ICVF', 'ISOVF', 'OD', 'dirx', 'diry', 'dirz'];

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  const bytes = typeof Response !== 'undefined' && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}
