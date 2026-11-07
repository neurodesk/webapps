// The relion job specification: validation shared by the app and both compute
// servers, and the command lines RELION 5.1.1's GUI would write for the same
// settings. The commands are data (commands.json) so the Rust server can
// interpret the same table. Contract: docs/architecture/remote-compute-protocol.md.

import definition from './commands.json' with { type: 'json' };

export const RELION_DEFINITION = definition;

export const RELION_COMMANDS = Object.freeze(Object.keys(definition.commands));

const SPEC_KEYS = new Set(['tool', 'command', 'project', 'profile', 'inputs', 'options']);
const DATA_ROOT_KEYS = new Set(['root', 'path', 'pattern']);
const PROJECT_ID = /^[0-9a-f]{32}$/;
const PROFILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ROOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const JOB_COMPONENT = /^job[0-9]{3,}$/;
const PLACEHOLDER = /\{([A-Za-z]+)(?::([A-Za-z0-9]+))?(?::0([1-9]))?\}/g;
const MAX_PATH_BYTES = 1024;
const MAX_PATTERN_BYTES = 255;

function commandDefinition(command) {
  const entry = definition.commands[command];
  if (!entry) throw new Error(`command must be one of ${RELION_COMMANDS.join(', ')}`);
  return entry;
}

/** The RELION job directory type of a command, e.g. `Class2D` for `class2d`. */
export function jobTypeDirectory(command) {
  return commandDefinition(command).jobType;
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}

/**
 * The protocol's relative path rule: at most 1024 bytes, `/`-separated, no
 * empty, `.` or `..` component, no leading `/`, no `\`, no NUL. The empty
 * string (the root itself) is allowed only where `allowEmpty` says so.
 */
export function checkRelativePath(path, label, { allowEmpty = false } = {}) {
  if (typeof path !== 'string') throw new Error(`${label} must be a string`);
  if (path === '') {
    if (allowEmpty) return;
    throw new Error(`${label} must not be empty`);
  }
  if (utf8Bytes(path) > MAX_PATH_BYTES) throw new Error(`${label} is longer than ${MAX_PATH_BYTES} bytes`);
  if (path.includes('\\') || path.includes('\0')) throw new Error(`${label} must not contain a backslash or NUL`);
  for (const component of path.split('/')) {
    if (component === '' || component === '.' || component === '..') throw new Error(`${label} must be a relative path without empty, . or .. components`);
  }
}

function checkPattern(pattern, label) {
  if (typeof pattern !== 'string' || pattern === '') throw new Error(`${label} must be a non-empty string`);
  if (utf8Bytes(pattern) > MAX_PATTERN_BYTES) throw new Error(`${label} is longer than ${MAX_PATTERN_BYTES} bytes`);
  if (/[/\\\0[\]]/.test(pattern)) throw new Error(`${label} must name files in one directory using only * and ? as wildcards`);
}

// Conditions read normalized options, the given inputs and the launch.
function holds(condition, context) {
  if (condition === undefined) return true;
  if (condition.all) return condition.all.every(item => holds(item, context));
  if (condition.not) return !holds(condition.not, context);
  if (condition.gpus !== undefined) return (context.gpus > 0) === condition.gpus;
  if (condition.input !== undefined) return (context.inputs[condition.input] !== undefined) === condition.present;
  const value = context.options[condition.option];
  if (value === undefined) throw new Error(`condition reads option ${condition.option}, which is not set`);
  if ('eq' in condition) return value === condition.eq;
  if ('ne' in condition) return value !== condition.ne;
  if ('gt' in condition) return value > condition.gt;
  if ('ge' in condition) return value >= condition.ge;
  if ('lt' in condition) return value < condition.lt;
  if ('le' in condition) return value <= condition.le;
  if ('in' in condition) return condition.in.includes(value);
  if ('notIn' in condition) return !condition.notIn.includes(value);
  throw new Error(`unsupported condition ${JSON.stringify(condition)}`);
}

function describe(condition) {
  if (condition.option !== undefined && 'eq' in condition) return `${condition.option} is ${JSON.stringify(condition.eq)}`;
  return JSON.stringify(condition);
}

