// The command line's runtimes for pipeline.js: worker threads in place of Web Workers, the
// package's own hmc.wasm, and zlib for the gzipped series.
import { readFile } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { Worker } from "node:worker_threads";
import { gzipSync } from "node:zlib";
import { loadHmc } from "./wasm.js";

const WASM = new URL("./hmc.wasm", import.meta.url);

/** Loads the package's hmc.wasm. */
export function loadHmcNode() {
  return loadHmc(readFile(WASM));
}

/**
 * Starts one registration worker thread, wrapped in the Web Worker interface the pool drives.
 * `terminate()` resolves when the thread has ended; `exited` resolves then too, however it ends.
 */
export function spawnRegistrationThread() {
  const thread = new Worker(new URL("./node-worker.js", import.meta.url));
  let ended;
  const exited = new Promise((resolve) => {
    ended = resolve;
  });
  const worker = {
    postMessage: (message, transfer) => thread.postMessage(message, transfer),
    terminate: () => thread.terminate().then(() => exited),
    onmessage: null,
    onerror: null,
    exited,
    get running() {
      return thread.threadId !== -1;
    },
  };
  thread.on("message", (data) => worker.onmessage?.({ data }));
  thread.on("error", (error) => worker.onerror?.({ message: error.message }));
  thread.on("exit", (code) => ended(code));
  return worker;
}

/** gzip with a zero modification time, so the same image always gives the same bytes. */
export function gzip(bytes) {
  return gzipSync(bytes, { level: 6 });
}

/** Worker threads to register with: one per core unless `threads` says otherwise. */
export function threadCount(threads) {
  if (threads === undefined) return availableParallelism();
  if (!Number.isInteger(threads) || threads < 1) throw new Error("--threads must be a positive whole number.");
  return threads;
}

/** The runtime correctHeadMotion takes, on worker threads. */
export function nodeRuntime({ workers, spawn = spawnRegistrationThread } = {}) {
  return { spawn, workers: threadCount(workers), gzip };
}
