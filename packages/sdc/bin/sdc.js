#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { companions } from '@neurodesk/n4/node';
import { checkInstallation, correctFiles, defaultPriorDirectory, downloadPrior } from '../src/syn/node.js';

const HELP = `Usage: sdc DWI.nii[.gz] OUTPUT_DIR --t1w T1w.nii[.gz] [options]
       sdc download-models [--cache-dir DIR]
       sdc self-check

Corrects susceptibility distortion in one DWI series with a T1w of the same
session by sdcflows 2.17.1's fieldmap-less SyN-SDC, the WebAssembly pipeline
the sdc web app runs. Writes, into a new or empty OUTPUT_DIR:

  <name>_desc-sdc_dwi.nii.gz (.bval .bvec .json)   every volume, corrected
  <name>_desc-preproc_fieldmap.nii.gz (.json)      the field in Hz
  <name>_desc-coeff_fieldmap.nii.gz (.json)        its B-spline coefficients
  <name>_from-orig_to-sdc_mode-image_xfm.nii.gz    the displacement field
  <name>_desc-brain_mask.nii.gz                    the DWI brain mask

Options:
  --t1w FILE          T1-weighted image of the same session (required)
  --bval FILE         Gradient files and sidecar; default: those beside the
  --bvec FILE         DWI with the same name
  --json FILE
  --pe-dir DIR        Phase-encoding direction (i, i-, j, j-, k, k-);
                      default: the sidecar's PhaseEncodingDirection
  --readout SECONDS   Total readout time; default: the sidecar's
                      TotalReadoutTime, else EffectiveEchoSpacing x (N_PE - 1)
  --epi-mask FILE     Brain mask on the DWI grid (default: MindGrab of the
                      mean b0)
  --t1w-mask FILE     Brain mask on the T1w grid (default: MindGrab of the T1w)
  --no-prior          Use the T1w mask in place of sdcflows' distortion prior
  --prior-dir DIR     The prior files (default NEURODESK_SDC_MODEL_DIR, else
                      ~/.cache/neurodesk/sdc/prior-<commit>)
  --seed N            antsRegistration --random-seed (default 1234)
  --workers N         Registration kernels at once (default 2)
  --offline           Never download the prior (default when
                      NEURODESK_OFFLINE=1)
  -h, --help          Show this help

Without a phase-encoding direction or a readout time the run is refused. The
registrations run on a 1.2 mm grid, single-threaded in WebAssembly: a full-brain
series takes about 1.5 to 2 hours and up to 6.5 GB of memory. NIfTI input only:
convert DICOM with dcm2niix first. Prints a JSON report.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      t1w: { type: 'string' },
      bval: { type: 'string' },
      bvec: { type: 'string' },
      json: { type: 'string' },
      'pe-dir': { type: 'string' },
      readout: { type: 'string' },
      'epi-mask': { type: 'string' },
      't1w-mask': { type: 'string' },
      'no-prior': { type: 'boolean' },
      'prior-dir': { type: 'string' },
      seed: { type: 'string' },
      workers: { type: 'string' },
      offline: { type: 'boolean' },
      'cache-dir': { type: 'string' },
    },
  });
  const [command] = positionals;
  const onProgress = (message) => process.stderr.write(`${typeof message === 'string' ? message : JSON.stringify(message)}\n`);
  const offline = values.offline || process.env.NEURODESK_OFFLINE === '1';
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    const directory = values['cache-dir'] ?? defaultPriorDirectory();
    const count = await downloadPrior({ directory, offline, onProgress });
    console.log(`${count} prior files verified in ${directory}`);
  } else {
    if (positionals.length !== 2) throw new Error('Give one DWI series and a new output directory. Use --help for options.');
    if (!values.t1w) throw new Error('Give the T1w of the same session with --t1w.');
    if (values['no-prior'] && values['prior-dir'] !== undefined) throw new Error('--no-prior and --prior-dir exclude each other.');
    const number = (name, parse) => {
      if (values[name] === undefined) return undefined;
      const value = parse(values[name]);
      if (!Number.isFinite(value)) throw new Error(`--${name} must be a number.`);
      return value;
    };
    const [dwi, output] = positionals;
    const found = await companions(dwi, { bval: values.bval, bvec: values.bvec, json: values.json });
    if (!found.bval || !found.bvec) throw new Error(`No .bval and .bvec beside ${dwi}. Give them with --bval and --bvec.`);
    let prior = null;
    if (!values['no-prior']) {
      prior = values['prior-dir'] ?? defaultPriorDirectory();
      await downloadPrior({ directory: prior, offline, onProgress });
    }
    const result = await correctFiles({
      dwi,
      ...found,
      t1w: values.t1w,
      epiMask: values['epi-mask'] ?? null,
      t1wMask: values['t1w-mask'] ?? null,
      prior,
      output,
      phaseEncodingDirection: values['pe-dir'],
      totalReadoutTime: number('readout', Number),
      seed: number('seed', Number),
      workers: number('workers', Number),
      onProgress: ({ stage, done, total }) => {
        if (done === undefined || done === total) onProgress(done === undefined ? stage : `${stage} ${done}/${total}`);
      },
    });
    console.log(JSON.stringify({ output: result.output, files: Object.keys(result.files).sort(), provenance: result.provenance }));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
