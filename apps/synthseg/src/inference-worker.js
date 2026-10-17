import { fetchModel } from '@neurodesk/webapp-components/worker';
import { loadSynthseg, runSynthseg } from '@neurodesk/synthseg';
import { browserRuntime, createBrowserSession } from '@neurodesk/synthseg/browser';
import wasmUrl from '@neurodesk/synthseg/wasm?url';
import { Niimath } from '@niivue/niimath';
import { InputMemoryError, MAX_BUFFER_BYTES, prepareBrowserInput } from '@neurodesk/synthseg/input-memory';

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });

async function cropNeck(file) {
  const niimath = new Niimath();
  try {
    await niimath.init();
    niimath.setOutputDataType('input');
    const cropped = await niimath.image(file).gz(0).robustfov().run('cropped.nii');
    return cropped.arrayBuffer();
  } finally {
    niimath.dispose();
  }
}

async function modelBytes(model) {
  if (!/^[a-f0-9]{64}$/i.test(model.sha256 || '')) {
    throw new Error('SynthSeg weights require a SHA-256 checksum.');
  }
  const bytes = await fetchModel({
    url: model.url,
    integrity: { bytes: model.bytes, sha256: model.sha256 },
  }, {
    requestFailureMessage: 'Could not download the SynthSeg weights. Check the connection and try again.',
    onProgress: ({ received, fraction }) => progress(
      0.12 + 0.13 * Math.min(1, fraction ?? 1),
      `Loading model · ${(received / 1048576).toFixed(1)} MB`,
    ),
  });
  const hash = model.sha256.toLowerCase();
  return { bytes, hash };
}

self.onmessage = async ({ data: job }) => {
  try {
    const adapter = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) throw new Error('WebGPU is unavailable in this browser.');
    const maxBufferBytes = Math.min(MAX_BUFFER_BYTES, adapter.limits.maxBufferSize, adapter.limits.maxStorageBufferBindingSize);
    const { buffer: input, preparation } = await prepareBrowserInput({
      file: job.file,
      robustFov: job.options.robustFov,
      voxelSizeMm: job.options.voxelSizeMm,
      maxBufferBytes,
      crop: cropNeck,
      onProgress: progress,
    });
    const wasm = await loadSynthseg(fetch(wasmUrl));
    const { buffer, provenance, volumes, tissues } = await runSynthseg({
      buffer: input,
      options: job.options,
      wasm,
      loadModel: () => modelBytes(job.model),
      createSession: createBrowserSession,
      onProgress: progress,
      runtime: { app: 'SynthSeg web 0.11.20261017', ...browserRuntime(), preparation },
    });
    self.postMessage({ type: 'result', buffer, provenance, volumes, tissues }, [buffer, ...Object.values(tissues)]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error),
      ...(error instanceof InputMemoryError ? { recommendation: error.recommendation } : {}) });
  }
};
