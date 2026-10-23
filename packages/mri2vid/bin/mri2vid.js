#!/usr/bin/env node
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { OPTIONS, checkInstallation, encode, optionName } from '../src/node.js';

const optionsHelp = Object.entries(OPTIONS).map(([key, option]) => {
  const value = option.type === 'boolean' ? '' : option.enum ? ` ${option.enum.join('|')}` : ' N';
  const flag = `  --${optionName(key)}${value}`;
  const fallback = option.default === undefined || option.type === 'boolean' ? '' : ` Default ${option.default}.`;
  const range = option.maximum === undefined ? '' : ` ${option.minimum} to ${option.maximum}.`;
  return `${flag}\n      ${option.description}${range}${fallback}`;
}).join('\n');

const HELP = `Usage: mri2vid INPUT... OUTPUT_DIR [options]
       mri2vid self-check

Turns the slices of one MRI volume into a video, as the mri2vid web app does.
INPUT is a NIfTI (.nii, .nii.gz) or MGZ/MGH file, or DICOM files or folders,
compressed ones included (the bundled dcm2niix decodes them). When the input
holds several DICOM series, the command lists them; choose one with --series-uid.

Options:
${optionsHelp}
  -h, --help
      Show this help

Writes <name>_<orientation>.webm or .mp4 into OUTPUT_DIR, which must be new or
empty. Frames use the full intensity range of the volume. The video is VP9
(libvpx): in WebM, as the web app writes it, or in MP4, the app's VP9 fallback.

mri2vid has no model files. "download-models [--cache-dir DIR]" exists for the
portable packager and installs nothing.`;

const options = Object.fromEntries(Object.entries(OPTIONS).map(([key, option]) => [
  optionName(key), { type: option.type === 'boolean' ? 'boolean' : 'string' },
]));

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { help: { type: 'boolean', short: 'h' }, 'cache-dir': { type: 'string' }, ...options },
  });
  const [command] = positionals;
  if (values['cache-dir'] !== undefined && command !== 'download-models') throw new Error('--cache-dir only applies to download-models.');
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    console.log(`0 model files: mri2vid has nothing to install in ${resolve(values['cache-dir'] ?? '.')}`);
  } else {
    if (positionals.length < 2) throw new Error('Give the input files or folders and a new output directory. Use --help for options.');
    const parameters = Object.fromEntries(Object.keys(OPTIONS).map((key) => [key, values[optionName(key)]]));
    const result = await encode({
      inputs: positionals.slice(0, -1),
      output: positionals.at(-1),
      parameters,
      onProgress: (message) => process.stderr.write(`${message}\n`),
    });
    const { codec, container, frames, width, height, fps } = result.summary;
    process.stderr.write(`${codec}, ${container.toUpperCase()}, ${frames} frames, ${width}x${height}, ${fps} fps\n`);
    console.log(result.output);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
