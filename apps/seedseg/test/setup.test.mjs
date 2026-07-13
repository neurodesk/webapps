import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const setup = await readFile(join(appRoot, 'web/setup.sh'), 'utf8');

test('SeedSeg pins the current ONNX Runtime Web loader contract', () => {
  assert.match(setup, /ORT_VERSION="1\.21\.0"/);
  assert.match(setup, /\n\s+ort\.min\.js\n/);
  assert.match(setup, /\n\s+ort-wasm-simd-threaded\.mjs\n/);
  assert.match(setup, /\n\s+ort-wasm-simd-threaded\.wasm\n/);
  assert.doesNotMatch(setup, /\n\s+ort-wasm-simd-threaded\.js\n/);
});

test('downloads fail on HTTP errors and replace files atomically', () => {
  assert.match(setup, /curl --fail --show-error --silent --location/);
  assert.match(setup, /mktemp/);
  assert.match(setup, /mv "\$temporary" "\$destination"/);
});

test('generated ONNX Runtime assets are valid after setup', async (t) => {
  const wasmRoot = join(appRoot, 'web/wasm');
  const expected = new Map([
    ['ort.min.js', 100_000],
    ['ort-wasm-simd-threaded.mjs', 10_000],
    ['ort-wasm-simd-threaded.wasm', 1_000_000],
  ]);

  try {
    await stat(wasmRoot);
  } catch {
    t.skip('generated assets are validated by the build job');
    return;
  }

  for (const [name, minimumSize] of expected) {
    const path = join(wasmRoot, name);
    const metadata = await stat(path);
    assert.ok(metadata.size > minimumSize, `${name} is unexpectedly small`);
    const bytes = await readFile(path);
    if (name.endsWith('.wasm')) {
      assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109]);
    } else {
      assert.doesNotMatch(bytes.subarray(0, 200).toString(), /Couldn't find requested file|404 Not Found/);
    }
  }
});
