// Compares saved pipeline outputs (pipeline-reference.mjs <out>/outputs) with a native reference,
// without running the pipeline again. Prints one JSON line per subject and mode.
//
//   node validation/compare-outputs.mjs --runs NODE_RUN_DIR --native NATIVE_DIR --run ref-final \
//     sub-HML0541 [sub-...]
//
// NODE_RUN_DIR/<subject>/<mode>/outputs holds the downloads; NATIVE_DIR/<subject>/<run> the
// native reference (export/nifti).
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { labelAgreement, nativeOutput } from './agreement.mjs';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    runs: { type: 'string' },
    native: { type: 'string' },
    run: { type: 'string', default: 'ref-final' },
  },
});
if (!values.runs || !values.native || positionals.length === 0) throw new Error('Give --runs, --native and subjects.');

for (const subject of positionals) {
  for (const mode of ['t1', 't1-flair']) {
    const outputs = join(values.runs, subject, mode, 'outputs');
    let names;
    try {
      names = await readdir(outputs);
    } catch {
      console.log(JSON.stringify({ subject, mode, missing: outputs }));
      continue;
    }
    const read = async (suffix) => readNifti(await readFile(join(outputs, names.find((name) => name.endsWith(suffix)))), Uint8Array);
    const reference = join(values.native, subject, values.run);
    const labels = await read('_bison-labels.nii.gz');
    const mask = await read('_bison-mask.nii.gz');
    const nativeLabels = await nativeOutput(reference, mode, '_bison-labels.nii.gz');
    const nativeMask = await nativeOutput(reference, mode, '_bison-mask.nii.gz');
    const agreement = labelAgreement({ labels: labels.data, mask: mask.data, nativeLabels: nativeLabels.data, nativeMask: nativeMask.data, affine: labels.header.affine, mode });
    console.log(JSON.stringify({ subject, run: values.run, ...agreement }));
  }
}
