// FID-A preprocessing and LCModel run synchronously inside the WebAssembly
// module, so they live in this worker; the page stays responsive and Cancel
// terminates the worker. Loaded datasets stay in the module between messages.
import wasmUrl from "@neurodesk/lcmodel/wasm?url";
import { loadLcmodel } from "@neurodesk/lcmodel";
import { fetchModel } from "@neurodesk/webapp-components/worker";

const CACHE = "neurodesk-lcmodel-basis-v1";
let module = null;
let reportProgress = () => {};

async function lcmodel() {
  module ??= loadLcmodel(fetch(wasmUrl), { onProgress: (text, fraction) => reportProgress(text, fraction) });
  return module;
}

async function cacheStore() {
  let storage;
  try {
    storage = await caches.open(CACHE);
  } catch {
    return null;
  }
  return {
    async get(key) {
      return (await storage.match(key))?.arrayBuffer();
    },
    async set(key, bytes) {
      try {
        await storage.put(key, new Response(bytes));
      } catch {
        /* quota */
      }
    },
    async delete(key) {
      await storage.delete(key);
    },
  };
}

async function gunzipText(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).text();
}

/** A library basis set: download (checksummed, cached), inflate to text. */
async function basisText({ url, bytes, sha256, label }) {
  const data = await fetchModel({ url, integrity: { bytes, sha256 } }, {
    cache: await cacheStore(),
    onProgress: ({ fraction }) => reportProgress(`Downloading the ${label} basis set`, 0.05 + 0.25 * (fraction ?? 0)),
  });
  return gunzipText(data);
}

self.onmessage = async ({ data: job }) => {
  reportProgress = (text, fraction) => self.postMessage({ id: job.id, type: "progress", text, fraction });
  try {
    const lcm = await lcmodel();
    let result;
    if (job.type === "load") {
      lcm.reset();
      for (const file of job.files) lcm.addFile(file.name, new Uint8Array(file.bytes));
      result = lcm.load();
    } else if (job.type === "process") {
      result = lcm.process(job.dataset, job.options);
      if (result.error) throw new Error(result.error);
    } else if (job.type === "fit") {
      const files = { ...job.files };
      if (job.basis.library) files[job.basis.name] = await basisText(job.basis.library);
      else files[job.basis.name] = job.basis.text;
      reportProgress("Fitting with LCModel", 0.35);
      result = lcm.run({ control: job.control, files, fdate: job.fdate });
      if (result.error) throw new Error(lcmodelError(result.error, result.outputs));
    } else {
      throw new Error(`Unknown job ${job.type}`);
    }
    self.postMessage({ id: job.id, type: "done", result });
  } catch (error) {
    // A RuntimeError is a WebAssembly trap: the page starts a fresh worker.
    self.postMessage({ id: job.id, type: "error", message: error?.message ?? String(error), name: error?.name });
  }
};

// LCModel stops with codes such as "FATAL ERROR MYBASI 3"; name the common ones.
function lcmodelError(code, outputs) {
  const hints = {
    "MYBASI 9": "The basis set was simulated for a different field strength.",
    "MYBASI 2": "The basis set's bandwidth is too narrow for these data.",
    "MYDATA 1": "The spectrum file could not be read.",
    "INITIA 4": "The fit range lies outside the spectrum.",
  };
  const key = Object.keys(hints).find((k) => code.includes(k));
  const detail = key ? ` ${hints[key]}` : "";
  const diag = Object.entries(outputs ?? {}).find(([name]) => name.endsWith(".table"))?.[1]?.split("$$DIAG")[1]?.split("$$")[0]?.trim();
  return `LCModel stopped (${code}).${detail}${diag ? ` Diagnostics: ${diag.replace(/\s+/g, " ")}` : ""}`;
}
