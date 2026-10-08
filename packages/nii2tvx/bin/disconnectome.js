#!/usr/bin/env node
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { ATLASES, DEFAULT_ATLAS, analyze, checkInstallation, downloadModels, findAtlas } from '../src/node.js';

const atlasHelp = ATLASES.map((atlas) => `                    ${atlas.id.padEnd(8)} ${atlas.label}${atlas.default ? ', the default' : ''}`).join('\n');

const HELP = `Usage: disconnectome LESION.nii[.gz] OUTPUT_DIR [options]
       disconnectome download-models [--cache-dir DIR]
       disconnectome self-check

Scores a lesion mask against every bundle of a tract atlas: the fraction of
each bundle's streamlines that pass through the lesion. The lesion must be on
the MNI152 1 mm grid (182 x 218 x 182, sform); normalize it with SYNcro first.

Options:
  --atlas ID        Query atlas:
${atlasHelp}
  --cache-dir DIR   Atlas directory (default NEURODESK_DISCONNECTOME_MODEL_DIR or
                    ~/.cache/neurodesk/disconnectome/<revision>)
  --offline         Never download; fail if an atlas is missing
  -h, --help        Show this help

Writes the web app's download, <lesion>_<atlas>_disconnectome.tsv: a header of
bundle names and one row of fractions; nan marks a bundle with no streamlines in
the volume. OUTPUT_DIR must be new or empty. Atlases download once and are
SHA-256 checked on every load. NIfTI input only: the web app converts DICOM.`;

try {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      atlas: { type: 'string' },
      'cache-dir': { type: 'string' },
      offline: { type: 'boolean' },
    },
  });
  const [command] = positionals;
  const onProgress = (message) => process.stderr.write(`${message}\n`);
  if (values.help) {
    console.log(HELP);
  } else if (command === 'self-check') {
    if (positionals.length !== 1) throw new Error('self-check does not accept arguments.');
    console.log(JSON.stringify(await checkInstallation()));
  } else if (command === 'download-models') {
    if (positionals.length !== 1) throw new Error('download-models does not accept positional arguments.');
    if (values.atlas !== undefined) throw new Error('download-models installs every atlas; --atlas does not apply.');
    const models = await downloadModels({ cacheDir: values['cache-dir'], offline: values.offline, onProgress });
    console.log(`${models.count} atlas files verified in ${models.directory}`);
  } else {
    if (positionals.length !== 2) throw new Error('Provide a lesion mask and a new output directory. Use --help for options.');
    const atlas = findAtlas(values.atlas ?? DEFAULT_ATLAS.id);
    const result = await analyze({
      input: positionals[0],
      output: positionals[1],
      atlas: atlas.id,
      cacheDir: values['cache-dir'],
      offline: values.offline,
      onProgress,
    });
    onProgress(`${result.damaged} of ${result.bundles} bundles disconnected (${atlas.label})`);
    console.log(join(result.output, result.file));
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
