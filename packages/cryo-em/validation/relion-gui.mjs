// How a relion spec maps onto RELION 5.1.1's own job options (`run.job`
// variables), for the validation scripts that ask real RELION what it would
// run. src/commands.json names each option's variable in `gui`; this file
// adds what the table does not hold: the job type label, the input
// variables, the settings the package fixes (LoG picking, VDAM, the class
// ranker) and the radio-button texts RELION stores instead of numbers.

import { RELION_DEFINITION, relionLaunch, resolveInputPaths, typedNumber } from '../src/spec.js';

export const RELION_JOBS = {
  import: {
    label: 'relion.import.movies',
    inputs: { movies: 'fn_in_raw' },
    fixed: { do_raw: 'Yes', do_other: 'No', optics_group_name: RELION_DEFINITION.constants.opticsGroupName, fn_mtf: '' },
  },
  motioncorr: {
    label: 'relion.motioncorr.own',
    inputs: { movies: 'input_star_mics', gain: 'fn_gain_ref' },
    fixed: { do_own_motioncor: 'Yes', fn_defect: '' },
  },
  ctffind: {
    label: 'relion.ctffind.ctffind4',
    inputs: { micrographs: 'input_star_mics' },
    fixed: { fn_ctffind_exe: RELION_DEFINITION.constants.ctffindExecutable },
  },
  autopick: {
    label: 'relion.autopick.log',
    inputs: { micrographs: 'fn_input_autopick' },
    fixed: { do_log: 'Yes', do_topaz: 'No', do_refs: 'No', continue_manual: 'No', fn_topaz_exe: RELION_DEFINITION.constants.topazExecutable, do_pick_helical_segments: 'No', do_amyloid: 'No' },
  },
  extract: {
    label: 'relion.extract',
    inputs: { micrographs: 'star_mics', coordinates: 'coords_suffix' },
    fixed: { do_reextract: 'No', do_extract_helix: 'No' },
  },
  class2d: {
    label: 'relion.class2d',
    inputs: { particles: 'fn_img' },
    fixed: { fn_cont: '', do_grad: 'Yes', do_em: 'No', do_helix: 'No', scratch_dir: '' },
  },
  select: {
    label: 'relion.select.class2dauto',
    inputs: { optimiser: 'fn_model' },
    fixed: { do_class_ranker: 'Yes', do_recenter: 'No', do_regroup: 'No', do_select_values: 'No', do_discard: 'No', do_split: 'No', do_remove_duplicates: 'No', do_filaments: 'No' },
  },
  initialmodel: {
    label: 'relion.initialmodel',
    inputs: { particles: 'fn_img' },
    fixed: { fn_cont: '', scratch_dir: '' },
  },
  refine3d: {
    label: 'relion.refine3d',
    inputs: { particles: 'fn_img', reference: 'fn_ref', mask: 'fn_mask' },
    fixed: { fn_cont: '', relax_sym: '', do_helix: 'No', scratch_dir: '' },
  },
  maskcreate: {
    label: 'relion.maskcreate',
    inputs: { map: 'fn_in' },
    fixed: { do_helix: 'No' },
  },
  postprocess: {
    label: 'relion.postprocess',
    inputs: { halfMap: 'fn_in', mask: 'fn_mask' },
    fixed: { fn_mtf: '' },
  },
};

// Options RELION keeps as radio-button text; the package keeps the index.
const RADIO = {
  'motioncorr.gainRot': ['No rotation (0)', '90 degrees (1)', '180 degrees (2)', '270 degrees (3)'],
  'motioncorr.gainFlip': ['No flipping (0)', 'Flip upside down (1)', 'Flip left to right (2)'],
};

// Steps the package adds that RELION's GUI does not write: import links the
// data-root directory into its job directory first, because relion_import
// takes only relative paths.
export const PACKAGE_ONLY_PROGRAMS = { import: ['ln'] };

/**
 * What a GUI user types for each input of a job in `directory`: the input
 * paths inside the container, except that a data-root pattern is read through
 * the link import makes (`<directory>/data/<pattern>`).
 */
export function guiInputPaths(validated, directory) {
  const paths = resolveInputPaths(validated, directory);
  for (const [name, value] of Object.entries(validated.inputs)) {
    if (typeof value === 'object' && typeof value.pattern === 'string') paths[name] = `${directory}/data/${value.pattern}`;
  }
  return paths;
}

