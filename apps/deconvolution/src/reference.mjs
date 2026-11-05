// The deconvolution the app runs, in Node on the same WebAssembly module, for the browser
// tests' expected outputs (scripts/record-reference.mjs, e2e/*.spec.js).
import { createHash } from "node:crypto";
import { loadDeconvolution } from "@neurodesk/deconvolution/node";
import { autoPsfSize, normaliseSum, opticsSettings, prepareImage, prepareMeasuredPsf } from "@neurodesk/deconvolution";

export function sha256(typed) {
  return createHash("sha256").update(new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)).digest("hex");
}

/** `{ estimate: Float32Array, psfDims }` for a volume from readVolume and the form's values. */
export function deconvolveInNode(volume, { spacingUm = volume.spacingUm, optics, measuredPsf, method = "rl", iterations, tvWeight = 0 }) {
  const { gibsonLanniPsf, Deconvolver } = loadDeconvolution();
  let psf;
  let psfDims;
  if (measuredPsf) {
    const prepared = prepareMeasuredPsf(measuredPsf.data, measuredPsf.dims);
    psf = prepared.data;
    psfDims = prepared.dims;
  } else {
    const settings = opticsSettings(optics);
    const size = autoPsfSize({ ...settings, spacingUm, dims: volume.dims });
    psfDims = [size.z, size.xy, size.xy];
    psf = normaliseSum(gibsonLanniPsf(settings.na, settings.ni, settings.ns, settings.emissionUm, settings.excitationUm, spacingUm.x, spacingUm.z, size.xy, size.z, settings.depthUm));
  }
  const deconvolver = new Deconvolver(prepareImage(volume.data).data, Uint32Array.from(volume.dims), psf, Uint32Array.from(psfDims), method === "rltv" ? tvWeight : 0);
  deconvolver.iterate(iterations);
  const estimate = Float32Array.from(deconvolver.estimate());
  deconvolver.free();
  return { estimate, psfDims };
}
