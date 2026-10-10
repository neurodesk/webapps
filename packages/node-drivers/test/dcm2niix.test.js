import test from 'node:test';
import assert from 'node:assert/strict';
import { convertDicom } from '../src/dcm2niix.js';

// Emscripten changes the host exit code even when callMain returns normally.
const build = status => async () => ({
  FS: { mkdir() {}, writeFile() {}, readdir: () => ['.', '..', 't1.nii', 't1.json'], readFile: () => new Uint8Array([1, 2]) },
  callMain() { process.exitCode = status; return status; },
});

test('dcm2niix returns volumes for accepted statuses and preserves the host exit code', async () => {
  const hostExitCode = process.exitCode;
  for (const status of [0, 3]) {
    assert.deepEqual(await convertDicom([], build(status)), [{ name: 't1.nii', bytes: new Uint8Array([1, 2]) }]);
    assert.equal(process.exitCode, hostExitCode);
  }
  await assert.rejects(convertDicom([], build(1)), /exit code 1/);
  assert.equal(process.exitCode, hostExitCode);
});