function checkNumber(key, value, option, integer) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${key} must be a finite number`);
  if (integer && !Number.isInteger(value)) throw new Error(`${key} must be an integer`);
  if (value < option.min || value > option.max) throw new Error(`${key} must be in [${option.min}, ${option.max}]`);
  if (option.multipleOf !== undefined && value % option.multipleOf !== 0) throw new Error(`${key} must be a multiple of ${option.multipleOf}`);
}

function checkOptionValue(key, value, option) {
  if (option.type === 'bool') {
    if (typeof value !== 'boolean') throw new Error(`${key} must be a boolean`);
  } else if (option.type === 'int') {
    checkNumber(key, value, option, true);
  } else if (option.type === 'number') {
    checkNumber(key, value, option, false);
  } else if (option.type === 'enum') {
    if (!option.enum.includes(value)) throw new Error(`${key} must be one of ${option.enum.join(', ')}`);
  } else if (option.type === 'string') {
    if (typeof value !== 'string' || !new RegExp(option.pattern).test(value)) throw new Error(`${key} must match ${option.pattern}`);
  } else if (option.type === 'int-list') {
    if (!Array.isArray(value) || value.length < option.minItems || value.length > option.maxItems) throw new Error(`${key} must list ${option.minItems} to ${option.maxItems} integers`);
    const seen = new Set();
    for (const item of value) {
      checkNumber(`${key} item`, item, option, true);
      if (seen.has(item)) throw new Error(`${key} lists ${item} twice`);
      seen.add(item);
    }
  } else {
    throw new Error(`option ${key} has unsupported type ${option.type}`);
  }
}

function validateOptions(entry, given) {
  if (given === undefined) given = {};
  if (!isObject(given)) throw new Error('options must be an object');
  for (const key of Object.keys(given)) {
    if (!(key in entry.options)) throw new Error(`unknown option ${key}`);
  }
  const options = {};
  // Options without `when` first: `when` conditions read only those.
  const ordered = Object.entries(entry.options).sort(([, a], [, b]) => Number(a.when !== undefined) - Number(b.when !== undefined));
  for (const [key, option] of ordered) {
    const value = given[key];
    if (option.when !== undefined && !holds(option.when, { options, inputs: {}, gpus: 0 })) {
      if (value !== undefined) throw new Error(`option ${key} applies only when ${describe(option.when)}`);
      continue;
    }
    if (value === undefined) {
      if (option.required) throw new Error(`option ${key} is required`);
      options[key] = option.default;
      continue;
    }
    checkOptionValue(key, value, option);
    options[key] = Array.isArray(value) ? [...value] : value;
  }
  return options;
}

function validatePathInput(name, value, input) {
  const label = `inputs.${name}`;
  checkRelativePath(value, label);
  const components = value.split('/');
  if (components.length < 3 || !JOB_COMPONENT.test(components[1])) throw new Error(`${label} must be a file of an earlier job, <Type>/jobNNN/<file>`);
  if (!input.from.includes(components[0])) throw new Error(`${label} must be an output of a ${input.from.join(' or ')} job`);
  if (!value.endsWith(input.suffix)) throw new Error(`${label} must end with ${input.suffix}`);
  if (input.pattern !== undefined && !new RegExp(input.pattern).test(value)) throw new Error(`${label} must contain ${input.pattern}`);
  return value;
}

function validateInput(name, value, input, parts) {
  const label = `inputs.${name}`;
  if (input.accept.includes('path') && typeof value === 'string') return validatePathInput(name, value, input);
  if (input.accept.includes('part') && isObject(value) && 'part' in value) {
    if (Object.keys(value).length !== 1) throw new Error(`${label} must be { "part": "${name}" }`);
    if (value.part !== name) throw new Error(`${label}.part must be "${name}"`);
    if (!parts.has(name)) throw new Error(`${label}.part must name an uploaded part`);
    return { part: name };
  }
  if (input.accept.includes('dataRoot') && isObject(value)) {
    for (const key of Object.keys(value)) {
      if (!DATA_ROOT_KEYS.has(key)) throw new Error(`${label} has unknown key ${key}`);
    }
    if (typeof value.root !== 'string' || !ROOT_ID.test(value.root)) throw new Error(`${label}.root must be a data root id`);
    checkRelativePath(value.path, `${label}.path`, { allowEmpty: true });
    checkPattern(value.pattern, `${label}.pattern`);
    return { root: value.root, path: value.path, pattern: value.pattern };
  }
  if (input.accept.includes('dataFile') && isObject(value) && !('pattern' in value)) {
    for (const key of Object.keys(value)) {
      if (key !== 'root' && key !== 'path') throw new Error(`${label} has unknown key ${key}`);
    }
    if (typeof value.root !== 'string' || !ROOT_ID.test(value.root)) throw new Error(`${label}.root must be a data root id`);
    checkRelativePath(value.path, `${label}.path`);
    return { root: value.root, path: value.path };
  }
  const forms = { path: 'a project-relative path', part: `{ "part": "${name}" }`, dataRoot: '{ root, path, pattern }', dataFile: '{ root, path }' };
  throw new Error(`${label} must be ${input.accept.map(kind => forms[kind]).join(' or ')}`);
}

function validateInputs(entry, given, options, parts) {
  if (given === undefined) given = {};
  if (!isObject(given)) throw new Error('inputs must be an object');
  for (const key of Object.keys(given)) {
    if (!(key in entry.inputs)) throw new Error(`unknown input ${key}`);
  }
  const inputs = {};
  for (const [name, input] of Object.entries(entry.inputs)) {
    const value = given[name];
    if (!holds(input.when, { options, inputs: {}, gpus: 0 })) {
      if (value !== undefined) throw new Error(`input ${name} applies only when ${describe(input.when)}`);
      continue;
    }
    if (value === undefined) {
      if (!input.optional) throw new Error(`input ${name} is required`);
      continue;
    }
    inputs[name] = validateInput(name, value, input, parts);
  }
  const used = new Set(Object.values(inputs).filter(value => isObject(value) && 'part' in value).map(value => value.part));
  for (const part of parts) {
    if (!used.has(part)) throw new Error(`uploaded part ${part} is not used by any input`);
  }
  return inputs;
}

/**
 * Validate a relion job spec. `parts` are the received multipart part names;
 * `profile` ({ cpus, gpus }) is the resource profile the job will run on, when
 * known, so a profile that cannot run the command is refused here. Returns the
 * spec with every applicable option filled in. Throws an Error whose message
 * names the first problem; both servers answer it as `invalid-spec`.
 */
export function validateRelionSpec(spec, { parts = [], profile } = {}) {
  if (!isObject(spec)) throw new Error('spec must be an object');
  for (const key of Object.keys(spec)) {
    if (!SPEC_KEYS.has(key)) throw new Error(`unknown key ${key}`);
  }
  if (spec.tool !== 'relion') throw new Error('tool must be "relion"');
  const entry = commandDefinition(spec.command);
  if (typeof spec.project !== 'string' || !PROJECT_ID.test(spec.project)) throw new Error('project must be a project id (32 lowercase hex digits)');
  if (spec.profile !== undefined && (typeof spec.profile !== 'string' || !PROFILE_NAME.test(spec.profile))) throw new Error('profile must be a profile name');
  const options = validateOptions(entry, spec.options);
  const inputs = validateInputs(entry, spec.inputs, options, new Set(parts));
  for (const rule of entry.rules ?? []) {
    if (holds(rule.when, { options, inputs, gpus: 0 })) throw new Error(rule.error);
  }
  if (profile !== undefined) relionLaunch(spec.command, profile);
  const validated = { tool: 'relion', command: spec.command, project: spec.project, inputs, options };
  if (spec.profile !== undefined) validated.profile = spec.profile;
  return validated;
}

function checkProfile(profile) {
  if (!isObject(profile)) throw new Error('profile must be an object with cpus and gpus');
  if (!Number.isInteger(profile.cpus) || profile.cpus < 1) throw new Error('profile.cpus must be a positive integer');
  if (!Number.isInteger(profile.gpus) || profile.gpus < 0) throw new Error('profile.gpus must be a non-negative integer');
}

/**
 * How a command runs on a profile: MPI ranks, threads per rank (`--j`) and
 * GPUs. Throws when the profile cannot run the command.
 */
export function relionLaunch(command, profile) {
  const { launch } = commandDefinition(command);
  checkProfile(profile);
  const gpus = launch.gpu ? profile.gpus : 0;
  let mpiRanks = 1;
  if (launch.rule === 'cpuRanks') {
    mpiRanks = Math.max(1, Math.floor(profile.cpus / launch.threadsPerRank));
  } else if (launch.rule === 'refineRanks') {
    const needed = Math.max(3, gpus + 1);
    mpiRanks = needed % 2 === 1 ? needed : needed + 1;
    if (profile.cpus < mpiRanks) throw new Error(`${command} needs ${mpiRanks} MPI ranks with at least one CPU each; the profile has ${profile.cpus} CPUs`);
  } else if (launch.rule !== 'single') {
    throw new Error(`unsupported launch rule ${launch.rule}`);
  }
  const threads = launch.threads ? Math.max(1, Math.floor(profile.cpus / mpiRanks)) : 1;
  return { mpiRanks, threads, gpus };
}

/**
 * A `number` option as typed into RELION's GUI, which passes the text to the
 * program unchanged: the shortest decimal that reads back as the same double,
 * without an exponent (`0.8851234`, `60`, `0.0000001`). Negative zero is `0`.
 */
export function typedNumber(value) {
  if (value === 0) return '0';
  const text = String(value);
  const match = /^(-?)(\d)(?:\.(\d+))?e([+-]\d+)$/.exec(text);
  if (!match) return text;
  const [, sign, lead, fraction = '', exponentText] = match;
  const digits = lead + fraction;
  const exponent = Number(exponentText);
  if (exponent < 0) return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`;
  return `${sign}${digits.padEnd(exponent + 1, '0')}`;
}

