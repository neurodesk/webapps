#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInstallation, registerImages } from '../src/node.js';

const HELP = `Usage: ants MOVING.nii[.gz] FIXED.nii[.gz] OUTPUT_DIR
       ants self-check
       ants download-models [--cache-dir DIR]

Registers the moving image to the fixed image with ANTs SyN, using the ANTsPy
0.6.1 type_of_transform='SyN' schedule the web app runs: an affine stage with
Mattes mutual information, then SyN, with random seed 42 on one thread. Writes
the web app's four downloads to OUTPUT_DIR, named after the moving image:

  <moving>_registered.nii.gz    moving image resliced onto the fixed grid
  <moving>_0GenericAffine.mat   affine transform
  <moving>_1Warp.nii.gz         forward warp, on the fixed grid
  <moving>_1InverseWarp.nii.gz  inverse warp

Apply them with antsApplyTransforms -t <moving>_1Warp.nii.gz
-t <moving>_0GenericAffine.mat. The log goes to standard error and the written
files to standard output.

Options:
  -h, --help  Show this help

Registers the given images as they are. Brain extraction is not included:
the web app's MindGrab step has no Node runtime yet
(https://github.com/neurodesk/webapps/issues/162). Brain extract both images
beforehand, for example with SynthStrip, when they still contain scalp.
Inputs are 3D NIfTI; convert DICOM with dcm2niix first. The WebAssembly kernel
has a 4 GiB memory limit: two 1 mm brains use about 2.8 GB. Use the native ANTs
container for larger images.
download-models does nothing: ANTs uses no model files.
OUTPUT_DIR must be new or empty.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      'cache-dir': { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values.help || !command) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log('ANTs needs no model files; nothing to download.');
  } else {
    if (values['cache-dir'] !== undefined) throw new Error('--cache-dir applies only to download-models.');
    if (positionals.length !== 3) throw new Error('Provide a moving image, a fixed image and a new output directory. Use --help for details.');
    const [moving, fixed, output] = positionals;
    const result = await registerImages({ moving, fixed, output, onLog: (line) => process.stderr.write(`${line}\n`) });
    process.stderr.write(`ANTs SyN registration in ${result.seconds.toFixed(1)} s, ${(result.heapBytes / 1e9).toFixed(2)} GB WebAssembly heap\n`);
    for (const name of result.files) console.log(join(result.output, name));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
