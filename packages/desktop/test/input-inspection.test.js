import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync, gunzipSync } from 'node:zlib';
import { validateNiftiEncoding } from '../src/input-inspection.js';

test('encoding inspection recognizes bytes including compressed and big-endian NIfTI-2', async t => {
  const root = await mkdtemp(join(tmpdir(), 'nifti-encoding-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gzip = await readFile(new URL('../../../exes/synthseg/test/fixtures/small.nii.gz', import.meta.url));
  const nifti2 = Buffer.alloc(552);
  nifti2.writeInt32BE(540, 0);
  Buffer.from([110, 43, 50, 0, 13, 10, 26, 10]).copy(nifti2, 4);
  for (const [i, bytes] of [gzip, gunzipSync(gzip), nifti2, gzipSync(nifti2)].entries()) {
    const path = join(root, `image-${i}.data`);
    await writeFile(path, bytes);
    await validateNiftiEncoding(path);
  }
  const invalid = join(root, 'disguised.nii.gz');
  for (const bytes of [Buffer.from('MGZ'), gzipSync('not NIfTI'), nifti2.subarray(0, 80)]) {
    await writeFile(invalid, bytes);
    await assert.rejects(validateNiftiEncoding(invalid), /not a single-file NIfTI/);
  }
});
