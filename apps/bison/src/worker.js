// The BISON worker: downloads and checks the model files, then runs runBison with the browser
// drivers. antsRegistration, DenoiseImage and Greedy start nested module workers from the kernels that
// scripts/copy-runtime.mjs stages in public/bison-runtime/; terminating this worker ends them too.
//   in:  { type: 'run', t1, flair, t1Name }
//   out: { type: 'progress', message, fraction } | { type: 'log', line }
//        | { type: 'result', mode, files, volumes, timings, memory } | { type: 'error', message }
import ortWasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import { modeFor, runBison } from "@neurodesk/bison";
import { createBrowserDrivers, loadBrowserAssets } from "@neurodesk/bison/browser";
import { DOWNLOAD_SHARE, classifyFraction, stageFraction } from "./config.js";

const runtimeUrl = (path) => new URL(`${import.meta.env.BASE_URL}bison-runtime/${path}`, self.location.origin).href;

const RUNTIME = {
  registration: { worker: runtimeUrl("hmc-registration/src/worker.js") },
  denoise: { worker: runtimeUrl("ants-denoise/src/worker.js") },
  greedy: { worker: runtimeUrl("greedy/src/worker.js") },
  ort: { wasm: new URL(ortWasmUrl, self.location.href).href },
};

const post = (message, transfer) => self.postMessage(message, transfer);
const log = (line) => post({ type: "log", line });

// Progress never moves back: the FLAIR stages and resampling interleave in the pipeline.
let reached = 0;
function progress(message, fraction) {
  if (fraction !== null && fraction !== undefined) reached = Math.max(reached, fraction);
  post({ type: "progress", message, fraction: reached });
}

async function run({ t1, flair, t1Name }) {
  const mode = modeFor({ t1, flair });
  log(`Mode: ${mode === "t1-flair" ? "BISON-WMH (T1 + FLAIR)" : "BISON (T1)"}`);
  const assets = await loadBrowserAssets({
    modes: [mode],
    onProgress: (message, fraction) => progress(message || "Downloading the BISON model files", DOWNLOAD_SHARE * fraction),
  });
  const drivers = createBrowserDrivers({ runtime: RUNTIME, onLog: log });
  log(`ONNX Runtime Web on ${drivers.ort.env.wasm.numThreads} thread(s); ${self.crossOriginIsolated ? "cross-origin isolated" : "not cross-origin isolated"}`);
  const result = await runBison({ t1, flair, t1Name }, drivers, assets, {
    onProgress: (message) => progress(message, stageFraction(message)),
    onLog: log,
    onClassify: (fraction) => progress(`Classifying tissues · ${Math.round(fraction * 100)} %`, classifyFraction(fraction)),
  });
  const files = result.files.map(({ name, bytes }) => ({ name, bytes }));
  post({
    type: "result",
    mode: result.mode,
    files,
    volumes: result.volumes,
    timings: result.timings,
    memory: result.memory,
  }, [...new Set(files.map(({ bytes }) => bytes.buffer))]);
}

// ONNX Runtime Web's bundle starts its threads from this script, named "em-pthread"; there its
// own message handler must stay. Elsewhere: one run for each worker, and the page starts a new
// worker for the next run, or to cancel.
const isOrtThread = self.name?.startsWith("em-pthread");
let started = false;
if (!isOrtThread) self.onmessage = async ({ data }) => {
  if (data?.type !== "run" || started) return;
  started = true;
  try {
    await run(data);
  } catch (error) {
    if (error?.log?.length) for (const line of error.log) log(line);
    post({ type: "error", message: error?.message || String(error) });
  }
};
