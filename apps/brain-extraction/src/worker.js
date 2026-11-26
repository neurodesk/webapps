import { readVolume } from '@neurodesk/synthsr';
import { writeOutputs } from '@neurodesk/brain-extraction/outputs';
import mindgrabPackage from '@brainchop/core/package.json' with { type: 'json' };

self.onmessage = async ({ data: job }) => {
  const onProgress = (value, message) => self.postMessage({ type: 'progress', value, message });
  const onLog = message => self.postMessage({ type: 'log', message: String(message) });
  try {
    const volume = readVolume(await job.file.arrayBuffer());
    let result;
    if (job.method === 'bet') {
      const { runBet } = await import('@neurodesk/brain-extraction/bet');
      const { betRuntime } = await import('@neurodesk/brain-extraction/bet-runtime');
      const response = await fetch(new URL('bet/bet.wasm', job.assetBase));
      if (!response.ok) throw new Error(`BET runtime: HTTP ${response.status}`);
      const runtime = betRuntime(await WebAssembly.compile(await response.arrayBuffer()));
      result = runBet({ volume, runtime, fractionalIntensity: job.fractionalIntensity, onProgress });
    } else if (job.method === 'mindgrab') {
      const [{ runMindgrab }, mindgrab, { withBackendChoice }] = await Promise.all([
        import('@neurodesk/brain-extraction/mindgrab'),
        import('@brainchop/core'),
        import('@neurodesk/runtime-support/mindgrab/backend'),
      ]);
      const { segment } = withBackendChoice(mindgrab);
      result = await runMindgrab({ volume, backend: job.backend, runtime: { segment, version: mindgrabPackage.version }, assetPath: new URL('mindgrab/', job.assetBase).href, onProgress, onLog });
    } else if (job.method === 'synthstrip') {
      const { extractSynthstrip } = await import('./synthstrip.js');
      result = await extractSynthstrip({ volume, noCsf: job.noCsf, onProgress });
    } else {
      throw new Error('Choose BET, MindGrab or SynthStrip.');
    }
    const { brain, mask } = writeOutputs(result);
    self.postMessage({ type: 'result', brain, mask, provenance: result.provenance }, [brain, mask]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || String(error) });
  }
};
