// The RELION steps as the app presents them. The commands, their inputs,
// options, defaults and ranges come from @neurodesk/cryo-em (commands.json);
// this module adds only the words and turns a project's jobs into input choices.
// Pure: no DOM, so the tests run it under Node.
import { RELION_DEFINITION } from '@neurodesk/cryo-em';

const field = (label, unit = '', help = '') => ({ label, unit, help });

/** The pipeline in order, with the label each step has in the app. */
export const STEPS = Object.freeze([
  { command: 'import', label: 'Import movies' },
  { command: 'motioncorr', label: 'Motion correction' },
  { command: 'ctffind', label: 'CTF estimation' },
  { command: 'autopick', label: 'Particle picking' },
  { command: 'extract', label: 'Particle extraction' },
  { command: 'class2d', label: '2D classification' },
  { command: 'select', label: 'Class selection' },
  { command: 'initialmodel', label: 'Initial model' },
  { command: 'refine3d', label: '3D refinement' },
  { command: 'maskcreate', label: 'Mask creation' },
  { command: 'postprocess', label: 'Post-processing' },
]);

export const INPUT_TEXT = {
  import: { movies: field('Movies') },
  motioncorr: { movies: field('Movies'), gain: field('Gain reference', '', 'An MRC gain reference in a data root or uploaded from this computer.') },
  ctffind: { micrographs: field('Micrographs') },
  autopick: { micrographs: field('Micrographs') },
  extract: { micrographs: field('Micrographs with CTF'), coordinates: field('Coordinates') },
  class2d: { particles: field('Particles') },
  select: { particles: field('Classified particles'), optimiser: field('Class2D optimiser') },
  initialmodel: { particles: field('Particles') },
  refine3d: { particles: field('Particles'), reference: field('Reference map'), mask: field('Reference mask') },
  maskcreate: { map: field('Map') },
  postprocess: { halfMap: field('Half map'), mask: field('Solvent mask') },
};

const SAMPLING = 'Angular sampling of the first iterations.';
const POOL = 'Particles read per thread at a time.';
const DISCIO = 'Let every MPI follower read particles from disk at the same time.';
const PREREAD = 'Read all particles into memory before refinement.';
const COMBINE = 'Combine iteration results through the disk instead of over MPI.';
const CTF_PEAK = 'Leave the CTF uncorrected up to its first peak.';

