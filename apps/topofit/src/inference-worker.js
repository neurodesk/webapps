import { runTopofit, shareAssets } from '@neurodesk/topofit';
import { Tensor, browserRuntime } from './onnx-runtime.js';
import manifest from '@neurodesk/topofit/manifest';
import cortexAtlas from '@neurodesk/topofit/cortex-atlas-manifest';
import { fetchModel } from '@neurodesk/webapp-components/worker';
import { createAssetLoader, openModelCache } from './model-assets.js';

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });
const cachePromise = openModelCache();

// ONNX Runtime never runs in this worker: its wasm heap cannot shrink, so the alignment
// and feature sessions each live in a worker that closes when the session is released.
async function createSession(bytes) {
  const worker = new Worker(new URL('./session-worker.js', import.meta.url), { type: 'module' });
  const request = (message, transfer = []) => new Promise((resolve, reject) => {
    worker.onmessage = ({ data }) => (data.type === 'error' ? reject(new Error(data.message)) : resolve(data));
    worker.onerror = (event) => reject(new Error(event.message || 'Session worker failed.'));
    worker.postMessage(message, transfer);
  });
  await request({ type: 'create', bytes }, [bytes]);
  return {
    async run(feeds) {
      const serialized = Object.fromEntries(
        Object.entries(feeds).map(([name, { type, data, dims }]) => [name, { type, data, dims }]),
      );
      const { outputs } = await request({ type: 'run', feeds: serialized });
      return Object.fromEntries(Object.entries(outputs).map(([name, tensor]) => [name, { ...tensor, dispose() {} }]));
    },
    async release() {
      await request({ type: 'release' });
      worker.terminate();
    },
  };
}

// Each hemisphere runs in its own worker so its ORT heap is freed on terminate(). In
// 'parallel' mode both run at once (about 3 GB more peak memory, roughly a quarter
// faster); in 'sequential' mode the right hemisphere starts only after the left
// hemisphere's worker is gone. A failure inside a hemisphere worker is flagged so the
// page can retry a parallel run sequentially; a model download failure is not.
function reconstructHemispheres({ mode, loadAsset }) {
  return ({ features, hemispheres, contrast, onOrder, lap }) => {
    const asset = shareAssets(loadAsset);
    const workers = new Set();
    const hemisphereFailure = (message) => Object.assign(new Error(message), { hemisphereFailure: true });
    // Creating a worker or cloning the features into it can fail for lack of memory too,
    // so those failures are flagged for the sequential retry like a crash inside it.
    const run = (hemisphere, transfer) => {
      let worker;
      return new Promise((resolve, reject) => {
        try {
          worker = new Worker(new URL('./hemisphere-worker.js', import.meta.url), { type: 'module' });
          workers.add(worker);
          worker.onmessage = async ({ data }) => {
            if (data.type === 'asset') {
              let bytes;
              try {
                bytes = await asset(data.name, data.from, data.to);
              } catch (error) {
                reject(error);
                return;
              }
              try {
                worker.postMessage({ type: 'asset', id: data.id, bytes }, [bytes]);
              } catch (error) {
                reject(hemisphereFailure(`Hemisphere ${hemisphere} worker could not receive ${data.name}: ${error.message || error}`));
              }
            } else if (data.type === 'order') onOrder(hemisphere, data.order);
            else if (data.type === 'lap') lap(data.stage, data.seconds);
            else if (data.type === 'result') resolve({ white: data.white, pial: data.pial, registration: data.registration });
            else if (data.type === 'error') reject(hemisphereFailure(data.message));
          };
          worker.onerror = (event) => reject(hemisphereFailure(event.message || `Hemisphere ${hemisphere} worker failed.`));
          worker.postMessage({ hemisphere, features, contrast, ...hemispheres[hemisphere] }, transfer);
        } catch (error) {
          reject(hemisphereFailure(`Hemisphere ${hemisphere} worker could not start: ${error.message || error}`));
        }
      }).finally(() => {
        worker?.terminate();
        workers.delete(worker);
      });
    };
    const featureBuffers = Object.values(features).map((array) => array.buffer);
    const both = mode === 'sequential'
      ? run('lh', []).then(async (lh) => ({ lh, rh: await run('rh', featureBuffers) }))
      : Promise.all([run('rh', []), run('lh', featureBuffers)]).then(([rh, lh]) => ({ lh, rh }));
    return both.finally(() => workers.forEach((worker) => worker.terminate()));
  };
}

self.onmessage = async ({ data: job }) => {
  try {
    const loadAsset = createAssetLoader({ baseUrl: job.assetBase, cache: cachePromise, onProgress: progress });
    const result = await runTopofit({
      buffer: await job.file.arrayBuffer(),
      model: job.model,
      conform: job.conform,
      overlayThickness: job.overlayThickness,
      estimateNormals: job.estimateNormals,
      patches: job.patches,
      roiBuffer: job.roiBuffer,
      loadAtlas: async () => fetchModel({
        url: cortexAtlas.url,
        cacheKey: cortexAtlas.url,
        integrity: cortexAtlas,
      }, { cache: await cachePromise }),
      loadAsset,
      createSession,
      reconstructHemispheres: reconstructHemispheres({ mode: job.hemispheres, loadAsset }),
      Tensor,
      onProgress: progress,
      runtime: {
        app: 'TopoFit web 0.13.20261007',
        release: manifest.release,
        assets: Object.fromEntries(manifest.assets.map(({ filename, sha256 }) => [filename, sha256])),
        ...(job.patches ? { cortexAtlasSha256: cortexAtlas.sha256 } : {}),
        ...browserRuntime(),
      },
    });
    self.postMessage({ type: 'result', ...result }, [...result.files.map((file) => file.bytes), ...Object.values(result.surfaces.vertices).map((array) => array.buffer), ...Object.values(result.surfaces.faces).map((array) => array.buffer)]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error), hemisphereFailure: Boolean(error.hemisphereFailure) });
  }
};
