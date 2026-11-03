// Runs packages/sdc's SyN-SDC pipeline in Node on the app's SyN example, as the app runs it
// (seed 1234, the sdcflows prior, MindGrab masks on the CPU), and writes the SHA-256 of every
// output, decompressed, to e2e/syn-reference.json. The browser test requires the app's
// downloads to have the same hashes.
//   node apps/sdc/scripts/syn-node-reference.mjs EXAMPLE_DIR PRIOR_DIR
// EXAMPLE_DIR holds the example's files (scripts/e2e-test-data.mjs sdc --cpu provisions them as
// SDC_SYN_EXAMPLE_DIR); PRIOR_DIR holds the files of models/sdc.manifest.json.
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { correctFiles } from '@neurodesk/sdc/syn/node';

const [exampleDir, priorDir] = process.argv.slice(2);
if (!exampleDir || !priorDir) throw new Error('Usage: syn-node-reference.mjs EXAMPLE_DIR PRIOR_DIR');
const examples = JSON.parse(await readFile(new URL('../examples.json', import.meta.url), 'utf8'));
const example = examples.find((entry) => entry.method === 'syn');
const file = (role) => join(exampleDir, example.files.find((entry) => entry.role === role).name);
const started = performance.now();
const result = await correctFiles({
  dwi: file('image'),
  bval: file('bval'),
  bvec: file('bvec'),
  json: file('sidecar'),
  t1w: file('t1w'),
  prior: priorDir,
  output: join(process.env.TMPDIR ?? '.', `sdc-syn-reference-${Date.now()}`),
  onProgress: ({ stage, done, total }) => process.stderr.write(`${stage}${total ? ` ${done}/${total}` : ''}\n`),
});
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const outputs = Object.fromEntries(
  Object.entries(result.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, bytes]) => [name, sha256(name.endsWith('.gz') ? gunzipSync(bytes) : bytes)]),
);
const reference = {
  description: `packages/sdc's SyN-SDC pipeline in Node on the "${example.id}" example (apps/sdc/scripts/syn-node-reference.mjs): the SHA-256 of each output, gzip-decompressed.`,
  example: example.id,
  seed: result.provenance.Seed,
  minutes: Math.round((performance.now() - started) / 60000),
  outputs,
};
await writeFile(new URL('../e2e/syn-reference.json', import.meta.url), `${JSON.stringify(reference, null, 2)}\n`);
console.log(`wrote e2e/syn-reference.json, output in ${result.output}`);
