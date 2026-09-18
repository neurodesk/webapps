import { readVolume, writeVolume } from '@neurodesk/synthsr';

self.onmessage = async ({ data: job }) => {
  const onProgress = (value, message) => self.postMessage({ type: 'progress', value, message });
  const onLog = message => self.postMessage({ type: 'log', message: String(message) });
  try {
    const volume = readVolume(await job.file.arrayBuffer());
    let result;
    if (job.method === 'bet') {
      const { runBet } = await import('@neurodesk/brain-extraction/bet');
      const runtime = await import(/* @vite-ignore */ new URL('bet/qsm_wasm.js', job.assetBase).href);
      await runtime.default();
      if (runtime.initThreadPool) {
        await runtime.initThreadPool(Math.min(8, navigator.hardwareConcurrency || 4));
      }
      result = runBet({ volume, runtime, fractionalIntensity: job.fractionalIntensity, onProgress });
    } else if (job.method === 'mindgrab') {
      const { runMindgrab } = await import('@neurodesk/brain-extraction/mindgrab');
      result = await runMindgrab({ volume, backend: job.backend, assetPath: new URL('mindgrab/', job.assetBase).href, onProgress, onLog });
    } else if (job.method === 'synthstrip') {
      const { extractSynthstrip } = await import('./synthstrip.js');
      result = await extractSynthstrip({ volume, onProgress });
    } else {
      throw new Error('Choose BET, MindGrab or SynthStrip.');
    }
    const brain = writeVolume(result.brain, 'Brain extraction');
    const mask = writeVolume(result.mask, 'Brain mask');
    self.postMessage({ type: 'result', brain, mask, provenance: result.provenance }, [brain, mask]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
