// One fitting worker's message handler, shared by the web app's Web Worker and the command line's
// worker thread: loads the noddi WebAssembly once, then fits chunks of masked voxels.
// Messages in: { type: "init", bvals, bvecs, weighted, noddi } then { type: "fit", id, data, voxels }.
// Messages out: { type: "ready" }, { type: "done", id, tensor, noddi } or { type: "error", message }.
import { loadNoddi } from "./wasm.js";

function transferables(maps) {
  return maps ? Object.values(maps).map((values) => values.buffer) : [];
}

/**
 * @param wasm returns the module source loadNoddi takes (a fetch Response, its bytes, ...); called on init
 * @param post posts one message (and its transfer list) to the pool
 * @returns the function to call with each message the pool sends
 */
export function fitWorkerHandler(wasm, post) {
  let api = null;
  let model = null;
  let settings = null;
  return async (message) => {
    try {
      if (message.type === "init") {
        api = await loadNoddi(wasm());
        settings = message;
        model = message.noddi ? api.noddiModel(message.bvals, message.bvecs) : null;
        post({ type: "ready" });
        return;
      }
      if (message.type === "fit") {
        const { bvals, bvecs, weighted } = settings;
        const tensor = api.dtiFit(message.data, message.voxels, bvals, bvecs, { weighted });
        const noddi = model ? model.fit(message.data, message.voxels) : null;
        post({ type: "done", id: message.id, tensor, noddi }, [...transferables(tensor), ...transferables(noddi)]);
      }
    } catch (error) {
      post({ type: "error", message: error?.message ?? String(error) });
    }
  };
}