/**
 * RELION's floatToString, for the values the GUI computes (`--psi_step`,
 * `--offset_step`, `--bg_radius`): printf `%.6g` of the float32 value.
 * Negative zero is written as `0`. Like printf, it rounds the exact binary value to six
 * significant digits with ties to even (123456.5 is `123456`), which
 * `toFixed` and `toExponential` do not: they round ties up.
 */
export function relionNumber(value) {
  const single = Math.fround(value);
  if (single === 0) return '0';
  const sign = single < 0 ? '-' : '';
  const { digits, exponent } = sixSignificantDigits(Math.abs(single));
  if (exponent < -4 || exponent >= 6) {
    const mantissa = trimZeros(`${digits[0]}.${digits.slice(1)}`);
    const exponentSign = exponent < 0 ? '-' : '+';
    return `${sign}${mantissa}e${exponentSign}${String(Math.abs(exponent)).padStart(2, '0')}`;
  }
  const fixed = exponent >= 0
    ? `${digits.slice(0, exponent + 1)}.${digits.slice(exponent + 1)}`
    : `0.${'0'.repeat(-exponent - 1)}${digits}`;
  return `${sign}${trimZeros(fixed)}`;
}

// The six significant digits of a positive finite double, rounded from its
// exact decimal expansion with ties to even, and the decimal exponent of the
// first digit.
function sixSignificantDigits(value) {
  let scaled = value;
  let shift = 0;
  while (!Number.isInteger(scaled)) {
    scaled *= 2;
    shift += 1;
  }
  // value = scaled / 2^shift = scaled * 5^shift / 10^shift, exactly.
  const exact = (BigInt(scaled) * 5n ** BigInt(shift)).toString();
  let exponent = exact.length - 1 - shift;
  if (exact.length <= 6) return { digits: exact.padEnd(6, '0'), exponent };
  let head = BigInt(exact.slice(0, 6));
  const rest = exact.slice(6);
  const tie = rest[0] === '5' && /^50*$/.test(rest);
  if (rest[0] > '5' || (rest[0] === '5' && !tie) || (tie && head % 2n === 1n)) head += 1n;
  let digits = head.toString();
  if (digits.length > 6) {
    digits = digits.slice(0, 6);
    exponent += 1;
  }
  return { digits, exponent };
}

