import { reconstructHemisphere } from '@neurodesk/topofit';
import { Tensor, createBrowserSession } from './onnx-runtime.js';

// Models come from the inference worker, which downloads and verifies each one once
// for both hemispheres; this worker never touches the network or the model cache.
const pendingAssets = new Map();
let nextAssetId = 0;
const loadAsset = (name, from, to) => new Promise((resolve, reject) => {
  const id = nextAssetId++;
  pendingAssets.set(id, { resolve, reject });
  self.postMessage({ type: 'asset', id, name, from, to });
});

async function start(job) {
  let lapStarted = performance.now();
  const lap = (stage) => {
    const now = performance.now();
    self.postMessage({ type: 'lap', stage, seconds: (now - lapStarted) / 1000 });
    lapStarted = now;
  };
  try {
    const result = await reconstructHemisphere({
      hemisphere: job.hemisphere,
      features: job.features,
      vertices: job.vertices,
      registration: job.registration,
      contrast: job.contrast,
      loadAsset,
      createSession: createBrowserSession,
      Tensor,
      onOrder: (order) => self.postMessage({ type: 'order', order }),
      lap,
    });
    self.postMessage({ type: 'result', ...result }, [result.white.buffer, result.pial.buffer, result.registration.buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
}

self.onmessage = ({ data }) => {
  if (data.type === 'asset') {
    const pending = pendingAssets.get(data.id);
    pendingAssets.delete(data.id);
    if (data.error) pending.reject(new Error(data.error));
    else pending.resolve(data.bytes);
  } else {
    void start(data);
  }
};
