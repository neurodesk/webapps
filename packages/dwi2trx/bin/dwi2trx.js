#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInstallation, fit } from '../src/node.js';

const HELP = `Usage: dwi2trx DWI.nii[.gz] BVAL BVEC OUTPUT_DIR [--mask MASK.nii[.gz] | --no-mask]
       dwi2trx self-check
       dwi2trx download-models [--cache-dir DIR]

Fits the diffusion tensor as the DWI2TRX web app does: niimath --dtifit from
the same dtifit-enabled WebAssembly build, inside a MindGrab brain mask of the
first b0 volume. MindGrab runs on the CPU here (about 3 GB of memory); the web
app runs it on WebGPU. If MindGrab fails, the fit runs unmasked, as in the app.

Writes every dtifit map to OUTPUT_DIR, named after the diffusion image:

  <dwi>_FA, _MD          fractional anisotropy, mean diffusivity
  <dwi>_L1, _L2, _L3     eigenvalues
  <dwi>_V1, _V2, _V3     eigenvectors (V1 is the principal direction)
  <dwi>_S0, _MO          fitted b0 signal, mode of anisotropy
  <dwi>_tensor           the six tensor elements
  <dwi>_mask             the MindGrab brain mask, when one was computed

all as .nii.gz. <dwi>_FA and <dwi>_V1 are the web app's "Save maps" downloads.

Options:
  --mask FILE   Use this brain mask (on the diffusion grid) instead of MindGrab
  --no-mask     Fit every voxel, without a brain mask
  -h, --help    Show this help

Tractography is not included: the app tracks streamlines with WebGPU compute
shaders that need the subgroups feature, which Node has no runtime for. Track
in the web app, or from these maps with a native tool such as DIPY or MRtrix3.

bval and bvec are FSL text files listing one entry per volume. Inputs are
NIfTI; convert DICOM with dcm2niix first. OUTPUT_DIR must be new or empty. The
written files go to standard output; progress and the settings that produced
them (mask source, MindGrab version, niimath build) go to standard error.
download-models does nothing: MindGrab's weights are part of the package.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      mask: { type: 'string' },
      'no-mask': { type: 'boolean' },
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
    console.log('DWI2TRX needs no model downloads: MindGrab\'s weights are part of the package.');
  } else {
    if (values['cache-dir'] !== undefined) throw new Error('--cache-dir applies only to download-models.');
    if (positionals.length !== 4) throw new Error('Provide a diffusion image, its bval and bvec files and a new output directory. Use --help for details.');
    if (values.mask !== undefined && values['no-mask']) throw new Error('Give --mask or --no-mask, not both.');
    const [dwi, bval, bvec, output] = positionals;
    const result = await fit({ dwi, bval, bvec, output, maskFile: values.mask, noMask: values['no-mask'] ?? false, onProgress: (line) => process.stderr.write(`${line}\n`) });
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    for (const name of result.files) console.log(join(result.output, name));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
