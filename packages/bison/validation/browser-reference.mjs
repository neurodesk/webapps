#!/usr/bin/env node
// Records the web app's BISON downloads for the command line's release check (cli-check.mjs):
// the SHA-256 of every file, and the voxel sum and count of every probability map. The input is
// the folder that apps/bison/e2e/pipeline.spec.js writes with BISON_BROWSER_OUTPUT set, one
// subfolder per example id.
//
//   node validation/browser-reference.mjs --from DIR [--out validation/browser-reference.json]
//
// Rerecord after a change to the pipeline, its WebAssembly tools, ONNX Runtime or the model files.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { readNifti } from '@neurodesk/webapp-components/file-io/nifti';
import { gunzipSync } from 'fflate';

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/** { name: { sha256, sum?, voxels? } } of the BISON downloads in `directory`. */
export async function measureOutputs(directory) {
  const result = {};
  for (const name of (await readdir(directory)).filter((file) => file.endsWith('.nii.gz')).sort()) {
    const bytes = await readFile(join(directory, name));
    result[name] = { sha256: sha256(bytes) };
    if (name.includes('_bison-prob-')) {
      const { data } = await readNifti(gunzipSync(bytes), Float32Array);
      let sum = 0;
      for (const value of data) sum += value;
      Object.assign(result[name], { sum, voxels: data.length });
    }
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { from: { type: 'string' }, out: { type: 'string' } } });
  if (!values.from) throw new Error('Give --from, the BISON_BROWSER_OUTPUT folder.');
  const reference = {};
  for (const example of (await readdir(values.from)).sort()) reference[example] = await measureOutputs(join(values.from, example));
  const out = values.out ?? fileURLToPath(new URL('./browser-reference.json', import.meta.url));
  await writeFile(out, `${JSON.stringify(reference, null, 2)}\n`);
  console.log(`Wrote ${out}: ${Object.keys(reference).join(', ')}`);
}
