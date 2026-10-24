import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { denoiseArguments } from '../src/index.js';
import { DENOISE, loadDenoise, readDenoiseWasm } from '../src/node.js';
import { DENOISE_MODULE_SHA256, DENOISE_WASM_SHA256 } from '../src/pin.js';
import { syntheticNifti } from '../../../test-utils/nifti-fixture.mjs';

const N = 20;
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

// A 1 mm NIfTI-1 volume, N^3 voxels, with a sform at the origin.
function nifti(values, datatype) {
  const bytesPerVoxel = datatype === 16 ? 4 : 1;
  const bytes = new Uint8Array(352 + values.length * bytesPerVoxel);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  for (const [i, n] of [3, N, N, N, 1, 1, 1, 1].entries()) view.setInt16(40 + 2 * i, n, true);
  view.setInt16(70, datatype, true);
  view.setInt16(72, bytesPerVoxel * 8, true);
  for (const [i, p] of [1, 1, 1, 1, 1, 1, 1, 1].entries()) view.setFloat32(76 + 4 * i, p, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  for (const [row, offset] of [[0, 280], [1, 296], [2, 312]]) view.setFloat32(offset + 4 * row, 1, true);
  bytes.set([0x6e, 0x2b, 0x31, 0x00], 344);
  for (const [i, v] of values.entries()) {
    if (datatype === 16) view.setFloat32(352 + 4 * i, v, true);
    else bytes[352 + i] = v;
  }
  return bytes;
}

// A bright sphere on a dark background with seeded uniform noise.
function phantom() {
  let state = 12345;
  const random = () => {
    state = (Math.imul(state, 1103515245) + 12345) >>> 0;
    return state / 2 ** 32;
  };
  const values = [];
  for (let z = 0; z < N; z++) {
    for (let y = 0; y < N; y++) {
      for (let x = 0; x < N; x++) {
        const inside = (x - 9.5) ** 2 + (y - 9.5) ** 2 + (z - 9.5) ** 2 < 36;
        values.push((inside ? 100 : 20) + 20 * (random() - 0.5));
      }
    }
  }
  return nifti(values, 16);
}

function halfMask() {
  const values = [];
  for (let z = 0; z < N; z++) for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) values.push(z < N / 2 ? 1 : 0);
  return nifti(values, 2);
}

const voxels = (bytes) => new Float32Array(bytes.buffer.slice(bytes.byteOffset + 352, bytes.byteOffset + bytes.length));

test('settings are explicit on the command line and invalid ones are refused', () => {
  assert.deepEqual(denoiseArguments({ input: 'i.nii', output: 'o.nii' }), ['-d', '3', '-i', 'i.nii', '-n', 'Gaussian', '-s', '1', '-p', '1', '-r', '2', '-o', 'o.nii', '-v', '0']);
  assert.deepEqual(denoiseArguments({ input: 'i.nii', output: 'o.nii', mask: 'm.nii', noiseModel: 'Rician' }).slice(4, 8), ['-x', 'm.nii', '-n', 'Rician']);
  assert.throws(() => denoiseArguments({ input: 'i', output: 'o', noiseModel: 'gaussian' }), /noise model/);
  for (const value of [0, -1, 1.5, NaN, '2']) {
    assert.throws(() => denoiseArguments({ input: 'i', output: 'o', patchRadius: value }), /patch radius/);
    assert.throws(() => denoiseArguments({ input: 'i', output: 'o', searchRadius: value }), /search radius/);
    assert.throws(() => denoiseArguments({ input: 'i', output: 'o', shrinkFactor: value }), /shrink factor/);
  }
});

test('a denoise module whose bytes differ from the pinned build is refused before it is loaded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'ants-denoise-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const wasm = join(root, 'ants-denoise.wasm');
  const module = join(root, 'ants-denoise.mjs');
  const bytes = await readFile(DENOISE.wasm);
  bytes[bytes.length - 1] ^= 1;
  await writeFile(wasm, bytes);
  await copyFile(DENOISE.module, module);
  await assert.rejects(readDenoiseWasm(pathToFileURL(wasm)), /checksum mismatch/);
  await assert.rejects(loadDenoise({ module: pathToFileURL(module), wasm: pathToFileURL(wasm) }), /checksum mismatch/);
});