export const OPTION_TEXT = {
  import: {
    isMultiframe: field('Movies (multi-frame)', '', 'Off imports single-frame micrographs instead of movies.'),
    angpix: field('Pixel size', 'Å'),
    kV: field('Voltage', 'kV'),
    Cs: field('Spherical aberration', 'mm'),
    Q0: field('Amplitude contrast'),
    beamtiltX: field('Beam tilt X', 'mrad'),
    beamtiltY: field('Beam tilt Y', 'mrad'),
  },
  motioncorr: {
    dosePerFrame: field('Dose per frame', 'e⁻/Å²'),
    patchX: field('Patches X'),
    patchY: field('Patches Y'),
    firstFrameSum: field('First frame'),
    lastFrameSum: field('Last frame', '', '-1 sums to the last frame.'),
    eerGrouping: field('EER fractionation'),
    doFloat16: field('Write float16', '', 'Halves the size of the micrographs; needs the power spectra.'),
    bfactor: field('B-factor', 'Å²'),
    groupFrames: field('Group frames'),
    binFactor: field('Binning factor'),
    gainRot: field('Gain rotation', '× 90°'),
    gainFlip: field('Gain flip', '', '0 none, 1 upside down, 2 left to right.'),
    doDoseWeighting: field('Dose weighting'),
    doSaveNoDW: field('Also save unweighted sums'),
    preExposure: field('Pre-exposure', 'e⁻/Å²'),
    doSavePs: field('Save power spectra'),
    groupForPs: field('Dose per power spectrum', 'e⁻/Å²'),
  },
  ctffind: {
    useNoDW: field('Use unweighted sums'),
    doPhaseshift: field('Estimate phase shifts'),
    phaseMin: field('Minimum phase shift', '°'),
    phaseMax: field('Maximum phase shift', '°'),
    phaseStep: field('Phase shift step', '°'),
    dAst: field('Expected astigmatism', 'Å'),
    useGivenPs: field('Use motion-correction power spectra'),
    slowSearch: field('Exhaustive search'),
    box: field('FFT box', 'px'),
    resMin: field('Minimum resolution', 'Å'),
    resMax: field('Maximum resolution', 'Å'),
    dfMin: field('Minimum defocus', 'Å'),
    dfMax: field('Maximum defocus', 'Å'),
    dfStep: field('Defocus step', 'Å'),
    ctfWin: field('Estimation window', 'px', '-1 uses the whole micrograph.'),
  },
  autopick: {
    logDiamMin: field('Minimum diameter', 'Å', 'Laplacian-of-Gaussian picking: the smallest particle diameter.'),
    logDiamMax: field('Maximum diameter', 'Å'),
    logInvert: field('Dark background'),
    logMaxres: field('Maximum resolution', 'Å', 'Micrographs are low-pass filtered to this resolution; -1 keeps them.'),
    logAdjustThreshold: field('Threshold adjustment', '', 'Higher values pick fewer particles.'),
    logUpperThreshold: field('Upper threshold', '', '999 keeps every particle above the lower threshold.'),
  },
  extract: {
    extractSize: field('Box size', 'px'),
    doInvert: field('Invert contrast'),
    doFloat16: field('Write float16'),
    doNorm: field('Normalise particles'),
    bgDiameter: field('Background diameter', 'px', '-1 uses 75 % of the box.'),
    whiteDust: field('White dust', 'σ', '-1 keeps every pixel.'),
    blackDust: field('Black dust', 'σ', '-1 keeps every pixel.'),
    doRescale: field('Rescale particles'),
    rescale: field('Rescaled size', 'px'),
    doFomThreshold: field('Use a figure-of-merit threshold'),
    minimumPickFom: field('Minimum figure of merit'),
  },
  class2d: {
    nrClasses: field('Classes'),
    particleDiameter: field('Mask diameter', 'Å'),
    nrIterGrad: field('VDAM iterations'),
    tauFudge: field('Regularisation T'),
    doCtfCorrection: field('CTF correction'),
    ctfIntactFirstPeak: field('Ignore CTF to first peak', '', CTF_PEAK),
    doZeroMask: field('Zero outside the mask'),
    highresLimit: field('High-resolution limit', 'Å', '-1 uses all frequencies.'),
    doCenter: field('Centre class averages'),
    performAlignment: field('Align images'),
    psiSampling: field('In-plane angular step', '°'),
    offsetRange: field('Offset range', 'px'),
    offsetStep: field('Offset step', 'px'),
    allowCoarser: field('Allow coarser sampling'),
    nrPool: field('Pooled particles', '', POOL),
    doParallelDiscio: field('Parallel disc I/O', '', DISCIO),
    doPrereadImages: field('Pre-read images', '', PREREAD),
    doCombineThruDisc: field('Combine through disc', '', COMBINE),
  },
  select: {
    mode: field('Selection'),
    classes: field('Classes', '', 'Class numbers; click class averages in the viewer to choose them.'),
    minScore: field('Minimum score'),
    minParticles: field('Minimum particles', '', '-1 sets no minimum.'),
    minClasses: field('Minimum classes', '', '-1 sets no minimum.'),
  },
  initialmodel: {
    nrIter: field('VDAM iterations'),
    nrClasses: field('Classes'),
    sym: field('Symmetry'),
    particleDiameter: field('Mask diameter', 'Å'),
    tauFudge: field('Regularisation T'),
    doRunC1: field('Run in C1, then align symmetry'),
    doSolvent: field('Flatten solvent'),
    doCtfCorrection: field('CTF correction'),
    ctfIntactFirstPeak: field('Ignore CTF to first peak', '', CTF_PEAK),
    nrPool: field('Pooled particles', '', POOL),
    doParallelDiscio: field('Parallel disc I/O', '', DISCIO),
    doPrereadImages: field('Pre-read images', '', PREREAD),
    doCombineThruDisc: field('Combine through disc', '', COMBINE),
  },
  refine3d: {
    sym: field('Symmetry'),
    iniHigh: field('Initial low-pass filter', 'Å'),
    particleDiameter: field('Mask diameter', 'Å'),
    refCorrectGreyscale: field('Reference on absolute greyscale'),
    trustRefSize: field('Trust the reference box size'),
    doCtfCorrection: field('CTF correction'),
    ctfIntactFirstPeak: field('Ignore CTF to first peak', '', CTF_PEAK),
    doZeroMask: field('Zero outside the mask'),
    doSolventFsc: field('Solvent-flattened FSC'),
    doBlush: field('Blush regularisation'),
    blushVersion: field('Blush version'),
    sampling: field('Initial angular sampling', '', SAMPLING),
    offsetRange: field('Offset range', 'px'),
    offsetStep: field('Offset step', 'px'),
    autoLocalSampling: field('Local searches from', '', 'Angular sampling at which local searches start.'),
    autoFaster: field('Use finer sampling faster'),
    nrPool: field('Pooled particles', '', POOL),
    doPad1: field('Skip padding'),
    doParallelDiscio: field('Parallel disc I/O', '', DISCIO),
    doPrereadImages: field('Pre-read images', '', PREREAD),
    doCombineThruDisc: field('Combine through disc', '', COMBINE),
  },
  maskcreate: {
    lowpassFilter: field('Low-pass filter', 'Å'),
    angpix: field('Pixel size', 'Å', '-1 reads it from the map.'),
    inimaskThreshold: field('Initial binarisation threshold'),
    extendInimask: field('Extend binary map', 'px'),
    widthMaskEdge: field('Soft edge', 'px'),
  },
  postprocess: {
    angpix: field('Pixel size', 'Å', '-1 reads it from the half maps.'),
    doAutoBfac: field('Estimate B-factor automatically'),
    autobLowres: field('Lowest resolution for B-factor fit', 'Å'),
    doAdhocBfac: field('Use your own B-factor'),
    adhocBfac: field('B-factor', 'Å²'),
    doSkipFscWeighting: field('Skip FSC weighting'),
    lowPass: field('Low-pass filter', 'Å', 'Used only when FSC weighting is skipped.'),
  },
};

