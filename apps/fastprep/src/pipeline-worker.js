// Runs one fastprep session off the main thread. The Rust core (WASM) plans every step; each step runs on its
// browser runtime here: niimath (Emscripten), MindGrab (WebGPU/WebGL2/CPU), Greedy (threaded WASM), SynthSR (ONNX
// Runtime Web) and glm (WASM). Steps run one at a time to bound peak memory.
import { runFastprep } from "@neurodesk/fastprep";
import { fetchModel } from "@neurodesk/webapp-components/worker";
import { loadGreedy } from "@neurodesk/greedy";
import { runSynthsr } from "@neurodesk/synthsr";
import { createBrowserSession } from "@neurodesk/synthsr/browser";
import { segment, segmentTissues } from "@brainchop/mindgrab";
import * as ort from "onnxruntime-web/webgpu";
import ortWasm from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url";
import ortMjs from "onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url";
import synthsrManifest from "../../../models/synthsr.manifest.json";
import fastprepManifest from "../../../models/fastprep.manifest.json";

const threads = Math.min(8, navigator.hardwareConcurrency || 1);
ort.env.wasm.wasmPaths = { wasm: ortWasm, mjs: ortMjs };
ort.env.wasm.numThreads = Math.min(4, threads);
// the MNI template images the core reads, pinned by checksum
const TEMPLATES = fastprepManifest.assets.filter((a) => /^templates\/.*\.nii\.gz$/.test(a.filename));
const post = (message, transfer) => self.postMessage(message, transfer);

// pinned by size and checksum; the Cache API keeps the model and templates for later sessions
const fetchAsset = (manifest, a) =>
  fetchModel({ url: manifest.base_url + a.filename, integrity: { bytes: a.bytes, sha256: a.sha256 } }, { cache: "neurodesk-fastprep-v1" });

let model;
async function synthsr(bytes) {
  const asset = synthsrManifest.assets.find((a) => a.filename === "synthsr-v2.onnx");
  model ??= fetchAsset(synthsrManifest, asset).then((b) => ({ bytes: b, hash: asset.sha256 }));
  const backend = navigator.gpu && (await navigator.gpu.requestAdapter()) ? "webgpu" : "wasm";
  const { buffer } = await runSynthsr({
    buffer: bytes.slice().buffer,
    options: { backend },
    Tensor: ort.Tensor,
    loadModel: () => model,
    createSession: (b, be, shape) => createBrowserSession(ort, b, be, shape),
  });
  return buffer;
}

self.onmessage = async ({ data }) => {
  const { base, dataset, options } = data;
  try {
    post({ log: `Loading tools (${threads} threads)…` });
    const niimath = (await import(/* @vite-ignore */ `${base}niimath/niimath.js`)).default;
    const greedy = await loadGreedy(`${base}greedy-wasm/greedy_rs_wasm.js`, threads);
    const tpl = await Promise.all(TEMPLATES.map(async (a) => [
      a.filename.slice("templates/".length),
      new Uint8Array(await fetchAsset(fastprepManifest, a)),
    ]));
    const files = await runFastprep({
      dataset,
      templates: tpl,
      runtimes: {
        niimath,
        mindgrab: { segment, segmentTissues },
        mindgrabOptions: { backend: "auto", worker: false, timeoutMs: 900_000 },
        greedy,
        synthsr,
        wasm: {
          core: { module_or_path: `${base}fastprep-wasm/fastprep/fastprep_wasm_bg.wasm` },
          glm: { module_or_path: `${base}fastprep-wasm/glm/glm_wasm_bg.wasm` },
        },
      },
      options: { omp: threads, nprocs: threads, ...options },
      onLog: (line) => post({ log: line }),
      onStep: (argv) => post({ step: argv[0] }),
    });
    const out = [];
    for (const rel of files.list("/out")) out.push([rel, await files.bytes(`/out/${rel}`)]);
    out.push(["work/commands.sh", await files.bytes("/work/commands.sh")]); // where the report says it is
    post({ done: out }, [...new Set(out.map(([, b]) => b.buffer))]); // files may share one buffer
  } catch (error) {
    post({ error: error?.message ?? String(error) });
  }
};
