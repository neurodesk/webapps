import * as ort from '../wasm/ort.webgpu.bundle.min.mjs';
import { createWorkerEmitter, fetchModel as fetchModelAsset, getOptimalWasmThreads, installWorkerRouter } from '../vendor/webapp-components/src/worker/index.js';
import { createMuscleMapPipeline } from '../vendor/musclemap/src/pipeline.js';
import './asset-integrity.js';
import '../nifti-js/index.js';
const MuscleMapAssetIntegrity = globalThis.MuscleMapAssetIntegrity;
const workerMessages = createWorkerEmitter(self);
const { log: postLog, progress: postProgress, error: postError } = workerMessages;
let webgpuAvailable = false;
async function fetchModel(asset, modelName, progressBase, progressSpan) {
  const url = asset?.url;
  if (!url) throw new Error('The selected model has no published asset URL');
  const displayName = modelName || url.split('/').pop();

  let lastError = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    postLog(`Downloading: ${displayName}${attempt === 2 ? ' (retry)' : ''}...`);
    const sources = asset.parts?.length
      ? asset.parts.map(part => ({
          ...part,
          url: new URL(`../${part.path}`, self.location.href).href
        }))
      : [{ url, bytes: asset.bytes, sha256: asset.sha256 }];
    const data = new Uint8Array(asset.bytes);
    let received = 0;
    let lastReportedPercent = -1;
    try {
      for (const source of sources) {
        const partStart = received;
        const part = await fetchModelAsset(
          {
            url: source.url,
            integrity: { bytes: source.bytes, sha256: source.sha256 }
          },
          {
            cache: 'MuscleMapVerifiedModels',
            requestCache: attempt === 1 ? 'no-store' : 'reload',
            onProgress: ({ received: partReceived }) => {
              const dlProgress = (partStart + partReceived) / asset.bytes;
              const totalReceived = partStart + partReceived;
              const percent = Math.floor(dlProgress * 100);
              if (percent === lastReportedPercent) return;
              lastReportedPercent = percent;
              const mb = (totalReceived / 1048576).toFixed(1);
              const totalMb = (asset.bytes / 1048576).toFixed(0);
              postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
            }
          }
        );
        if (received + part.byteLength > data.length) throw new Error('Downloaded model exceeds the declared byte length');
        data.set(new Uint8Array(part), received);
        received += part.byteLength;
        if (part.byteLength === source.bytes) {
          const dlProgress = received / asset.bytes;
          const percent = Math.floor(dlProgress * 100);
          if (percent !== lastReportedPercent) {
            lastReportedPercent = percent;
            const mb = (received / 1048576).toFixed(1);
            const totalMb = (asset.bytes / 1048576).toFixed(0);
            postProgress(progressBase + dlProgress * progressSpan, `Downloading ${displayName} (${mb}/${totalMb} MB)`);
          }
        }
        await MuscleMapAssetIntegrity.verifyAssetBuffer(data.slice(partStart, received).buffer, source);
      }
      await MuscleMapAssetIntegrity.verifyAssetBuffer(data.buffer, asset);
    } catch (error) {
      lastError = error;

      if (attempt === 2) throw error;
      postLog(`Model download failed: ${error.message}`);
      continue;
    }

    postLog(`Downloaded and verified: ${displayName} (${(received / 1048576).toFixed(1)} MB)`);
    return data.buffer;
  }

  throw lastError || new Error(`Unable to verify downloaded model: ${displayName}`);
}


installWorkerRouter({
  scope: self,
  handle: async ({ type, data }) => {
    if (type === 'init') {
      ort.env.wasm.numThreads = getOptimalWasmThreads();
      ort.env.wasm.wasmPaths = '../wasm/';
      try {
        webgpuAvailable = !!(await globalThis.navigator?.gpu?.requestAdapter());
      } catch {
        webgpuAvailable = false;
      }
      postLog(webgpuAvailable ? 'WebGPU available - will use GPU acceleration'
        : `Using WASM backend (WebGPU not available, ${ort.env.wasm.numThreads} threads)`);
      workerMessages.initialized({ webgpuAvailable });
      return;
    }
    const operation = { run: 'run', metricsOnly: 'metrics', consolidateOnly: 'consolidate' }[type];
    if (!operation) throw new Error(`Unknown MuscleMap operation: ${type}`);
    const useWebGPU = webgpuAvailable && data.settings?.useWebGPU !== false;
    if (type === 'run' && webgpuAvailable && !useWebGPU) postLog(`Forcing WASM backend with ${ort.env.wasm.numThreads} threads`);
    const pipeline = createMuscleMapPipeline({
      Tensor: ort.Tensor,
      deviceMemory: globalThis.navigator?.deviceMemory || 4,
      createSession: bytes => ort.InferenceSession.create(bytes, {
        executionProviders: useWebGPU ? ['webgpu', 'wasm'] : ['wasm'],
        graphOptimizationLevel: 'all'
      }),
      loadModel: fetchModel,
      decompress: buffer => globalThis.nifti.decompress(buffer),
      events: {
        log: postLog,
        progress: postProgress,
        stageData: (stage, bytes, description, provenance) => workerMessages.stageData(stage, bytes, description, { provenance }),
        detectedLabels: labels => workerMessages.emit('detectedLabels', { labels }, { transfer: false }),
        metrics: metrics => workerMessages.emit('metrics', { metrics }, { transfer: false })
      }
    });
    try {
      await pipeline[operation](data);
      workerMessages.complete();
    } catch (error) {
      postError(error.message);
    }
  }
});
