import { fetchModel } from '@neurodesk/webapp-components/worker';
import { loadSynthseg, runSynthseg } from '@neurodesk/synthseg';
import { browserRuntime, createBrowserSession } from '@neurodesk/synthseg/browser';
import wasmUrl from '@neurodesk/synthseg/wasm?url';

const progress = (value, message) => self.postMessage({ type: 'progress', value, message });

async function modelBytes(model) {
  if (!/^[a-f0-9]{64}$/i.test(model.sha256 || '')) {
    throw new Error('SynthSeg weights require a SHA-256 checksum.');
  }
  const bytes = await fetchModel({
    url: model.url,
    integrity: { bytes: model.bytes, sha256: model.sha256 },
  }, {
    cache: 'neurodesk-synthseg-v1',
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
    const wasm = await loadSynthseg(fetch(wasmUrl));
    const { buffer, provenance } = await runSynthseg({
      buffer: await job.file.arrayBuffer(),
      options: job.options,
      wasm,
      loadModel: () => modelBytes(job.model),
      createSession: createBrowserSession,
      onProgress: progress,
      runtime: { app: 'SynthSeg web 0.6.20261010', ...browserRuntime() },
    });
    self.postMessage({ type: 'result', buffer, provenance }, [buffer]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
