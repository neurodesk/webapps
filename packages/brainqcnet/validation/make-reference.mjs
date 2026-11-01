// Packs a reference run (run_reference.sh with DUMP=1) into the committed
// validation/references/<id>.json the port is checked against.
//   node validation/make-reference.mjs <id> <input.nii.gz> <run dir>
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import manifest from '../model.manifest.json' with { type: 'json' };

const [id, input, dir] = process.argv.slice(2);
const bytes = await readFile(input);
const { slices } = JSON.parse(await readFile(join(dir, 'slices.json'), 'utf8'));
const read = (name) => readFile(join(dir, name), 'utf8');
const reference = {
  id,
  input: { name: basename(input), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') },
  original: {
    image: manifest.preprocessing_contract.reference,
    checkpoint_sha256: manifest.assets[0].checkpoint_sha256,
    command: 'validation/run_reference.sh (preprocess_and_predict.sh steps, percentage, n_areas 3)',
  },
  files: {
    'table.csv': await read('table.csv'),
    'tot_df.csv': await read('tot_df.csv'),
    'x_results_locally.csv': await read('x_results_locally.csv'),
    'y_results_locally.csv': await read('y_results_locally.csv'),
    'z_results_locally.csv': await read('z_results_locally.csv'),
  },
  slices: slices.map((s) => ({ axis: s.axis, slice: s.slice, pred: s.pred, logits: s.logits, resized_sha256: s.resized_gray_sha256 })),
};
await mkdir(new URL('references/', import.meta.url), { recursive: true });
await writeFile(new URL(`references/${id}.json`, import.meta.url), JSON.stringify(reference) + '\n');
