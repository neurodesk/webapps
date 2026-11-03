// Opt-in scientific comparison. All data and outputs stay outside the repository.
// node packages/calmar/validation/compare-padding.mjs DATA_DIR OUTPUT_DIR MODEL_CACHE
// DATA_DIR/<subject>/{t1,mask}.nii.gz must match padding-inputs.json.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { prepareLesion } from '../src/node.js';
import { decodeVolume } from '../src/nifti.js';
import { resampleAffine } from '../src/resample.js';
import manifest from '../model.manifest.json' with { type: 'json' };
import inputs from './padding-inputs.json' with { type: 'json' };

const [dataDir, outputDir, cacheDir] = process.argv.slice(2);
if (!dataDir || !outputDir || !cacheDir) {
  throw new Error('Usage: compare-padding.mjs DATA_DIR OUTPUT_DIR MODEL_CACHE');
}
const repository = resolve(new URL('../../../', import.meta.url).pathname);
for (const directory of [dataDir, outputDir, cacheDir]) {
  const absolute = resolve(directory);
  assert.ok(absolute !== repository && !absolute.startsWith(repository + '/'), 'Keep validation data outside the source tree.');
}
const entry = manifest.modelAssets.find((asset) => asset.id === 'lnm-stroke-lesion');
const originalMode = entry.preprocessing.paddingMode;
const rows = [];
try {
  for (const subject of [...new Set(inputs.files.map((file) => file.subject))]) {
    const volumes = {};
    for (const file of inputs.files.filter((file) => file.subject === subject)) {
      const bytes = await readFile(join(dataDir, subject, file.kind + '.nii.gz'));
      assert.equal(bytes.length, file.bytes);
      assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256);
      volumes[file.kind] = decodeVolume(bytes);
    }
    const native = volumes.t1;
    const manual = volumes.mask;
    // Scanner-coordinate sampling, not anatomical T2-to-T1 registration.
    const reference = resampleAffine(
      manual.data, manual.dims, manual.affine, native.dims, native.affine, 'nearest'
    );
    for (const mode of ['multiple', 'minimum']) {
      entry.preprocessing.paddingMode = mode;
      const output = join(outputDir, subject, mode);
      await prepareLesion({
        input: join(dataDir, subject, 't1.nii.gz'),
        output, cacheDir, offline: true, threads: 4,
      });
      const candidate = decodeVolume(await readFile(join(output, 'candidate-lesion.nii')));
      assert.deepEqual(candidate.dims, native.dims);
      candidate.affine.flat().forEach((value, index) => {
        assert.ok(Math.abs(value - native.affine.flat()[index]) < 1e-4);
      });
      let tp = 0;
      let fp = 0;
      let fn = 0;
      for (let index = 0; index < reference.length; index++) {
        const predicted = candidate.data[index] > 0;
        const labelled = reference[index] > 0;
        if (predicted && labelled) tp++;
        if (predicted && !labelled) fp++;
        if (!predicted && labelled) fn++;
      }
      const row = {
        subject, mode, tp, fp, fn,
        dice: 2 * tp / Math.max(2 * tp + fp + fn, 1),
        precision: tp / Math.max(tp + fp, 1),
        recall: tp / Math.max(tp + fn, 1),
      };
      rows.push(row);
      console.log(JSON.stringify(row));
      await mkdir(outputDir, { recursive: true });
      await writeFile(join(outputDir, 'comparison.json'), JSON.stringify({ inputs, rows }, null, 2) + '\n');
    }
  }
} finally {
  entry.preprocessing.paddingMode = originalMode;
}
