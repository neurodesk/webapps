// The SyN-SDC worker: runs packages/sdc's pipeline off the page, so that its JavaScript steps
// (clips, dilations, the unwarp) do not block it. The registration kernels, DenoiseImage, N4 and
// MindGrab run in workers that this worker starts. The page cancels a run by terminating this
// worker, which ends them too.
//   in:  { urls, inputs }   the runtime's asset URLs and correctSusceptibility's inputs
//   out: { progress } while it runs, then { result } or { error }
import { B0_THRESHOLD, correctSusceptibility } from "@neurodesk/sdc/syn";
import { browserRuntime } from "@neurodesk/sdc/syn/browser";
import { brainMask } from "@neurodesk/runtime-support/mindgrab";
import { createNiftiFromData, decodeNiftiBuffer, readNiftiFrames } from "@neurodesk/webapp-components/file-io";
import { parseBval } from "@neurodesk/webapp-components/file-io/gradients";
import { meanVolumes } from "@neurodesk/webapp-components/volume/mean";
import { fieldSummary } from "./syn.js";

self.onmessage = async ({ data: { urls, inputs } }) => {
  try {
    const mindgrabLog = [];
    // MindGrab's CPU modules, so that the masks, and with them the field, are the command line's.
    const mindgrab = async (bytes, { signal }) => {
      const { mask, backend } = await brainMask(bytes, { assetPath: urls.mindgrab, backend: "cpu", signal });
      mindgrabLog.push(backend);
      return mask;
    };
    const runtime = await browserRuntime({ ...urls, mindgrab });
    const result = await correctSusceptibility({ ...inputs, runtime, onProgress: (event) => self.postMessage({ progress: event }) });

    // QC: the mean b0 before and after, and the field in the brain mask.
    const before = await decodeNiftiBuffer(result.intermediate.meanB0.slice().buffer);
    const corrected = readNiftiFrames(await decodeNiftiBuffer(result.files[result.names.image].slice().buffer));
    const voxels = corrected.dims[0] * corrected.dims[1] * corrected.dims[2];
    const b0 = parseBval(inputs.bval).flatMap((b, v) => (b < B0_THRESHOLD ? [v] : []));
    const after = createNiftiFromData(meanVolumes(corrected.data, voxels, b0), before, { dims: corrected.dims.slice(0, 3) });
    const mask = readNiftiFrames(await decodeNiftiBuffer(result.intermediate.epiMask.slice().buffer)).data;
    const qc = {
      before: await runtime.gzip(new Uint8Array(before)),
      after: await runtime.gzip(new Uint8Array(after)),
      field: fieldSummary(result.field, mask, result.provenance.TotalReadoutTime),
      mindgrab: mindgrabLog,
    };
    const buffers = new Set([...Object.values(result.files), qc.before, qc.after].map((bytes) => bytes.buffer));
    self.postMessage({ result: { files: result.files, names: result.names, provenance: result.provenance, qc } }, [...buffers]);
  } catch (error) {
    self.postMessage({ error: error?.message ?? String(error) });
  }
};