export const ENUM_TEXT = { mode: { classes: 'Classes I choose', ranker: 'RELION class ranker' } };

export function commandDefinition(command) {
  const entry = RELION_DEFINITION.commands[command];
  if (!entry) throw new Error(`Unknown RELION command ${command}`);
  return entry;
}

export function stepLabel(command) {
  return STEPS.find(step => step.command === command)?.label ?? command;
}

/** The step that writes a job directory type: `Class2D` → `2D classification`. */
export function typeLabel(type) {
  const step = STEPS.find(item => RELION_DEFINITION.commands[item.command].jobType === type);
  return step ? step.label : type;
}

/** A condition from commands.json, evaluated on the form's option values (defaults filled). */
export function holds(condition, options, inputs = {}) {
  if (!condition) return true;
  if (condition.all) return condition.all.every(item => holds(item, options, inputs));
  if (condition.not) return !holds(condition.not, options, inputs);
  if ('input' in condition) return (inputs[condition.input] !== undefined) === condition.present;
  if ('gpus' in condition) return true;
  const value = options[condition.option];
  if ('eq' in condition) return value === condition.eq;
  if ('ne' in condition) return value !== condition.ne;
  if ('gt' in condition) return value > condition.gt;
  if ('ge' in condition) return value >= condition.ge;
  if ('lt' in condition) return value < condition.lt;
  if ('le' in condition) return value <= condition.le;
  if ('in' in condition) return condition.in.includes(value);
  if ('notIn' in condition) return !condition.notIn.includes(value);
  return true;
}

/** Option values with the GUI defaults filled in where the user left them empty. */
export function withDefaults(command, values = {}) {
  const options = {};
  for (const [name, option] of Object.entries(commandDefinition(command).options)) {
    options[name] = values[name] ?? option.default;
  }
  return options;
}

/**
 * The form of one step: its inputs and options that apply to the current
 * values, with the required options first and the rest as settings.
 */
