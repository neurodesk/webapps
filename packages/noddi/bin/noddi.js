#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInstallation, fit } from '../src/node.js';

const HELP = `Usage: noddi DWI.nii[.gz] BVAL BVEC OUTPUT_DIR [options]
       noddi self-check
       noddi download-models [--cache-dir DIR]

Fits the diffusion tensor and, when the data has two or more b-value shells,
NODDI (AMICO 1.5.4 by default, or dmipy nonlinear), as the NODDI web app does: the same
WebAssembly module, inside a MindGrab brain mask of the mean b0. MindGrab runs
on the CPU here (about 2.6 GB of memory); the web app prefers the GPU.

Writes the web app's downloads to OUTPUT_DIR, named as BIDS derivatives
(BEP016) after the diffusion image, <stem> being its name without _dwi:

  <stem>_model-tensor_param-{fa,md,ad,rd,s0}_dwimap.nii.gz
  <stem>_model-tensor_param-direction_dwimap.nii.gz   principal eigenvector
  <stem>_model-noddi_param-{icvf,isovf,odi}_dwimap.nii.gz
  <stem>_model-noddi_param-direction_dwimap.nii.gz    mean fibre direction
  <stem>_desc-brain_mask.nii.gz                        the mask the fit used

With one shell, NODDI is refused and only the tensor maps are written.

Options:
  --mask FILE         Use this brain mask (on the diffusion grid) instead of MindGrab
  --no-mask           Fit every voxel, without a brain mask
  --no-noddi          Fit the tensor only
  --method TYPE       amico (default) or dmipy (nonlinear Watson NODDI)
  --tensor-fit TYPE   wls (weighted least squares, default), ols or niimath-dtifit
  --threads N         Worker threads for the fit (default: one per core)
  -h, --help          Show this help

bval and bvec are FSL text files listing one entry per volume. Inputs are
NIfTI; convert DICOM with dcm2niix first. OUTPUT_DIR must be new or empty. The
written files go to standard output; progress, then the settings that produced
them as one JSON line, go to standard error. download-models does nothing:
MindGrab's weights are part of the package.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      mask: { type: 'string' },
      'no-mask': { type: 'boolean' },
      'no-noddi': { type: 'boolean' },
      method: { type: 'string' },
      'tensor-fit': { type: 'string' },
      threads: { type: 'string' },
      'cache-dir': { type: 'string' },
    },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (values.help || !command) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept arguments.');
    console.log('noddi needs no model downloads: MindGrab\'s weights are part of the package.');
  } else {
    if (positionals.length !== 4) throw new Error('Provide a diffusion image, its bval and bvec files and a new output directory. Use --help for details.');
    if (values.mask !== undefined && values['no-mask']) throw new Error('Give --mask or --no-mask, not both.');
    if (values.threads !== undefined && !/^\d+$/.test(values.threads)) throw new Error('--threads must be a positive whole number.');
    const [dwi, bval, bvec, output] = positionals;
    const result = await fit({
      dwi,
      bval,
      bvec,
      output,
      maskFile: values.mask,
      noMask: values['no-mask'] ?? false,
      noddi: !values['no-noddi'],
      method: values.method ?? 'amico',
      tensorFit: values['tensor-fit'] ?? 'wls',
      threads: values.threads === undefined ? undefined : Number(values.threads),
      onProgress: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(`${JSON.stringify(result.provenance)}\n`);
    for (const name of result.files) console.log(join(result.output, name));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
