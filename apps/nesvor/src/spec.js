// The nesvor job specification: protocol presets, validation shared with the
// reference server, and the command line the compute server runs.
// Contract: docs/architecture/remote-compute-protocol.md.

export const REGISTRATIONS = Object.freeze(['svort', 'svort-only', 'svort-stack', 'stack', 'none']);

export const DEFAULT_OPTIONS = Object.freeze({
  outputResolution: 0.8,
  registration: 'svort',
  segmentation: false,
  biasFieldCorrection: false,
  otsuThresholding: false,
  stacksIntersection: false,
  deformable: false,
  iterations: 6000,
  singlePrecision: false,
  weightTransformation: 0.1,
  weightDeform: 0.1,
  weightImage: 1.0,
  batchSize: 4096,
  log2HashmapSize: 19,
});

const RANGES = Object.freeze({
  outputResolution: [0.3, 3],
  iterations: [100, 20000, 'integer'],
  weightTransformation: [0, 100],
  weightDeform: [0, 100],
  weightImage: [0, 100],
  batchSize: [256, 32768, 'integer'],
  log2HashmapSize: [15, 24, 'integer'],
});

const FLAGS = Object.freeze(['segmentation', 'biasFieldCorrection', 'otsuThresholding', 'stacksIntersection', 'deformable', 'singlePrecision']);

/** Upstream quick-start recipes, in the order shown in the protocol select. */
export const PRESETS = Object.freeze([
  {
    id: 'fetal-brain',
    label: 'Fetal brain',
    description: 'Brain masking, N4 bias correction and SVoRT motion correction, then NeSVoR reconstruction at 0.8 mm.',
    options: { ...DEFAULT_OPTIONS, registration: 'svort', segmentation: true, biasFieldCorrection: true },
  },
  {
    id: 'neonatal-brain',
    label: 'Neonatal brain',
    description: 'Otsu background removal, N4 bias correction and stack-to-stack motion correction at 0.8 mm. SVoRT is trained on fetal brains only.',
    options: { ...DEFAULT_OPTIONS, registration: 'stack', otsuThresholding: true, biasFieldCorrection: true },
  },
  {
    id: 'fetal-body',
    label: 'Fetal body (deformable)',
    description: 'Stacks intersection, stack-to-stack registration and deformable NeSVoR at 1.0 mm with the upstream deformable weights.',
    options: {
      ...DEFAULT_OPTIONS,
      outputResolution: 1.0,
      registration: 'stack',
      stacksIntersection: true,
      deformable: true,
      weightTransformation: 1,
      weightDeform: 0.1,
      weightImage: 0.1,
      singlePrecision: true,
      log2HashmapSize: 22,
      batchSize: 8192,
    },
  },
  {
    id: 'custom',
    label: 'Custom',
    description: 'Keep the current settings and edit any of them.',
    options: null,
  },
]);

export function presetOptions(id) {
  const preset = PRESETS.find(item => item.id === id);
  if (!preset) throw new Error(`Unknown protocol ${id}`);
  return preset.options ? { ...preset.options } : null;
}

function isFinitePositive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Validate a job spec against the received multipart part names. Returns the
 * spec with every option filled in. Throws an Error whose message names the
 * first problem; both servers answer that message as `invalid-spec`.
 */
export function validateNesvorSpec(spec, receivedParts = []) {
  if (!spec || typeof spec !== 'object') throw new Error('spec must be an object');
  if (spec.tool !== 'nesvor') throw new Error('tool must be "nesvor"');
  if (spec.command !== 'reconstruct') throw new Error('command must be "reconstruct"');
  if (!Array.isArray(spec.stacks) || spec.stacks.length < 1 || spec.stacks.length > 20) throw new Error('stacks must list 1 to 20 stacks');
  const parts = new Set(receivedParts);
  const seen = new Set();
  const stacks = spec.stacks.map((stack, index) => {
    if (!stack || typeof stack !== 'object') throw new Error(`stacks[${index}] must be an object`);
    if (typeof stack.file !== 'string' || !parts.has(stack.file)) throw new Error(`stacks[${index}].file must name an uploaded part`);
    if (seen.has(stack.file)) throw new Error(`stacks[${index}].file ${stack.file} is used twice`);
    seen.add(stack.file);
    if (!isFinitePositive(stack.thickness) || stack.thickness > 20) throw new Error(`stacks[${index}].thickness must be in (0, 20]`);
    if (stack.mask !== undefined) {
      if (typeof stack.mask !== 'string' || !parts.has(stack.mask)) throw new Error(`stacks[${index}].mask must name an uploaded part`);
      if (seen.has(stack.mask)) throw new Error(`stacks[${index}].mask ${stack.mask} is used twice`);
      seen.add(stack.mask);
    }
    const entry = { file: stack.file, thickness: stack.thickness };
    if (stack.mask !== undefined) entry.mask = stack.mask;
    return entry;
  });
  const options = { ...DEFAULT_OPTIONS };
  const given = spec.options ?? {};
  if (typeof given !== 'object' || Array.isArray(given)) throw new Error('options must be an object');
  for (const [key, value] of Object.entries(given)) {
    if (!(key in DEFAULT_OPTIONS)) throw new Error(`unknown option ${key}`);
    if (key === 'registration') {
      if (!REGISTRATIONS.includes(value)) throw new Error(`registration must be one of ${REGISTRATIONS.join(', ')}`);
    } else if (FLAGS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
    } else {
      const [min, max, integer] = RANGES[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${key} must be a number in [${min}, ${max}]`);
      if (integer && !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
    }
    options[key] = value;
  }
  return { tool: 'nesvor', command: 'reconstruct', stacks, options };
}

function inputPath(name, gzipped = true) {
  return `/job/in/${name}.nii${gzipped ? '.gz' : ''}`;
}

function number(value) {
  return Number.isInteger(value) ? `${value}.0` : String(value);
}

/**
 * The argv after `nesvor` for a validated spec. `gzipped` tells which parts
 * arrived gzipped so the file names match what the server stored.
 */
export function nesvorArgv(validated, gzipped = () => true) {
  const { stacks, options } = validated;
  const argv = ['reconstruct', '--input-stacks', ...stacks.map(stack => inputPath(stack.file, gzipped(stack.file)))];
  const everyMask = stacks.every(stack => stack.mask);
  if (everyMask) argv.push('--stack-masks', ...stacks.map(stack => inputPath(stack.mask, gzipped(stack.mask))));
  argv.push('--thicknesses', ...stacks.map(stack => number(stack.thickness)));
  argv.push('--output-volume', '/job/out/volume.nii.gz', '--output-json', '/job/out/result.json');
  argv.push('--output-resolution', number(options.outputResolution), '--registration', options.registration);
  if (options.segmentation) argv.push('--segmentation');
  if (options.biasFieldCorrection) argv.push('--bias-field-correction');
  if (options.otsuThresholding) argv.push('--otsu-thresholding');
  if (options.stacksIntersection) argv.push('--stacks-intersection');
  if (options.deformable) argv.push('--deformable');
  argv.push('--n-iter', String(options.iterations));
  if (options.singlePrecision) argv.push('--single-precision');
  argv.push(
    '--weight-transformation', number(options.weightTransformation),
    '--weight-deform', number(options.weightDeform),
    '--weight-image', number(options.weightImage),
    '--batch-size', String(options.batchSize),
    '--log2-hashmap-size', String(options.log2HashmapSize),
    '--verbose', '1',
  );
  return argv;
}

/** True when the masks can be passed to nesvor (one per stack). */
export function masksComplete(stacks) {
  return stacks.length > 0 && stacks.every(stack => stack.mask);
}