export function stepForm(command, values = {}) {
  const entry = commandDefinition(command);
  const options = withDefaults(command, values.options);
  const inputs = Object.entries(entry.inputs)
    .filter(([, input]) => holds(input.when, options))
    .map(([name, input]) => ({ name, ...input, ...(INPUT_TEXT[command]?.[name] ?? field(name)) }));
  const fields = Object.entries(entry.options)
    .filter(([, option]) => holds(option.when, options))
    .map(([name, option]) => ({ name, ...option, ...(OPTION_TEXT[command]?.[name] ?? field(name)) }));
  // Options that decide which others apply re-render the form when they change.
  const controlling = new Set();
  const collect = condition => {
    if (!condition) return;
    if (condition.option) controlling.add(condition.option);
    for (const item of condition.all ?? []) collect(item);
    collect(condition.not);
  };
  for (const item of [...Object.values(entry.inputs), ...Object.values(entry.options)]) collect(item.when);
  return {
    command,
    inputs,
    required: fields.filter(item => item.required),
    settings: fields.filter(item => !item.required),
    controlling,
  };
}

/** A job's type from its project directory: `Class2D/job006` → `Class2D`. */
export function jobType(directory) {
  return directory.split('/')[0];
}

/** RELION's iteration of a `run_itNNN_*` output; -1 for other files. */
function iteration(name) {
  const match = /_it(\d+)_[^/]*$/.exec(name);
  return match ? Number(match[1]) : -1;
}

/** Sorts names by name, except that a later iteration comes before an earlier one. */
export function finalIterationFirst(a, b) {
  return iteration(b) - iteration(a) || (a < b ? -1 : a > b ? 1 : 0);
}

/**
 * The Class selection inputs that belong to a viewed class-average stack:
 * `run_itNNN_classes.mrcs` → that iteration's `_data.star` and `_optimiser.star`,
 * each only when the job wrote it.
 */
export function classSelectionInputs(classes, outputs) {
  const names = new Set(outputs.map(output => output.name));
  const prefix = classes.replace(/_classes\.mrcs$/, '');
  const inputs = {};
  if (names.has(`${prefix}_data.star`)) inputs.particles = `${prefix}_data.star`;
  if (names.has(`${prefix}_optimiser.star`)) inputs.optimiser = `${prefix}_optimiser.star`;
  return inputs;
}

/**
 * Earlier outputs an input accepts, newest job first and, within a job, its
 * final iteration first: files directly in a succeeded job's directory whose
 * type, suffix and pattern the input allows.
 * `jobs` are project jobs with their `outputs` (from GET /jobs/{id}).
 */
export function inputChoices(input, jobs) {
  if (!input.accept.includes('path')) return [];
  const choices = [];
  for (const job of [...jobs].reverse()) {
    if (job.status !== 'succeeded' || !input.from?.includes(jobType(job.directory))) continue;
    const names = (job.outputs ?? [])
      .map(output => output.name)
      .filter(name => name.startsWith(`${job.directory}/`) && !name.slice(job.directory.length + 1).includes('/'))
      .filter(name => !input.suffix || name.endsWith(input.suffix))
      .filter(name => !input.pattern || new RegExp(input.pattern).test(name))
      .sort(finalIterationFirst);
    for (const name of names) choices.push({ path: name, job: job.id, directory: job.directory });
  }
  return choices;
}

/** The value an input starts with: the newest matching output, else nothing. */
export function defaultInput(input, jobs) {
  if (input.optional) return undefined;
  return inputChoices(input, jobs)[0]?.path;
}

/** Parse what the user typed into an option's control. Empty is "use the default". */
export function parseOption(option, raw) {
  if (option.type === 'bool') return Boolean(raw);
  const text = String(raw ?? '').trim();
  if (text === '') return undefined;
  if (option.type === 'int-list') {
    return text.split(/[\s,]+/).filter(Boolean).map(item => (/^-?\d+$/.test(item) ? Number(item) : item));
  }
  if (option.type === 'int' || option.type === 'number') {
    const value = Number(text);
    return Number.isFinite(value) ? value : text;
  }
  return text;
}

