// Runs @niivue/meica's single-threaded WebAssembly off the page thread (copy-runtime.mjs stages
// only dist/single). One job per worker: the page terminates the worker to cancel.
import { loadMeica, runMeica } from "@niivue/meica";

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ phase: "Starting single-threaded" });
    const api = await loadMeica({ threads: 1, baseUrl: new URL("../meica-wasm/", self.location.href).href });
    const echoes = data.echoes.map((e) => ({ name: e.name, bytes: new Uint8Array(e.buffer) }));
    const { summary, files } = runMeica({ api, echoes, tes: data.tes, options: data.options, onProgress: (phase) => self.postMessage({ phase }) });
    const buffers = files.map((f) => f.bytes.buffer);
    self.postMessage({ summary, files: files.map((f, i) => ({ name: f.name, buffer: buffers[i] })) }, buffers);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
