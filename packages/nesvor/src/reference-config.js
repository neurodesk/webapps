export const REFERENCE_PRESET = Object.freeze({
  iterations: 100,
  batchSize: 4,
  samples: 4,
  log2Size: 8,
  width: 16,
  latent: 3,
  sliceFeatures: 4,
  coarsest: 16,
  finest: 2,
  maxObservations: 20000,
  maxOutputVoxels: 32768,
});

export function validateBrowserReference(request) {
  if (request.reference?.acknowledged !== true) throw new Error('Acknowledge the experimental CPU reference preset before running. It is not a validated NeSVoR clinical reconstruction.');
  if (request.options?.registration !== 'none') throw new Error('Browser reference mode requires registration:none and prealigned stacks. Choose WebGPU or remote execution for SVoRT or stack motion correction.');
  for (const option of ['segmentation', 'biasFieldCorrection', 'otsuThresholding', 'stacksIntersection', 'deformable']) {
    if (request.options[option]) throw new Error(`Browser reference mode does not implement ${option}.`);
  }
  if (!Array.isArray(request.stacks) || request.stacks.length < 1 || request.stacks.length > 8) throw new Error('Supply one to eight prealigned stacks.');
  for (const stack of request.stacks) {
    if (!(stack.image instanceof ArrayBuffer) || !(stack.mask instanceof ArrayBuffer)) throw new Error('Every stack requires a NIfTI image and a reviewed NIfTI mask.');
    if (!Number.isFinite(stack.thickness) || stack.thickness <= 0 || stack.thickness > 30) throw new Error('Confirm each slice thickness in millimetres.');
    if (stack.image.byteLength > 64 * 1024 * 1024 || stack.mask.byteLength > 64 * 1024 * 1024) throw new Error('The CPU reference accepts files up to 64 MiB.');
  }
  const outputResolution = request.options.outputResolution;
  if (!Number.isFinite(outputResolution) || outputResolution < 0.3 || outputResolution > 10) throw new Error('Reference output resolution must be 0.3 to 10 mm.');
  return { ...REFERENCE_PRESET, outputResolution };
}

