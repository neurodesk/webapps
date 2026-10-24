// The module worker (src/worker.js) in Node: `self` and `fetch` are replaced by small shims, so the
// test runs the worker's own message handler on the pinned build.
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { DENOISE, loadDenoise } from '../src/node.js';

const N = 12;

// A 1 mm float32 NIfTI-1 volume, N^3 voxels: a bright cube on a dark background with seeded noise.
function phantom() {
  const bytes = new Uint8Array(352 + N ** 3 * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  for (const [i, n] of [3, N, N, N, 1, 1, 1, 1].entries()) view.setInt16(40 + 2 * i, n, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (let i = 0; i < 8; i++) view.setFloat32(76 + 4 * i, 1, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  for (const [row, offset] of [[0, 280], [1, 296], [2, 312]]) view.setFloat32(offset + 4 * row, 1, true);
  bytes.set([0x6e, 0x2b, 0x31, 0x00], 344);
  let state = 12345;
  let i = 0;
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        state = (Math.imul(state, 1103515245) + 12345) >>> 0;
        const inside = Math.max(Math.abs(x - 5.5), Math.abs(y - 5.5), Math.abs(z - 5.5)) < 3;
        view.setFloat32(352 + 4 * i++, (inside ? 100 : 20) + 20 * (state / 2 ** 32 - 0.5), true);
      }
    }
  }
  return bytes;
}

const replies = [];
const saved = { self: globalThis.self, fetch: globalThis.fetch };
let dir;

before(async () => {
  dir = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'ants-denoise-worker-'));
  globalThis.self = { postMessage: (message, transfer) => replies.push({ message, transfer }) };
  globalThis.fetch = async (url) => {
    try {
      return new Response(await readFile(new URL(url)));
    } catch {
      return new Response(null, { status: 404 });
    }
  };
  await import('../src/worker.js');
});

after(async () => {
  globalThis.self = saved.self;
  globalThis.fetch = saved.fetch;
  await rm(dir, { recursive: true, force: true });
});

async function send(data) {
  replies.length = 0;
  await globalThis.self.onmessage({ data });
  assert.equal(replies.length, 1);
  return replies[0];
}

test('the worker refuses WebAssembly that is not the pinned build', async () => {
  const tampered = new Uint8Array(await readFile(DENOISE.wasm));
  tampered[tampered.length - 1] ^= 1;
  const path = join(dir, 'tampered.wasm');
  await writeFile(path, tampered);
  const { message } = await send({ id: 1, image: phantom(), kernel: { wasm: pathToFileURL(path).href } });
  assert.equal(message.id, 1);
  assert.equal(message.error, 'Denoise WebAssembly checksum mismatch.');
  assert.deepEqual(message.log, []);
  assert.equal(message.heapBytes, null);
});

test('the worker reports a missing WebAssembly file', async () => {
  const { message } = await send({ id: 2, image: phantom(), kernel: { wasm: pathToFileURL(join(dir, 'missing.wasm')).href } });
  assert.match(message.error, /did not load \(HTTP 404\)/);
});

test('the worker denoises as the Node loader does and reports its heap', async () => {
  const image = phantom();
  const expected = await (await loadDenoise()).denoise({ image });
  const { message, transfer } = await send({ id: 3, image, kernel: { module: DENOISE.module.href, wasm: DENOISE.wasm.href } });
  assert.equal(message.error, undefined);
  assert.equal(message.id, 3);
  assert.ok(message.output instanceof Uint8Array);
  assert.deepEqual(message.output, expected);
  assert.deepEqual(transfer, [message.output.buffer]);
  assert.ok(Array.isArray(message.log));
  assert.ok(Number.isSafeInteger(message.heapBytes) && message.heapBytes >= 256 * 2 ** 20);
});

test('the worker forwards a settings error with the heap of the loaded module', async () => {
  const { message } = await send({ id: 4, image: phantom(), noiseModel: 'Poisson' });
  assert.match(message.error, /noise model must be one of Gaussian, Rician/);
  assert.ok(message.heapBytes >= 256 * 2 ** 20);
});

test('the worker runs messages one at a time, in order', async () => {
  replies.length = 0;
  const image = phantom();
  const first = globalThis.self.onmessage({ data: { id: 5, image } });
  const second = globalThis.self.onmessage({ data: { id: 6, image, patchRadius: 0 } });
  await Promise.all([first, second]);
  assert.deepEqual(replies.map(({ message }) => message.id), [5, 6]);
  assert.ok(replies[0].message.output);
  assert.match(replies[1].message.error, /patch radius must be a positive integer/);
});
