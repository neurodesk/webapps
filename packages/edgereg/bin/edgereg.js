#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInstallation, register } from '../src/node.js';

const HELP = `Usage: edgereg MOVING.nii[.gz] FIXED.nii[.gz] OUTPUT_DIR [--robust-fov]
       edgereg self-check
       edgereg download-models [--cache-dir DIR]

Registers the moving image to the fixed image with niimath's affine
registration (-allineate, AFNI 3dAllineate's fast engine) and reslices it onto
the fixed grid, as the EdgeReg web app does, with the same WebAssembly build.
Writes the web app's download to OUTPUT_DIR, named after the moving image:

  <moving>_registered.nii   moving image on the fixed grid, in its own datatype

Options:
  --robust-fov  Crop the moving image to a robust field of view (niimath
                -robustfov) before registration, removing the neck
  -h, --help    Show this help

The written file goes to standard output; the settings that produced it go to
standard error as JSON. Inputs are 3D NIfTI; convert DICOM with dcm2niix first.
OUTPUT_DIR must be new or empty. download-models does nothing: EdgeReg uses no
model files. The native niimath (container vnmd/niimath) runs the same method
as "niimath MOVING -allineate FIXED OUT"; its output differs from the
WebAssembly build's by floating-point rounding.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'robust-fov': { type: 'boolean' },
      'cache-dir': { type: 'string' },
    },
  });
  const [command] = positionals;
  const subcommand = command === 'self-check' || command === 'download-models';
  if (subcommand && values['robust-fov']) throw new Error(`--robust-fov does not apply to ${command}.`);
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir applies only to download-models.');
  if (values.help || !command) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log('EdgeReg needs no model files; nothing to download.');
  } else {
    if (positionals.length !== 3) throw new Error('Provide a moving image, a fixed image and a new output directory. Use --help for details.');
    const [moving, fixed, output] = positionals;
    const result = await register({ moving, fixed, output, robustFov: values['robust-fov'] ?? false });
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    for (const name of result.files) console.log(join(result.output, name));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
