import model from './gpu-model.json' with { type: 'json' };
import { planGpuGraph as plan, createGpuSession as create } from '@neurodesk/runtime-support/gpu-unet';

export { gpuBufferLimit } from '@neurodesk/runtime-support/gpu-unet';

// @neurodesk/runtime-support is private, but only @neurodesk/synthsr/browser reaches
// for it and that entry point is consumed inside this workspace, never from npm.
export const GPU_IMPLEMENTATION = 'synthsr-blocked-fp32-v1';
const options = { outputChannels: 1, label: 'SynthSR' };
const bufferOptions = {
  maxValidatedBufferSize: Number.POSITIVE_INFINITY,
  bufferLimitHelp: 'Choose tiled mode (approximate), use native SynthSR, or use another device for full-volume processing.',
};

export const planGpuGraph = (dims, graph = model) => plan(dims, graph, options);
export const createGpuSession = (bytes, dims, opts) => create(bytes, dims, {
  ...options,
  ...bufferOptions,
  graph: model,
  ...opts,
});
