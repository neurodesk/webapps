// Glue for ./lcmodel.wasm (see ../wasm/src/lib.rs): a plain C ABI, no wasm-bindgen.
// FID-A preprocessing and LCModel run synchronously inside the module, so call
// them from a worker. Replies are JSON. Views of wasm memory are re-taken after
// every export call, because a heap growth detaches the previous buffer.

/**
 * @param source a Response, a Promise of one, an ArrayBuffer/TypedArray or a WebAssembly.Module
 * @param {{onProgress?: (text: string, fraction: number) => void}} [options]
 */
export async function loadLcmodel(source, { onProgress = () => {} } = {}) {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let wasm;
  const imports = {
    env: {
      mrs_progress(ptr, len, fraction) {
        onProgress(decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len)), fraction);
      },
    },
  };
  wasm = await instantiate(await source, imports);

  const put = (bytes) => {
    const ptr = wasm.alloc(bytes.length);
    new Uint8Array(wasm.memory.buffer).set(bytes, ptr);
    return ptr;
  };
  const reply = () => JSON.parse(decoder.decode(new Uint8Array(wasm.memory.buffer, wasm.reply_ptr(), wasm.reply_len())));
  const call = (fn, value) => {
    const bytes = encoder.encode(JSON.stringify(value));
    const ptr = put(bytes);
    fn(ptr, bytes.length);
    wasm.dealloc(ptr, bytes.length);
    return reply();
  };

  return {
    /**
     * Run LCModel.
     * @param {{control: string, files: Record<string, string>, fdate?: string}} request
     *   `control` is the LCMODL namelist; `files` maps the names it references
     *   (FILRAW, FILH2O, FILBAS) to their text.
     * @returns {{outputs: Record<string, string>, stdout: string, error: string | null}}
     */
    run(request) {
      return call(wasm.lcmodel_run, { fdate: "", ...request });
    },
    /** Forget added files, loaded datasets and results. */
    reset() {
      wasm.mrs_reset();
    },
    /** Hand one file to the module (its bytes are copied once). */
    addFile(name, bytes) {
      const nameBytes = encoder.encode(name);
      const namePtr = put(nameBytes);
      const dataPtr = put(bytes);
      wasm.mrs_add_file(namePtr, nameBytes.length, dataPtr, bytes.length);
      wasm.dealloc(namePtr, nameBytes.length);
    },
    /** Detect files and optionally assign water by {water: [{targetPath, files: [path]}]}. */
    load(options = {}) {
      if (options.water?.length) return call(wasm.mrs_load_with_options, options);
      wasm.mrs_load();
      return reply();
    },
    /** FID-A preprocessing of one dataset, with LCModel .RAW/.H2O text. */
    process(dataset, options = {}) {
      return call(wasm.mrs_process, { dataset, options });
    },
    /** Functional MRS preprocessing: binning, transient QC, BOLD linewidth matching. */
    processFmrs(dataset, options = {}) {
      return call(wasm.mrs_process_fmrs, { dataset, options });
    },
  };
}

async function instantiate(source, imports) {
  if (source instanceof WebAssembly.Module) return (await WebAssembly.instantiate(source, imports)).exports;
  const bytes = typeof Response !== "undefined" && source instanceof Response ? await source.arrayBuffer() : source;
  return (await WebAssembly.instantiate(bytes, imports)).instance.exports;
}
