export const DEFAULT_PARAMETERS = Object.freeze({
  model: 'manual',
  downsample: 1,
  biasCorrection: true,
  denoise: 'none',
  overlap: 0,
  threshold: 0.1,
  minimumComponentSize: 10,
  brainExtraction: 'none',
  brainThreshold: 0.5,
});
const enums = {
  model: ['manual', 'omelette1', 'omelette2', 't2s'],
  downsample: [1, 2, 3, 4],
  denoise: ['none', 'bilateral', 'nlm-fast', 'nlm'],
  overlap: [0, 0.5, 0.75, 0.9],
  brainExtraction: ['none', 'bet', 'synthstrip', 'synthstrip-fast'],
};
export function validateParameters(options = {}) {
  for (const key of Object.keys(options))
    if (!(key in DEFAULT_PARAMETERS)) throw new Error(`Unknown VesselBoost parameter: ${key}`);
  const parameters = { ...DEFAULT_PARAMETERS, ...options };
  for (const [key, values] of Object.entries(enums))
    if (!values.includes(parameters[key])) throw new Error(`Invalid ${key}: ${parameters[key]}`);
  if (typeof parameters.biasCorrection !== 'boolean')
    throw new Error('biasCorrection must be a boolean');
  if (
    !Number.isFinite(parameters.threshold) ||
    parameters.threshold < 0.01 ||
    parameters.threshold > 0.5
  )
    throw new Error('threshold must be between 0.01 and 0.5');
  if (
    !Number.isFinite(parameters.brainThreshold) ||
    parameters.brainThreshold < 0 ||
    parameters.brainThreshold > 1
  )
    throw new Error('brainThreshold must be between 0 and 1');
  if (!Number.isSafeInteger(parameters.minimumComponentSize) || parameters.minimumComponentSize < 0)
    throw new Error('minimumComponentSize must be a non-negative integer');
  return parameters;
}
// UI automation and portable CLI follow the same optional-step order.
export async function runSteps(execute, options) {
  const p = validateParameters(options);
  await execute(p.downsample === 1 ? 'skip-downsample' : 'downsample', { factor: p.downsample });
  await execute(p.biasCorrection ? 'run-n4' : 'skip-n4');
  await execute(p.denoise === 'none' ? 'skip-denoise' : 'run-denoise', { method: p.denoise });
  await execute('run-inference', p);
  if (p.brainExtraction !== 'none') {
    await execute('run-bet', { method: p.brainExtraction, fractionalIntensity: p.brainThreshold });
    await execute('apply-brain-mask');
  }
}
