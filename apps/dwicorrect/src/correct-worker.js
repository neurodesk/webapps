// The correction worker: loads the shoreline module (threaded when the page is cross-origin
// isolated) and runs one correction per message. The page cancels a run by terminating it.
import { loadShoreline, runShoreline, threadCount } from "@neurodesk/shoreline";

const base = new URL(`${import.meta.env.BASE_URL}shoreline-wasm/`, self.location.origin);
let ready = null;

self.onmessage = async ({ data: message }) => {
  try {
    ready ??= loadShoreline({
      threadsUrl: new URL("threads/shoreline_wasm.js", base).href,
      singleUrl: new URL("single/shoreline_wasm.js", base).href,
      threads: threadCount(),
    });
    const { api, threads } = await ready;
    self.postMessage({ threads });
    const files = Object.fromEntries(Object.entries(message.files).map(([name, buffer]) => [name, new Uint8Array(buffer)]));
    const outputs = runShoreline({ api, files, args: message.args, onLog: (line) => self.postMessage({ log: line }) });
    const buffers = Object.values(outputs).map((bytes) => bytes.buffer);
    self.postMessage({ ok: true, outputs }, buffers);
  } catch (error) {
    self.postMessage({ ok: false, message: error?.message ?? String(error) });
  }
};
