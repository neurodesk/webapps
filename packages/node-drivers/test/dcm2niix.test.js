import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { convertDicom } from '../src/dcm2niix.js';

// Fake glue beside a fake WASM, one per exit status. Emscripten changes the host exit code even when callMain returns normally.
const directory = await mkdtemp(join(tmpdir(), 'dcm2niix-'));
async function build(status) {
  await writeFile(join(directory, `exit${status}.wasm`), 'wasm');
  await writeFile(join(directory, `exit${status}.js`), `export default async ({ wasmBinary }) => ({
    FS: { mkdir() {}, writeFile() {}, readdir: () => ['.', '..', 't1.nii', 't1.json'], readFile: () => new Uint8Array([1, 2]) },
    callMain() { if (String(wasmBinary) !== 'wasm') throw new Error('WASM not supplied'); process.exitCode = ${status}; return ${status}; },
  });`);
  return pathToFileURL(join(directory, `exit${status}.js`));
}

test('dcm2niix returns volumes for accepted statuses and preserves the host exit code', async () => {
  const hostExitCode = process.exitCode;
  for (const status of [0, 3]) {
    assert.deepEqual(await convertDicom([], await build(status)), [{ name: 't1.nii', bytes: new Uint8Array([1, 2]) }]);
    assert.equal(process.exitCode, hostExitCode);
  }
  await assert.rejects(convertDicom([], await build(1)), /exit code 1/);
  assert.equal(process.exitCode, hostExitCode);
});
