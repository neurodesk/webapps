#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { TRANSFORMS, checkInstallation, registerImages } from '../src/node.js';

const HELP = `Usage: fireants MOVING.nii[.gz] FIXED.nii[.gz] OUTPUT_DIR [options]
       fireants self-check
       fireants download-models [--cache-dir DIR]

Registers the moving image to the fixed image with FireANTs (moments, rigid,
affine, then the deformable preset) on the CPU and writes the moving image
resliced onto the fixed grid as OUTPUT_DIR/<moving>_registered.nii.gz, the web
app's download name.

Options:
  --transform NAME  Deformable preset: greedy (default) or syn
  --threads N       CPU threads (default SLURM_CPUS_PER_TASK or all cores)
  --verbose         Log every iteration instead of one line per stage
  -h, --help        Show this help

Runs on the CPU only; the web app's WebGPU backend needs a browser. Inputs are
NIfTI; convert DICOM with dcm2niix first. MindGrab brain extraction is not
included: it has no Node runtime yet, so brain extract both images beforehand
(for example in the web app) when they still contain scalp.
download-models does nothing: FireANTs uses no model files.
OUTPUT_DIR must be new or empty. The engine prints the similarity (NCC) after
each stage; more negative is better.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      transform: { type: 'string' },
      threads: { type: 'string' },
      verbose: { type: 'boolean' },
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
    console.log('FireANTs needs no model files; nothing to download.');
  } else {
    if (values['cache-dir'] !== undefined) throw new Error('--cache-dir applies only to download-models.');
    if (positionals.length !== 3) throw new Error('Provide a moving image, a fixed image and a new output directory. Use --help for options.');
    const [moving, fixed, output] = positionals;
    const result = await registerImages({
      moving,
      fixed,
      output,
      transform: values.transform ?? TRANSFORMS[0],
      threads: values.threads,
      verbose: values.verbose ? 2 : 1,
      onLog: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(`${result.transform} registration on ${result.threads} CPU thread${result.threads === 1 ? "" : "s"} in ${result.engineSeconds.toFixed(1)} s, final NCC ${result.ncc}\n`);
    console.log(join(result.output, result.files[0]));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
