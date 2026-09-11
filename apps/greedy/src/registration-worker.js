import { gunzip, gzip, loadGreedy, registerGreedy } from "@neurodesk/greedy";

const threads = Math.min(8, navigator.hardwareConcurrency || 1);
let apiPromise;

function greedy() {
  if (!apiPromise) {
    const moduleUrl = new URL("../greedy-wasm/greedy_rs_wasm.js", self.location.href).href;
    apiPromise = loadGreedy(moduleUrl, threads);
  }
  return apiPromise;
}

self.onmessage = async ({ data }) => {
  try {
    self.postMessage({ phase: `Starting ${threads} CPU workers` });
    const api = await greedy();
    self.postMessage({ phase: "Preparing NIfTI images" });
    const [fixed, moving] = await Promise.all([
      gunzip(new Uint8Array(data.fixed)),
      gunzip(new Uint8Array(data.moving)),
    ]);
    const result = registerGreedy({
      api,
      fixed,
      moving,
      mode: data.mode,
      onProgress: (phase) => self.postMessage({ phase }),
    });
    const image = await gzip(result.image);
    const warp = result.warp ? await gzip(result.warp) : null;
    const transfer = [image.buffer];
    if (warp) transfer.push(warp.buffer);
    self.postMessage({ image: image.buffer, matrix: result.matrix, warp: warp?.buffer ?? null }, transfer);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
