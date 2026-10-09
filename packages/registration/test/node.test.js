import assert from 'node:assert/strict';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { inflateNifti } from '../src/index.js';
import { KERNEL, loadRegistration, readRegistrationWasm } from '../src/node.js';

test('a kernel whose bytes differ from the pinned build is refused before it is loaded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'registration-kernel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wasm = join(root, 'syncro-registration.wasm');
  const module = join(root, 'syncro-registration.mjs');
  const bytes = await readFile(KERNEL.wasm);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(wasm, bytes);
  await copyFile(KERNEL.module, module);
  await assert.rejects(readRegistrationWasm(pathToFileURL(wasm)), /checksum mismatch/);
  await assert.rejects(loadRegistration({ module: pathToFileURL(module), wasm: pathToFileURL(wasm) }), /checksum mismatch/);
});

test('the pinned kernel loads', async () => {
  const ants = await loadRegistration();
  assert.ok(ants.memoryBytes() > 0);
});

test('gzipped NIfTI is inflated and uncompressed bytes pass through', async () => {
  const raw = Uint8Array.from({ length: 400 }, (_, i) => i % 251);
  assert.deepEqual(await inflateNifti(gzipSync(raw)), raw);
  assert.deepEqual(await inflateNifti(raw), raw);
});