test('denoising is deterministic, accepts gzipped input and leaves voxels outside the mask unchanged', async () => {
  const image = phantom();
  const first = await loadDenoise();
  const a = await first.denoise({ image });
  const b = await first.denoise({ image: gzipSync(image) });
  const c = await (await loadDenoise()).denoise({ image });
  assert.equal(sha256(a), sha256(b));
  assert.equal(sha256(a), sha256(c));
  // Pinned output of this build; a change means the module or the settings changed.
  assert.equal(sha256(a), DENOISED_PHANTOM_SHA256);
  const input = voxels(image);
  const output = voxels(a);
  let change = 0;
  for (let i = 0; i < input.length; i++) change += Math.abs(output[i] - input[i]);
  assert.ok(change / input.length > 1, 'denoising should change the noisy phantom');

  // Outside the mask each voxel is the mean of its own value over the overlapping patches, so it
  // keeps its value up to float rounding once it is beyond the patch radius of the mask edge.
  const masked = voxels(await first.denoise({ image, mask: gzipSync(halfMask()) }));
  const slice = N * N;
  let inside = 0;
  for (let i = 0; i < (N / 2) * slice; i++) inside += Math.abs(masked[i] - input[i]);
  assert.ok(inside / ((N / 2) * slice) > 1, 'voxels inside the mask should be denoised');
  for (let i = (N / 2 + 2) * slice; i < input.length; i++) assert.ok(Math.abs(masked[i] - input[i]) < 1e-4 * Math.abs(input[i]), `voxel ${i} outside the mask changed`);
});

test('settings reach DenoiseImage and an aborted module refuses further work', async () => {
  const denoiser = await loadDenoise();
  const image = phantom();
  const gaussian = await denoiser.denoise({ image });
  const rician = await denoiser.denoise({ image, noiseModel: 'Rician' });
  const wide = await denoiser.denoise({ image, searchRadius: 3 });
  assert.notEqual(sha256(rician), sha256(gaussian));
  assert.notEqual(sha256(wide), sha256(gaussian));
  // Two runs on one module leave nothing behind that changes a third.
  assert.equal(sha256(await denoiser.denoise({ image })), sha256(gaussian));
  const logs = [];
  const broken = await loadDenoise({ onLog: (line) => logs.push(line) });
  await assert.rejects(broken.denoise({ image: new Uint8Array(400) }), /DenoiseImage aborted/);
  assert.match(logs.join('\n'), /not recognized as a supported image format/);
  await assert.rejects(broken.denoise({ image }), /Create a new denoiser/);
});

test('200 consecutive denoising calls preserve the output bytes', async () => {
  const image = new Uint8Array(syntheticNifti({ dims: [8, 8, 8], gzip: false, value: (i) => 100 + i % 53 }));
  const denoiser = await loadDenoise();
  for (let run = 1; run <= 200; run++) {
    const output = await denoiser.denoise({ image });
    assert.equal(sha256(output), 'c460abeb7d65733bf676a1942a4580f6d074149944890c653220dfa8f7525c6a', `call ${run}`);
  }
});

// The full T1 volume takes about 10 minutes, so it runs only when ANTS_DENOISE_REFERENCE names it.
const reference = process.env.ANTS_DENOISE_REFERENCE;
test('the module reproduces the reference denoised T1', { skip: !reference && 'set ANTS_DENOISE_REFERENCE to the reference T1 (.nii.gz)' }, async () => {
  const out = await (await loadDenoise()).denoise({ image: await readFile(reference) });
  assert.equal(sha256(out), REFERENCE_SHA256);
});

const DENOISED_PHANTOM_SHA256 = '054126ef8ba346974289d70af7213e7564f056c6d4aa740882f211a9c9765842';
const REFERENCE_SHA256 = '58c3e0e2adbaad5dd6624ea8d7c98cdce35de85b1cc150deb43161f4ed8c9f44';

test('the committed module files match their pins', async () => {
  assert.equal(sha256(await readFile(DENOISE.wasm)), DENOISE_WASM_SHA256);
  assert.equal(sha256(await readFile(DENOISE.module)), DENOISE_MODULE_SHA256);
});
