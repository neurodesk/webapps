#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkInstallation, registerImages } from '../src/node.js';

const HELP = `Usage: elastix-register MOVING FIXED OUTPUT_DIR [options]
       elastix-register self-check
       elastix-register download-models

Registers the moving image to the fixed image with elastix, as the elastix web
app does: the same ITK-Wasm elastix 2.1.0 build and the same presets, run on
float32 copies of both images. Writes the web app's downloads to OUTPUT_DIR,
named after the moving image:

  <moving>_registered.nii.gz             moving image resampled onto the fixed grid
  <moving>_transform.h5                  ITK HDF5 transform
  <moving>_transform.ome.zarr.ozx        OME-Zarr (RFC-5) fixed-to-moving transform:
                                         an affine for rigid and affine runs, a
                                         displacement field on the fixed grid otherwise
  <moving>_TransformParameters.N.toml    elastix parameter files, one per stage,
                                         chained; give the last one to transformix

Options:
  --method NAME          rigid, affine (default) or bspline (affine + B-spline)
  --resolutions N        multi-resolution levels, 1 to 6 (default 3)
  --grid-spacing MM      final B-spline control-point spacing (default 10)
  --parameter-file FILE  register with elastix parameter files (.txt or .toml)
                         instead of a preset; repeat for several, applied in
                         name order
  -h, --help             Show this help

Inputs are NIfTI, other ITK formats (NRRD, MHA, MGH, ...), TIFF/OME-TIFF or
OME-Zarr .ozx archives, 2D or 3D, one scalar channel. TIFF and OME-Zarr use
the finest pyramid level within 2^24 voxels, as the web app does. Convert
DICOM with dcm2niix first. The web app's registered OME-Zarr image is not
written; the registered image is NIfTI only.
The elastix log goes to standard error and the written files to standard
output. download-models does nothing: elastix uses no model files.
OUTPUT_DIR must be new or empty.`;

const PRESET_OPTIONS = ['method', 'resolutions', 'grid-spacing'];

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      method: { type: 'string' },
      resolutions: { type: 'string' },
      'grid-spacing': { type: 'string' },
      'parameter-file': { type: 'string', multiple: true },
      'cache-dir': { type: 'string' },
    },
  });
  const [command] = positionals;
  const given = (name) => values[name] !== undefined;
  if (values.help || !command) {
    console.log(HELP);
  } else if (command === 'self-check' || command === 'download-models') {
    if (positionals.length !== 1) throw new Error(`${command} does not accept arguments.`);
    if ([...PRESET_OPTIONS, 'parameter-file'].some(given)) throw new Error(`${command} does not accept registration options.`);
    if (command === 'self-check') console.log(JSON.stringify(await checkInstallation()));
    else console.log('elastix needs no model files; nothing to download.');
  } else {
    if (given('cache-dir')) throw new Error('--cache-dir applies only to download-models.');
    if (positionals.length !== 3) throw new Error('Provide a moving image, a fixed image and a new output directory. Use --help for details.');
    const parameterFiles = values['parameter-file'] ?? [];
    if (parameterFiles.length && PRESET_OPTIONS.some(given)) {
      throw new Error('--parameter-file replaces the preset; leave out --method, --resolutions and --grid-spacing.');
    }
    if (given('grid-spacing') && (values.method ?? 'affine') !== 'bspline') throw new Error('--grid-spacing applies only to --method bspline.');
    const [moving, fixed, output] = positionals;
    const result = await registerImages({
      moving,
      fixed,
      output,
      method: values.method ?? 'affine',
      resolutions: values.resolutions ?? 3,
      gridSpacing: values['grid-spacing'] ?? 10,
      parameterFiles,
      onLog: (line) => process.stderr.write(`${line}\n`),
    });
    process.stderr.write(`elastix ${result.stages.join(' -> ')} (${result.parameterSource}) in ${result.seconds.toFixed(1)} s\n`);
    for (const name of result.files) console.log(join(result.output, name));
  }
} catch (error) {
  console.error(error?.message ?? String(error));
  process.exitCode = 1;
}