function trimZeros(text) {
  if (!text.includes('.')) return text;
  return text.replace(/0+$/, '').replace(/\.$/, '');
}

// RELION's ROUND macro.
function round(value) {
  return value > 0 ? Math.trunc(value + 0.5) : Math.trunc(value - 0.5);
}

function derive(command, spec, options) {
  if (spec.fn === 'multiply') return relionNumber(Math.fround(options[spec.option]) * spec.by);
  if (spec.fn === 'enumIndex') {
    const option = definition.commands[command].options[spec.option];
    return String(option.enum.indexOf(options[spec.option]));
  }
  if (spec.fn === 'powerSpectrumGrouping') {
    const grouping = round(Math.fround(Math.fround(options[spec.dose]) / Math.fround(options[spec.dosePerFrame])));
    return String(grouping === 0 ? 1 : grouping);
  }
  if (spec.fn === 'extractBackgroundRadius') {
    const diameter = Math.fround(options[spec.diameter]);
    const size = Math.fround(options[spec.size]);
    let radius = diameter < 0 ? 0.75 * size : diameter;
    radius /= 2;
    if (options[spec.doRescale]) {
      radius *= Math.fround(options[spec.rescale]);
      radius /= size;
    }
    return relionNumber(Math.trunc(radius));
  }
  throw new Error(`unsupported derived value ${spec.fn}`);
}

