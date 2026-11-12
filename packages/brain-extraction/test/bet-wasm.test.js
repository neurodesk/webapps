import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readVolume } from '@neurodesk/synthsr';
import { runBet } from '../src/bet.js';
import { betRuntime } from '../src/bet-runtime.js';

const read = (path) => readFile(new URL(path, import.meta.url));
// Windows checkouts may convert the lock files to CRLF.
const qsmCoreSource = (lock) => /name = "qsm-core"\r?\nversion = "[^"]*"\r?\nsource = "([^"]+)"/.exec(lock)?.[1];

test('bet.wasm builds from the qsm-core QSMbly\'s browser bundle locks', async () => {
  const browser = qsmCoreSource(await read('../../../apps/qsmbly/rust-wasm/Cargo.lock').then(String));
  const node = qsmCoreSource(await read('../bet-wasm/Cargo.lock').then(String));
  assert.ok(browser);
  assert.equal(node, browser);
});

for (const { sign, voxels, sha256 } of [
  { sign: 1, voxels: 240631, sha256: '20112e75bdaab6c8f3d9d47469b6814554f167996f4cff61e004f00207b233ad' },
  { sign: -1, voxels: 240604, sha256: '96d2ef983c9c2f1c0fc4ade67d444909893b8c4cbdb1c60528774bf7c60b8566' },
]) {
  test(`bet.wasm reproduces QSMbly's browser BET with affine x sign ${sign}`, async () => {
    const bytes = await read('../../../apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz');
    const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    volume.affine = volume.affine.map(row => Array.from(row));
    for (let row = 0; row < 3; row++) volume.affine[row][0] *= sign;
    const runtime = betRuntime(await WebAssembly.compile(await read('../wasm/bet.wasm')));
    const progress = [];
    const { mask } = runBet({ volume, runtime, onProgress: value => progress.push(value) });
    // Recorded from QSMbly's production WASM in Chromium with qsm-core 8a655f4.
    assert.equal(mask.data.reduce((sum, value) => sum + value, 0), voxels);
    assert.equal(createHash('sha256').update(mask.data).digest('hex'), sha256);
    assert.ok(progress.length > 2 && progress.at(-1) > 0.9, 'progress reaches the end');
  });
}
