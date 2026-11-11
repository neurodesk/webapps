// One run in a module worker: read the stack, detect cell candidates, register to the Allen atlas
// and count candidates per region. The page terminates the worker to cancel, which frees the Greedy heap.
//   in:  { files, voxelSizeUm: [z, y, x], orientation, register, detect, detectOptions }
//   out: { type: 'progress', fraction, message } | { type: 'log', message }
//        { type: 'result', ... } | { type: 'error', message }
import initGreedy, * as greedy from '@neurodesk/greedy/wasm-single';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { decodeNiftiBuffer, readNiftiImageData } from '@neurodesk/webapp-components/file-io/nifti';
import { openMicroscopyStack } from '@neurodesk/webapp-components/file-io/microscopy-stack';
import manifest from '../../../models/lightsheet-atlas.manifest.json';
import { runPipeline } from './pipeline.js';
import { resultFiles } from './outputs.js';

const post = (message, transfer = []) => self.postMessage(message, transfer);
const asset = (id) => manifest.assets.find((entry) => entry.id === id);

async function download(id, from, to) {
  const entry = asset(id);
  return fetchModel({ url: entry.url, integrity: { bytes: entry.bytes, sha256: entry.sha256 } }, {
    retries: 2,
    onProgress: ({ fraction }) => post({ type: 'progress', fraction: from + (to - from) * (fraction || 0), message: `Downloading the Allen atlas (${entry.filename})` }),
  });
}

async function loadAtlas() {
  const started = performance.now();
  const template = await decodeNiftiBuffer(await download('template', 0.3, 0.32));
  const annotation = await decodeNiftiBuffer(await download('annotation', 0.32, 0.33));
  const structures = JSON.parse(new TextDecoder().decode(await download('structures', 0.33, 0.34)));
  post({ type: 'log', message: `Allen CCFv3 50 µm atlas ready in ${((performance.now() - started) / 1000).toFixed(1)} s` });
  return { template, annotation, structures, annotationData: readNiftiImageData(annotation, Uint16Array).data };
}

self.onmessage = async ({ data: job }) => {
  try {
    const stack = await openMicroscopyStack(job.files);
    let api = null;
    if (job.register) {
      await initGreedy();
      api = greedy;
    }
    const result = await runPipeline({
      stack,
      voxelSizeUm: job.voxelSizeUm,
      orientation: job.orientation,
      register: job.register,
      detect: job.detect,
      detectOptions: job.detectOptions,
      loadAtlas,
      greedy: api,
      onProgress: (fraction, message) => post({ type: 'progress', fraction, message }),
      onLog: (message) => post({ type: 'log', message }),
    });
    const out = resultFiles(result, job);
    post({ type: 'result', ...out }, Object.values(out.files).map((value) => value.buffer));
  } catch (error) {
    post({ type: 'error', message: error?.message ?? String(error) });
  }
};
