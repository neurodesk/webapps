#!/usr/bin/env node
import { prepareLesion, mapLesion, downloadModels, checkInstallation } from '../src/node.js';
import packageJson from '../package.json' with { type: 'json' };

const help = `calmar ${packageJson.version}
Usage:
  calmar prepare T1.nii[.gz] OUTPUT [--cache-dir DIR] [--threads N]
  calmar map LESION.nii[.gz] OUTPUT --reviewed [--atlas schaefer400|yeo7] [--structural T1.nii.gz]
             [--threshold QUANTILE] [--min-cluster N] [--cache-dir DIR]
  calmar download-models [--cache-dir DIR]
  calmar self-check
Prepare stops at a native-space candidate that requires human review.
Map accepts a reviewed atlas-space binary mask, or a native mask with --structural.
NEURODESK_OFFLINE=1 forbids downloads; portable releases include local assets.
`;
try {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || !argv.length) {
    console.log(help);
  } else if (argv.length === 1 && argv[0] === '--version') console.log(packageJson.version);
  else {
    const command = argv.shift();
    if (!['prepare', 'map', 'download-models', 'self-check'].includes(command))
      throw new Error(`Unknown command ${command}.`);
    const options = {};
    const positional = [];
    const accepted =
      command === 'prepare'
        ? ['--cache-dir', '--threads']
        : command === 'map'
        ? ['--structural', '--cache-dir', '--atlas', '--threshold', '--min-cluster', '--threads']
        : command === 'download-models'
        ? ['--cache-dir']
        : [];
    while (argv.length) {
      const arg = argv.shift();
      if (arg === '--reviewed' && command === 'map') {
        if (options.reviewed) throw new Error('Repeated option --reviewed.');
        options.reviewed = true;
        continue;
      }
      if (arg.startsWith('-')) {
        if (!accepted.includes(arg) || !argv.length || argv[0].startsWith('--'))
          throw new Error(`Invalid option ${arg}.`);
        const key = {
          '--structural': 'structural',
          '--cache-dir': 'cacheDir',
          '--threads': 'threads',
          '--atlas': 'atlas',
          '--threshold': 'threshold',
          '--min-cluster': 'minCluster',
        }[arg];
        if (key in options) throw new Error(`Repeated option ${arg}.`);
        options[key] = argv.shift();
      } else positional.push(arg);
    }
    if (['prepare', 'map'].includes(command)) {
      if (positional.length !== 2) throw new Error('Provide an input image and output directory.');
      options.input = positional[0];
      options.output = positional[1];
      console.log(
        JSON.stringify(await (command === 'prepare' ? prepareLesion : mapLesion)(options), null, 2)
      );
    } else {
      if (positional.length) throw new Error('Unexpected positional argument.');
      console.log(
        JSON.stringify(
          await (command === 'download-models' ? downloadModels(options) : checkInstallation()),
          null,
          2
        )
      );
    }
  }
} catch (error) {
  console.error(`calmar: ${error.message}`);
  process.exitCode = 1;
}
