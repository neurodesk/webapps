import { readFile } from 'node:fs/promises';

const GLUE = new URL('../wasm-single/greedy_rs_wasm.js', import.meta.url);
const BINARY = new URL('../wasm-single/greedy_rs_wasm_bg.wasm', import.meta.url);

/**
 * The single-threaded Greedy WebAssembly build for Node, with the threaded browser build's exports
 * (except initThreadPool) and the same results byte for byte. memoryBytes() is its heap. The module
 * is instantiated once per thread.
 */
export async function loadGreedySingleThread({ glue = GLUE, binary = BINARY } = {}) {
  const api = await import(glue.toString());
  const exports = api.initSync({ module: await readFile(binary) });
  return { ...api, memoryBytes: () => exports.memory.buffer.byteLength };
}
