import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readVolume } from '@neurodesk/synthsr';
import { runBet } from '../src/bet.js';
import { betRuntime } from '../src/bet-runtime.js';

const read = (path) => readFile(new URL(path, import.meta.url));
const qsmCoreSource = (lock) => /name = "qsm-core"\nversion = "[^"]*"\nsource = "([^"]+)"/.exec(lock)?.[1];

test('bet.wasm builds from the qsm-core QSMbly\'s browser bundle locks', async () => {
  const browser = qsmCoreSource(await read('../../../apps/qsmbly/rust-wasm/Cargo.lock').then(String));
  const node = qsmCoreSource(await read('../bet-wasm/Cargo.lock').then(String));
  assert.ok(browser);
  assert.equal(node, browser);
});

test('bet.wasm reproduces the browser\'s BET mask on the e2e fixture', async () => {
  const bytes = await read('../../../apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz');
  const volume = readVolume(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  const runtime = betRuntime(await WebAssembly.compile(await read('../wasm/bet.wasm')));
  const progress = [];
  const { mask } = runBet({ volume, runtime, onProgress: (value) => progress.push(value) });
  // apps/brain-extraction/e2e/app.spec.js pins the browser's mask of this image to the same digest.
  assert.equal(mask.data.reduce((sum, value) => sum + value, 0), 246875);
  assert.equal(createHash('sha256').update(mask.data).digest('hex'), '107a46c3a2f42f4a7796dc5a5b2a6660a302239ae50a0cf2eea80b1767a50862');
  assert.ok(progress.length > 2 && progress.at(-1) > 0.9, 'progress reaches the end');
});