/** The GUI's text for an option value of a command. */
export function guiValue(command, name, value) {
  const option = RELION_DEFINITION.commands[command].options[name];
  const radio = RADIO[`${command}.${name}`];
  if (radio) return radio[value];
  if (option.type === 'bool') return value ? 'Yes' : 'No';
  if (option.type === 'number') return typedNumber(value);
  return String(value);
}

/**
 * The job options for `--addJobOptions`, as [variable, value] pairs: the
 * fixed settings, the inputs of a job in `directory`, every option of the validated
 * spec that has a GUI variable, and the launch on `profile`. `labels` are the
 * variables the job type has (from a job.star RELION wrote); launch variables
 * it lacks are left out. `withOptions: false` leaves the spec's options out,
 * so RELION fills in its own defaults.
 */
export function guiJobOptions(validated, { directory, profile, labels, withOptions = true }) {
  const { command } = validated;
  const job = RELION_JOBS[command];
  const pairs = Object.entries(job.fixed);
  const inputPaths = guiInputPaths(validated, directory);
  for (const [name, variable] of Object.entries(job.inputs)) {
    if (inputPaths[name] !== undefined) pairs.push([variable, inputPaths[name]]);
  }
  if (withOptions) {
    for (const [name, value] of Object.entries(validated.options)) {
      const option = RELION_DEFINITION.commands[command].options[name];
      if (option.gui === undefined) continue;
      pairs.push([option.gui, guiValue(command, name, value)]);
    }
  }
  if (profile !== undefined) {
    const launch = relionLaunch(command, profile);
    const launchPairs = [
      ['nr_mpi', String(launch.mpiRanks)],
      ['nr_threads', String(launch.threads)],
      ['use_gpu', launch.gpus > 0 ? 'Yes' : 'No'],
      ['gpu_ids', ''],
      ['do_queue', 'No'],
      ['other_args', ''],
    ];
    for (const pair of launchPairs) {
      if (labels === undefined || labels.has(pair[0])) pairs.push(pair);
    }
  }
  return pairs;
}

/**
 * The `--addJobOptions` string. RELION splits it on `;` and each item on
 * ` == `, without trimming, so items are joined without spaces.
 */
export function addJobOptions(pairs) {
  for (const [variable, value] of pairs) {
    if (value.includes(';')) throw new Error(`${variable}: RELION cannot take a value containing ';'`);
  }
  return pairs.map(([variable, value]) => `${variable} == ${value}`).join(';');
}

/** A job.star RELION reads with `--addJobFromStar`: a new (not continued) job of this type. */
export function minimalJobStar(command) {
  return [
    '# version 50001',
    '',
    'data_job',
    '',
    `_rlnJobTypeLabel             ${RELION_JOBS[command].label}`,
    '_rlnJobIsContinue                       0',
    '_rlnJobIsTomo                           0',
    '',
    'data_joboptions_values',
    '',
    'loop_',
    '_rlnJobOptionVariable #1',
    '_rlnJobOptionValue #2',
    '',
  ].join('\n');
}

/** A default_pipeline.star whose next job is number `next`. */
export function pipelineStar(next) {
  return ['# version 50001', '', 'data_pipeline_general', '', `_rlnPipeLineJobCounter                       ${next}`, '', ''].join('\n');
}

/** The joboptions_values of a job.star as a Map, quotes removed. */
export function readJobStar(text) {
  const values = new Map();
  const block = text.split('data_joboptions_values')[1] ?? '';
  for (const line of block.split('\n')) {
    const match = /^(\S+)\s+(?:"([^"]*)"|(\S+))\s*$/.exec(line.trim());
    if (!match || match[1].startsWith('_') || match[1] === 'loop_') continue;
    values.set(match[1], match[2] ?? match[3]);
  }
  return values;
}

/** The command lines of the last execution recorded in a note.txt. */
export function readNoteCommands(text) {
  const marker = ' ++++ with the following command(s): ';
  const start = text.lastIndexOf(marker);
  if (start < 0) return null;
  const lines = text.slice(start + marker.length).split('\n').slice(1);
  const end = lines.findIndex(line => line.startsWith(' ++++'));
  return end < 0 ? null : lines.slice(0, end);
}