function formatOption(command, name, options, width) {
  const option = definition.commands[command].options[name];
  const value = options[name];
  if (option === undefined || value === undefined) throw new Error(`option ${name} is not set`);
  if (width !== undefined) {
    if (option.type !== 'int') throw new Error(`option ${name} cannot be zero-padded`);
    return String(value).padStart(Number(width), '0');
  }
  if (option.type === 'number') return typedNumber(value);
  if (option.type === 'int') return String(value);
  if (option.type === 'enum' || option.type === 'string') return value;
  throw new Error(`option ${name} of type ${option.type} cannot be written as an argument`);
}

function expand(template, context) {
  return template.replace(PLACEHOLDER, (match, kind, name, width) => {
    if (kind === 'dir') return context.dir;
    if (kind === 'threads') return String(context.threads);
    if (kind === 'const') return definition.constants[name];
    if (kind === 'option') return formatOption(context.command, name, context.options, width);
    if (kind === 'derived') return derive(context.command, definition.commands[context.command].derived[name], context.options);
    if (kind === 'input') {
      const path = context.inputPaths[name];
      if (typeof path !== 'string') throw new Error(`no path for input ${name}`);
      return path;
    }
    if (kind === 'inputDir' || kind === 'inputPattern') {
      const value = context.inputs[name];
      if (!isObject(value) || typeof value.pattern !== 'string') throw new Error(`input ${name} is not a data-root reference`);
      if (kind === 'inputPattern') return value.pattern;
      return ['/data', value.root, value.path].filter(part => part !== '').join('/');
    }
    throw new Error(`unsupported placeholder ${match}`);
  });
}

function expandArgs(items, context, out = []) {
  for (const item of items) {
    if (typeof item === 'string') {
      out.push(expand(item, context));
    } else if (holds(item.when, context)) {
      expandArgs(item.args, context, out);
    } else if (item.else) {
      expandArgs(item.else, context, out);
    }
  }
  return out;
}

function checkDirectory(command, directory) {
  const jobType = jobTypeDirectory(command);
  const pattern = new RegExp(`^${jobType}/job[0-9]{3,}$`);
  if (typeof directory !== 'string' || !pattern.test(directory)) throw new Error(`directory must be ${jobType}/jobNNN`);
}

/**
 * Paths of the inputs inside the container, where the project is the working
 * directory: a project path stays as it is, an uploaded part is
 * `<directory>/<name>.mrc`, a data-root reference becomes
 * `/data/<root>/<path>/<pattern>` and a data-root file `/data/<root>/<path>`.
 */
export function resolveInputPaths(validated, directory) {
  const paths = {};
  for (const [name, value] of Object.entries(validated.inputs)) {
    if (typeof value === 'string') paths[name] = value;
    else if ('part' in value) paths[name] = `${directory}/${value.part}.mrc`;
    else paths[name] = ['/data', value.root, value.path, value.pattern].filter(part => part !== undefined && part !== '').join('/');
  }
  return paths;
}

function pad3(value) {
  return String(value).padStart(3, '0');
}

// Inclusive runs of consecutive class numbers, ascending.
export function classRanges(classes) {
  const sorted = [...classes].sort((a, b) => a - b);
  const ranges = [];
  for (const value of sorted) {
    const last = ranges.at(-1);
    if (last && value === last[1] + 1) last[1] = value;
    else ranges.push([value, value]);
  }
  return ranges;
}

// relion_display's interactive class selection, without the display: one
// relion_star_handler --select per run of consecutive classes, combined when
// there is more than one run. Only the last call writes the exit marker.
function selectClassesSteps(context) {
  const data = context.inputPaths.particles;
  const output = `${context.dir}particles.star`;
  const ranges = classRanges(context.options.classes);
  const select = (from, to, file) => ['--i', data, '--o', file, '--select', 'rlnClassNumber', '--minval', String(from), '--maxval', String(to)];
  if (ranges.length === 1) {
    const [[from, to]] = ranges;
    return [{ program: 'relion_star_handler', args: [...select(from, to, output), '--pipeline_control', context.dir] }];
  }
  const files = ranges.map(([from, to]) => `${context.dir}classes_${pad3(from)}_${pad3(to)}.star`);
  const steps = ranges.map(([from, to], index) => ({ program: 'relion_star_handler', args: select(from, to, files[index]) }));
  steps.push({ program: 'relion_star_handler', args: ['--combine', '--i', files.join(' '), '--o', output, '--pipeline_control', context.dir] });
  return steps;
}

