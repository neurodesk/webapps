// Adapts wasm/bet.wasm (built from bet-wasm/) to the runtime interface runBet takes, the
// signature of QSMbly's `bet_wasm_with_progress`. Each call gets a fresh instance because
// the module never frees its buffers.
export function betRuntime(module) {
  return {
    bet_wasm_with_progress(data, nx, ny, nz, vsx, vsy, vsz, fractionalIntensity, smoothness, gradientThreshold, iterations, subdivisions, onProgress) {
      const instance = new WebAssembly.Instance(module, { env: { progress: (current, total) => onProgress(current >>> 0, total >>> 0) } });
      const { memory, input, bet } = instance.exports;
      const image = input(data.length) >>> 0;
      new Float64Array(memory.buffer, image, data.length).set(data);
      const mask = bet(image, nx, ny, nz, vsx, vsy, vsz, fractionalIntensity, smoothness, gradientThreshold, iterations, subdivisions) >>> 0;
      return new Uint8Array(memory.buffer, mask, data.length).slice();
    },
  };
}
