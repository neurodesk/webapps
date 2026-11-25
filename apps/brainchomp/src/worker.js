import {
  applyBrainMask,
  BRAINCHOMP_LIB_REVISION,
  DEFAULT_OPENING_RADIUS,
  prepareModelInput,
  readNifti3dAsync,
} from '@neurodesk/brainchomp';
import { chooseBackend } from '@neurodesk/runtime-support/mindgrab/backend';
import * as brainchomp from '../vendor/brainchomp/index.js';

async function resolveBackend(requested, onLog) {
  if (requested && requested !== 'auto') return requested;
  const webgpu = await brainchomp.checkSupport().catch((error) => ({ supported: false, reasons: [error.message] }));
  const adapter = webgpu.supported
    ? await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' })
    : null;
  const rawInfo = adapter?.info ?? {};
  const webgpuProbe = {
    supported: webgpu.supported,
    info: {
      vendor: rawInfo.vendor,
      architecture: rawInfo.architecture,
      device: rawInfo.device,
      description: rawInfo.description,
      isFallbackAdapter: rawInfo.isFallbackAdapter ?? adapter?.isFallbackAdapter,
    },
  };
  let webgl2Probe;
  const probeGl = () => {
    const gl = brainchomp.checkWebgl2Support();
    const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(1, 1) : null;
    const caveat = gl.supported && canvas
      ? !canvas.getContext('webgl2', { failIfMajorPerformanceCaveat: true })
      : false;
    webgl2Probe = { supported: gl.supported, renderer: gl.renderer, caveat };
    return webgl2Probe;
  };
  const cpuSupport = brainchomp.checkCpuSupport();
  const choice = chooseBackend({
    webgpu: webgpuProbe,
    webgl2: probeGl,
    cpu: cpuSupport.supported,
  });
  if (choice === null) {
    const cpuReason = cpuSupport.reasons?.join('; ') || 'cross-origin isolation is unavailable';
    throw new Error(`No usable Brainchomp backend: only software GPU rendering is available, and CPU cannot run here (${cpuReason}).`);
  }
  onLog(`Brainchomp: auto selected ${choice}`);
  return choice;
}

self.onmessage = async ({ data: job }) => {
  const onProgress = (value, message) => self.postMessage({ type: 'progress', value, message });
  const onLog = (message) => self.postMessage({ type: 'log', message: String(message) });
  try {
    onProgress(0.05, 'Reading rodent MRI volume…');
    const volume = await readNifti3dAsync(await job.file.arrayBuffer());
    const modelInput = prepareModelInput(volume);
    const backend = await resolveBackend(job.backend ?? 'auto', onLog);
    const opening = Number.isInteger(job.opening) ? job.opening : DEFAULT_OPENING_RADIUS;
    onProgress(0.15, `Extracting rodent brain (${backend})…`);
    const result = await brainchomp.segment(modelInput, {
      worker: false,
      backend,
      opening,
      fillHoles: true,
      gzipOutput: false,
      assetPath: job.assetPath,
      onLog,
    });
    onProgress(0.9, 'Writing brain image and mask on input grid…');
    const maskVolume = await readNifti3dAsync(result.mask);
    const { brain, mask, maskVoxels } = applyBrainMask(volume, maskVolume);
    onProgress(1, 'Brain image and mask ready');
    self.postMessage({
      type: 'result',
      brain,
      mask,
      provenance: {
        method: 'Brainchomp',
        library: 'brainchomp-lib',
        libraryRevision: BRAINCHOMP_LIB_REVISION,
        backend: result.backend,
        openingRadius: opening,
        elapsedMs: result.elapsedMs,
        maskVoxels,
        dims: volume.dims,
      },
    }, [brain, mask]);
  } catch (error) {
    self.postMessage({ type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
};
