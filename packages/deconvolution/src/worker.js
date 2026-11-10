// Module worker running the deconvolution WebAssembly module off the page's thread. One worker
// per run: terminating it is how a run is cancelled, and it frees the module's memory.
//
// Requests (one per worker):
//   { type: "psf", optics, spacingUm, size: { xy, z } }  -> { type: "psf", psf: Float64Array }
//   { type: "deconvolve", image, dims, psf, psfDims, iterations, tvWeight }
//       -> { type: "progress", iteration } after each iteration, then
//          { type: "result", estimate: Float32Array }
// Failures answer { type: "error", message }.
import init, { gibsonLanniPsf, Deconvolver } from "../wasm/deconvolution_wasm.js";

const ready = init();

async function handle(request) {
  await ready;
  if (request.type === "psf") {
    const { optics, spacingUm, size } = request;
    const psf = gibsonLanniPsf(optics.na, optics.ni, optics.ns, optics.emissionUm, optics.excitationUm, spacingUm.x, spacingUm.z, size.xy, size.z, optics.depthUm);
    self.postMessage({ type: "psf", psf }, [psf.buffer]);
    return;
  }
  if (request.type === "deconvolve") {
    const { image, dims, psf, psfDims, iterations, tvWeight } = request;
    const deconvolver = new Deconvolver(image, Uint32Array.from(dims), psf, Uint32Array.from(psfDims), tvWeight);
    for (let iteration = 1; iteration <= iterations; iteration += 1) {
      deconvolver.iterate(1);
      self.postMessage({ type: "progress", iteration });
    }
    const estimate = Float32Array.from(deconvolver.estimate());
    deconvolver.free();
    self.postMessage({ type: "result", estimate }, [estimate.buffer]);
    return;
  }
  throw new Error(`Unknown request ${request.type}`);
}

self.onmessage = ({ data }) => {
  handle(data).catch((error) => self.postMessage({ type: "error", message: error?.message ?? String(error) }));
};
