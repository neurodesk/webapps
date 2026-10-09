import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { gunzipSync } from 'node:zlib';
import createModule from '@niivue/niimath/niimath.js';
import { NiimathError, runNiimath } from '../src/node/niimath.js';
import { NIIMATH_CASES, REFERENCE_URL, niimathInputs, sha256 } from '../validation/cases.mjs';

const reference = JSON.parse(await readFile(REFERENCE_URL, 'utf8')).niimath;
const inputs = niimathInputs();

test('pins the niimath build the browser reference ran', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(pkg.devDependencies['@niivue/niimath'], reference.version);
});

for (const item of NIIMATH_CASES) {
  test(`niimath ${item.id} matches the browser byte for byte`, async () => {
    const args = [...item.args];
    const { outputs } = await runNiimath(createModule, args, { inputs, outputs: ['out.nii.gz'] });
    assert.equal(sha256(outputs['out.nii.gz']), reference.cases[item.id].outputs['out.nii.gz']);
    assert.deepEqual(args, item.args, 'the caller argv is left as given');
  });
}

// Native niimath is optional: set NIIMATH_NATIVE to a binary to compare with it.
test('niimath matches native niimath', { skip: !process.env.NIIMATH_NATIVE && 'set NIIMATH_NATIVE to compare with native niimath' }, async () => {
  const work = await mkdtemp(join(tmpdir(), 'niimath-native-'));
  try {
    for (const [name, bytes] of Object.entries(inputs)) await writeFile(join(work, name), bytes);
    for (const item of NIIMATH_CASES) {
      const { outputs } = await runNiimath(createModule, item.args, { inputs, outputs: ['out.nii.gz'] });
      execFileSync(process.env.NIIMATH_NATIVE, item.args, { cwd: work });
      const wasm = gunzipSync(outputs['out.nii.gz']);
      const native = gunzipSync(await readFile(join(work, 'out.nii.gz')));
      const offset = 352;
      assert.deepEqual(wasm.subarray(0, offset), native.subarray(0, offset), `${item.id} header`);
      const worst = maxRelativeDifference(voxels(wasm, offset), voxels(native, offset));
      console.log(`${item.id}: largest relative difference to native ${worst}`);
      assert.ok(worst <= (item.nativeTolerance ?? 0), `${item.id} differs from native by ${worst}`);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test('a failing command reports its log and leaves the host exit code alone', async () => {
  process.exitCode = undefined;
  await assert.rejects(
    runNiimath(createModule, ['in.nii', '-no-such-operation', 'out.nii.gz'], { inputs, outputs: ['out.nii.gz'] }),
    error => error instanceof NiimathError && error.code === 1 && /no-such-operation/.test(error.log.join('\n')),
  );
  assert.equal(process.exitCode, undefined);
});

test('each call starts from an empty file system', async () => {
  await runNiimath(createModule, ['in.nii', '-add', '1', 'out.nii.gz'], { inputs, outputs: ['out.nii.gz'] });
  await assert.rejects(
    runNiimath(createModule, ['in.nii', '-add', '1', 'other.nii.gz'], { inputs, outputs: ['out.nii.gz'] }),
    /wrote no out\.nii\.gz/,
  );
});

test('a missing output names the gzipped file niimath wrote instead', async () => {
  await assert.rejects(
    runNiimath(createModule, ['in.nii', '-add', '1', 'out.nii'], { inputs, outputs: ['out.nii'] }),
    /It wrote out\.nii\.gz/,
  );
});

function voxels(nifti, offset) {
  const datatype = new DataView(nifti.buffer, nifti.byteOffset).getInt16(70, true);
  const data = nifti.slice(offset).buffer;
  return datatype === 2 ? new Uint8Array(data) : new Float32Array(data);
}

function maxRelativeDifference(a, b) {
  assert.equal(a.length, b.length);
  let worst = 0;
  for (let i = 0; i < a.length; i++) {
    worst = Math.max(worst, Math.abs(a[i] - b[i]) / Math.max(Math.abs(b[i]), 1e-6));
  }
  return worst;
}
