// One fresh wasm module instance per worker, which is the whole point: `initThreadPool` can only
// be called once per instance, so sweeping the pool size means a new worker per configuration.
// Each instance also gets its own wasm memory, so the heap high-water it reports is attributable
// to that configuration alone.

// Keep in step with MODEL_WEIGHT_BASE_URL in js/app/config.js. Duplicated instead of imported so
// the harness does not depend on the generated qsm-defaults.js module; a stale URL fails loudly
// on the fetch below.
const WEIGHT_BASE = 'https://huggingface.co/qsmxt/qsm-onnx-weights/resolve/main';

const log = (m) => self.postMessage({ type: 'log', m });

/** Deterministic smooth field (ppm) plus an all-ones mask, so every tile in the volume is run. */
function makeVolume(nx, ny, nz) {
  const field = new Float64Array(nx * ny * nz);
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        field[x + nx * (y + ny * z)] =
          0.05 * Math.sin(x * 0.11) * Math.cos(y * 0.07) * Math.sin(z * 0.13);
      }
    }
  }
  return { field, mask: new Uint8Array(nx * ny * nz).fill(1) };
}

self.onmessage = async (e) => {
  const { threads, flag, reps, nx, ny, nz, core, halo, mode, model, weightsUrl } = e.data;
  try {
    log(`worker up: isolated=${self.crossOriginIsolated} SharedArrayBuffer=${typeof SharedArrayBuffer}`);
    const mod = await import('../../wasm/qsm_wasm_dl.js');
    const out = await mod.default('../../wasm/qsm_wasm_dl_bg.wasm');
    log(`wasm instantiated, heap=${(out.memory.buffer.byteLength / 1e6).toFixed(0)} MB`);

    const url = weightsUrl || `${WEIGHT_BASE}/${model}.onnx`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`weights ${url} -> HTTP ${res.status}`);
    const weights = new Uint8Array(await res.arrayBuffer());
    log(`weights ${weights.length} bytes from ${url}`);

    let pool = 0;
    if (threads > 0) {
      log(`initThreadPool(${threads})...`);
      await mod.initThreadPool(threads);
      pool = threads;
      log('pool ready');
    }
    // Only affects whole-volume inference. Tiles already run one per rayon worker, and
    // qsm-core's nesting guard keeps tract single-threaded inside them.
    mod.set_threads_ready_wasm(flag);

    const heapAfterInit = out.memory.buffer.byteLength;
    const { field, mask } = makeVolume(nx, ny, nz);
    const times = [];
    const heaps = [];
    for (let r = 0; r < reps; r++) {
      // Timestamp every progress callback. The driver reports once per tile after each batch is
      // collected, so a gap between stamps brackets one wave of concurrent tiles.
      const stamps = [];
      const t0 = Date.now();
      const chi = mod.run_dl_field_inversion_wasm(
        model, field, mask, nx, ny, nz, 1, 1, 1, 0, 0, 1,
        weights, new Uint8Array(0), mode === 'tiled', core, halo,
        (done, total) => {
          const ms = Date.now() - t0;
          stamps.push([done, total, ms]);
          self.postMessage({ type: 'tile', done, total, ms, heapMB: out.memory.buffer.byteLength / 1e6 });
        },
      );
      times.push((Date.now() - t0) / 1000);
      heaps.push(out.memory.buffer.byteLength);
      // Sparse checksum: confirms the result is identical across configurations, and stops the
      // output being optimized away.
      let sum = 0;
      for (let i = 0; i < chi.length; i += 997) sum += chi[i];
      self.postMessage({
        type: 'rep', threads: pool, flag, mode, rep: r,
        secs: times[r], heapMB: heaps[r] / 1e6, checksum: sum, stamps,
      });
    }
    self.postMessage({
      type: 'done', threads: pool, flag, mode, times,
      heapAfterInitMB: heapAfterInit / 1e6,
      peakHeapMB: Math.max(...heaps) / 1e6,
    });
  } catch (err) {
    self.postMessage({ type: 'error', m: String((err && err.stack) || err) });
  }
};