/**
 * The command line for a validated spec in job directory `directory`
 * (`Class2D/job006`) on resource profile `profile` ({ cpus, gpus }).
 * `program` runs first, under `mpirun -np mpiRanks` when mpiRanks > 1; each
 * entry of `then` runs after it, in order, stopping at the first failure.
 * Arguments exclude the launcher and the container wrapper.
 */
export function relionCommand(validated, { directory, profile, inputPaths } = {}) {
  const { command } = validated;
  const entry = commandDefinition(command);
  checkDirectory(command, directory);
  const launch = relionLaunch(command, profile);
  const context = {
    command,
    dir: `${directory}/`,
    options: validated.options,
    inputs: validated.inputs,
    inputPaths: inputPaths ?? resolveInputPaths(validated, directory),
    threads: launch.threads,
    gpus: launch.gpus,
  };
  const steps = [];
  for (const step of entry.steps) {
    if (!holds(step.when, context)) continue;
    if (step.builder === 'selectClasses') {
      steps.push(...selectClassesSteps(context));
      continue;
    }
    if (step.builder !== undefined) throw new Error(`unsupported step builder ${step.builder}`);
    const mpi = steps.length === 0 && step.mpi === true && launch.mpiRanks > 1;
    if (steps.length === 0 && launch.mpiRanks > 1 && step.mpi !== true) throw new Error(`${command} has ${launch.mpiRanks} ranks but its program is not MPI`);
    steps.push({ program: mpi ? `${step.program}_mpi` : step.program, args: expandArgs(step.args, context) });
  }
  const [first, ...then] = steps;
  return { program: first.program, args: first.args, mpiRanks: launch.mpiRanks, threads: launch.threads, gpus: launch.gpus, then };
}

/**
 * The files a successful job writes, relative to its job directory, with
 * whether success requires them.
 */
export function relionOutputs(validated) {
  const entry = commandDefinition(validated.command);
  const context = { command: validated.command, options: validated.options, inputs: validated.inputs, gpus: 0 };
  return entry.outputs
    .filter(output => holds(output.when, context))
    .map(output => ({ path: expand(output.path, context), required: output.required }));
}

const PROGRESS_BAR = /(\d+(?:\.\d+)?)\/\s*(\d+(?:\.\d+)?) (?:sec|min|hrs) (\.*)~~\(,_,">/;
const ITERATION = /(?:Gradient optimisation|Expectation) iteration (\d+) of (\d+)/;
const AUTO_REFINE_ITERATION = /Auto-refine: Iteration= (\d+)/;
const AUTO_REFINE_CONVERGED = /Auto-refine: Refinement has converged/;

function lineLevel(line) {
  if (/\bERROR\b/.test(line)) return 'error';
  if (/\b(?:WARNING|Warning)\b/.test(line)) return 'warning';
  return 'info';
}

function lineProgress(progress, line) {
  if (progress === null) return null;
  if (progress.kind === 'bar') {
    const segments = line.split('\r').reverse();
    for (const segment of segments) {
      const match = PROGRESS_BAR.exec(segment);
      if (match) return [Math.min(1, match[3].length / 60), progress.stage];
    }
    return null;
  }
  if (progress.kind === 'iterations') {
    const match = ITERATION.exec(line);
    if (!match) return null;
    const iteration = Number(match[1]);
    const total = Number(match[2]);
    if (total < 1) return null;
    return [Math.min(1, (iteration - 1) / total), `${progress.stage}: iteration ${iteration} of ${total}`];
  }
  if (progress.kind === 'autoRefine') {
    if (AUTO_REFINE_CONVERGED.test(line)) return [0.9, `${progress.stage}: final iteration`];
    const match = AUTO_REFINE_ITERATION.exec(line);
    if (!match) return null;
    const iteration = Number(match[1]);
    return [Math.min(0.9, iteration / 25), `${progress.stage}: iteration ${iteration}`];
  }
  throw new Error(`unsupported progress kind ${progress.kind}`);
}

/**
 * What one line of RELION's output says: its level (`info`, `warning`,
 * `error`) and, when it marks progress, `[fraction, stage]`.
 */
export function parseRelionLogLine(validated, line) {
  const { progress } = commandDefinition(validated.command);
  return { level: lineLevel(line), progress: lineProgress(progress, line) };
}
