// Glue for ./synthseg.wasm (see ../wasm/src/lib.rs): a plain C ABI, no wasm-bindgen.
// Every typed-array view is re-taken after any export call, because growing the wasm
// heap for the posteriors detaches the previous ArrayBuffer.

/** @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module */
export async function loadSynthseg(source) {
  const wasm = await instantiate(await source);
  const u8 = () => new Uint8Array(wasm.memory.buffer);
  const text = (ptr, len) => new TextDecoder().decode(u8().subarray(ptr, ptr + len));
  const check = () => new Error(text(wasm.seg_error_ptr(), wasm.seg_error_len()) || 'SynthSeg preprocessing failed.');
  const f32 = (ptr, len) => new Float32Array(wasm.memory.buffer, ptr, len).slice();
  const dims = (ptr) => Array.from(new Uint32Array(wasm.memory.buffer, ptr, 3));

  class Segmenter {
    constructor(bytes, { ct = false, voxelSizeMm = 1 } = {}) {
      if (!Number.isFinite(voxelSizeMm) || voxelSizeMm < 1 || voxelSizeMm > 3) {
        throw new Error('Processing voxel size must be between 1 and 3 mm.');
      }
      const ptr = wasm.alloc(bytes.length);
      u8().set(bytes, ptr);
      this.seg = wasm.seg_new_at_resolution(ptr, bytes.length, ct ? 1 : 0, voxelSizeMm);
      wasm.dealloc(ptr, bytes.length);
      if (!this.seg) throw check();
      this.padded = dims(wasm.seg_padded(this.seg));
      this.voxels = this.padded[0] * this.padded[1] * this.padded[2];
      const affine = Array.from(new Float64Array(wasm.memory.buffer, wasm.seg_affine(this.seg), 12));
      this.geometry = { inputShape: dims(wasm.seg_input_dims(this.seg)), paddedShape: this.padded,
        outputShape: dims(wasm.seg_output_dims(this.seg)), outputAffine: [0, 1, 2].map((r) => affine.slice(4 * r, 4 * r + 4)) };
    }
    input() { return f32(wasm.seg_input(this.seg), this.voxels); }
    flippedInput() { return f32(wasm.seg_flipped_input(this.seg), this.voxels); }
    /** Copy channel-major posteriors in, blur them, and keep or flip-average them. */
    posteriors(values, { flipped = false } = {}) {
      const ptr = wasm.seg_scratch(this.seg);
      new Float32Array(wasm.memory.buffer, ptr, values.length).set(values);
      wasm.seg_accumulate(this.seg, flipped ? 1 : 0);
    }
    labels({ fast = false } = {}) {
      const ptr = wasm.seg_labels(this.seg, fast ? 1 : 0);
      const buffer = u8().slice(ptr, ptr + wasm.seg_labels_len(this.seg));
      // mri_synthseg --vol columns: total intracranial, then each label after background, in mm³.
      const volumes = new Float64Array(wasm.memory.buffer, wasm.seg_volumes(this.seg), 33).slice();
      return { buffer, volumes, geometry: this.geometry };
    }
    free() { if (this.seg) { wasm.seg_free(this.seg); this.seg = 0; } }
  }
  return { Segmenter };
}

async function instantiate(source) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, {})).exports;
  // ponytail: buffer a Response instead of instantiateStreaming; the module is ~160 kB, and this
  // one code path is immune to servers that mislabel .wasm.
  const bytes = typeof Response !== 'undefined' && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, {})).instance.exports;
}
