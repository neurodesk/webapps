// The browser drivers (src/browser.js, src/browser-assets.js) in Node: a fake Worker class stands in
// for the kernel workers, a fake fetch for the network, and niimath runs its pinned build.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { runNiimath as runNodeNiimath } from '@neurodesk/node-drivers/niimath';
import createNiimath from '@niivue/niimath/niimath.js';
import { ASSETS, HELD_PENDING, assetsFor, loadAssets, manifest } from '../src/assets.js';
import { MAX_ORT_THREADS, assetUrl, configureOrt, createBrowserDrivers, denoiseError, loadBrowserAssets, registrationError, runNiimath } from '../src/browser.js';
import { n4Arguments, registrationSession } from '../src/preprocess.js';

const RUNTIME = Object.freeze({
  registration: { worker: 'https://app.test/hmc-registration/src/worker.js' },
  denoise: { worker: 'https://app.test/ants-denoise/src/worker.js', module: 'https://app.test/k/ants-denoise.mjs', wasm: 'https://app.test/k/ants-denoise.wasm' },
});

// Records every Worker; the test answers each message with reply(data) or fails it with crash().
function fakeWorkers() {
  const workers = [];
  class FakeWorker {
    constructor(url, options) {
      this.url = url;
      this.options = options;
      this.sent = [];
      this.terminated = false;
      workers.push(this);
    }
    postMessage(message) {
      this.sent.push(structuredClone(message));
    }
    terminate() {
      this.terminated = true;
    }
    reply(data) {
      this.onmessage?.({ data: { id: this.sent.at(-1).id, ...data } });
    }
    crash(message) {
      this.onerror?.({ message, preventDefault() {} });
    }
  }
  return { workers, FakeWorker };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

test('createBrowserDrivers needs both worker URLs', () => {
  assert.throws(() => createBrowserDrivers({}), /runtime\.registration\.worker/);
  assert.throws(() => createBrowserDrivers({ runtime: { registration: RUNTIME.registration } }), /runtime\.denoise\.worker/);
});

test('each createRegistration call starts its own module Worker; run follows the hmc worker protocol', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  const drivers = createBrowserDrivers({ runtime: RUNTIME, WorkerClass: FakeWorker });
  const first = await drivers.createRegistration();
  const second = await drivers.createRegistration();
  assert.equal(workers.length, 2);
  assert.equal(workers[0].url, RUNTIME.registration.worker);
  assert.deepEqual(workers[0].options, { type: 'module' });

  const inputs = { 'fixed.nii': new Uint8Array([1, 2, 3]) };
  const running = first.run(['--float', '1'], inputs);
  await tick();
  assert.deepEqual(workers[0].sent, [{ id: 0, argv: ['--float', '1'], inputs }]);
  assert.equal('kernel' in workers[0].sent[0], false);
  // The caller's bytes are copied, not moved.
  assert.equal(inputs['fixed.nii'].byteLength, 3);
  workers[0].reply({ outputs: { 'out0GenericAffine.mat': new Uint8Array([9]) }, log: ['done'] });
  assert.deepEqual(await running, { outputs: { 'out0GenericAffine.mat': new Uint8Array([9]) }, log: ['done'] });
  assert.equal(first.memoryBytes(), null);

  await first.dispose();
  assert.equal(workers[0].terminated, true);
  assert.equal(workers[1].terminated, false);
  await assert.rejects(first.run([], {}), (error) => error.aborted === true && /disposed/.test(error.message));
  await second.dispose();
});

test('a registration error keeps the log and marks kernel aborts', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  const drivers = createBrowserDrivers({ runtime: { ...RUNTIME, registration: { ...RUNTIME.registration, wasm: 'https://app.test/k/hmc.wasm' } }, WorkerClass: FakeWorker });
  const registration = await drivers.createRegistration();
  const failing = registration.run(['--float', '1'], {});
  await tick();
  assert.deepEqual(workers[0].sent[0].kernel, { wasm: 'https://app.test/k/hmc.wasm' });
  workers[0].reply({ error: 'antsRegistration failed (exit 1): bad metric', log: ['bad metric'] });
  await assert.rejects(failing, (error) => error.aborted === false && error.log[0] === 'bad metric' && /exit 1/.test(error.message));

  assert.equal(registrationError({ error: 'antsRegistration aborted (RuntimeError: unreachable): x' }).aborted, true);
  assert.equal(registrationError({ error: 'The registration kernel stopped (unreachable); load a new one.' }).aborted, true);
  assert.equal(denoiseError({ error: 'ANTs DenoiseImage aborted (RuntimeError). See processing log.' }).aborted, true);
  assert.equal(denoiseError({ error: 'ANTs DenoiseImage failed (exit 1). See processing log.' }).aborted, false);
});

test('registrationSession replaces a Worker after an abort and after its run limit', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  const drivers = createBrowserDrivers({ runtime: RUNTIME, WorkerClass: FakeWorker });
  const session = registrationSession(() => drivers.createRegistration(), 2);
  const answer = async (data) => {
    const running = session.run(['--float', '1'], {});
    await tick();
    workers.at(-1).reply(data);
    return running;
  };
  await answer({ outputs: {}, log: [] });
  await assert.rejects(answer({ error: 'antsRegistration aborted (unreachable): x', log: [] }));
  assert.equal(workers.length, 1);
  assert.equal(workers[0].terminated, true);
  await answer({ outputs: {}, log: [] });
  await answer({ outputs: {}, log: [] });
  await answer({ outputs: {}, log: [] });
  assert.equal(workers.length, 3);
  assert.deepEqual(workers.map((worker) => worker.terminated), [true, true, false]);
  await session.dispose();
  assert.equal(workers[2].terminated, true);
});

test('a Worker error rejects the pending call as an abort, and the instance refuses later work', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  const drivers = createBrowserDrivers({ runtime: RUNTIME, WorkerClass: FakeWorker });
  const registration = await drivers.createRegistration();
  const running = registration.run(['--float', '1'], {});
  await tick();
  workers[0].crash('Failed to fetch a dynamically imported module');
  await assert.rejects(running, (error) => error.aborted === true && /Failed to fetch/.test(error.message));
  await assert.rejects(registration.run([], {}), (error) => error.aborted === true && /stopped/.test(error.message));
});

test('createDenoiser sends the kernel URLs, forwards the log and reports the heap', async () => {
  const { workers, FakeWorker } = fakeWorkers();
  const lines = [];
  const drivers = createBrowserDrivers({ runtime: RUNTIME, WorkerClass: FakeWorker, onLog: (line) => lines.push(line) });
  const denoiser = await drivers.createDenoiser();
  assert.equal(workers[0].url, RUNTIME.denoise.worker);
  assert.equal(denoiser.memoryBytes(), null);
  const image = new Uint8Array([1, 2]);
  const running = denoiser.denoise({ image, mask: null });
  await tick();
  assert.deepEqual(workers[0].sent[0], { id: 0, image, mask: null, kernel: { module: RUNTIME.denoise.module, wasm: RUNTIME.denoise.wasm } });
  workers[0].reply({ output: new Uint8Array([7]), log: ['line 1'], heapBytes: 300 * 2 ** 20 });
  assert.deepEqual(await running, new Uint8Array([7]));
  assert.deepEqual(lines, ['line 1']);
  assert.equal(denoiser.memoryBytes(), 300 * 2 ** 20);

  const failing = denoiser.denoise({ image });
  await tick();
  workers[0].reply({ error: 'ANTs DenoiseImage aborted (unreachable). See processing log.', log: ['line 2'], heapBytes: 400 * 2 ** 20 });
  await assert.rejects(failing, (error) => error.aborted === true && error.log[0] === 'line 2');
  assert.deepEqual(lines, ['line 1', 'line 2']);
  assert.equal(denoiser.memoryBytes(), 400 * 2 ** 20);

  const pending = denoiser.denoise({ image });
  await denoiser.dispose();
  assert.equal(workers[0].terminated, true);
  await assert.rejects(pending, /disposed/);
});

test('configureOrt sets the wasm paths and at most MAX_ORT_THREADS threads', () => {
  const fake = { env: { wasm: {} } };
  configureOrt({ wasm: 'https://app.test/ort.wasm', mjs: 'https://app.test/ort.mjs' }, fake);
  assert.deepEqual(fake.env.wasm.wasmPaths, { wasm: 'https://app.test/ort.wasm', mjs: 'https://app.test/ort.mjs' });
  assert.ok(fake.env.wasm.numThreads >= 1 && fake.env.wasm.numThreads <= MAX_ORT_THREADS);
  const plain = { env: { wasm: {} } };
  configureOrt({ numThreads: 1 }, plain);
  assert.deepEqual(plain.env.wasm, { numThreads: 1 });
  const drivers = createBrowserDrivers({ runtime: RUNTIME });
  assert.equal(typeof drivers.ort.InferenceSession.create, 'function');
  assert.deepEqual(drivers.sessionOptions, { executionProviders: ['wasm'] });
});

// A float32 NIfTI-1 volume, N^3 voxels at 1 mm, from f(x, y, z).
function nifti(n, f) {
  const bytes = new Uint8Array(352 + n ** 3 * 4);
  const view = new DataView(bytes.buffer);
  view.setInt32(0, 348, true);
  for (const [i, size] of [3, n, n, n, 1, 1, 1, 1].entries()) view.setInt16(40 + 2 * i, size, true);
  view.setInt16(70, 16, true);
  view.setInt16(72, 32, true);
  for (let i = 0; i < 8; i++) view.setFloat32(76 + 4 * i, 1, true);
  view.setFloat32(108, 352, true);
  view.setFloat32(112, 1, true);
  view.setInt16(254, 1, true);
  for (const [row, offset] of [[0, 280], [1, 296], [2, 312]]) view.setFloat32(offset + 4 * row, 1, true);
  bytes.set([0x6e, 0x2b, 0x31, 0x00], 344);
  let i = 0;
  for (let z = 0; z < n; z++) for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) view.setFloat32(352 + 4 * i++, f(x, y, z), true);
  return bytes;
}

test('niimath runs the N4 argv of preprocess.js and writes what the Node driver writes', async () => {
  const n = 24;
  const image = nifti(n, (x, y, z) => (Math.hypot(x - 11.5, y - 11.5, z - 11.5) < 9 ? 100 * (1 + x / 48) : 5));
  const weight = nifti(n, (x, y, z) => (Math.hypot(x - 11.5, y - 11.5, z - 11.5) < 9 ? 1 : 0));
  const args = n4Arguments({ input: 'input.nii', weight: 'weight.nii', output: 'n4.nii.gz' });
  const files = () => ({ inputs: { 'input.nii': image.slice(), 'weight.nii': weight.slice() }, outputs: ['n4.nii.gz'] });
  const drivers = createBrowserDrivers({ runtime: RUNTIME });
  const exitCode = process.exitCode;
  const browser = await drivers.niimath(args, files());
  assert.equal(process.exitCode, exitCode);
  const node = await runNodeNiimath(createNiimath, args, files());
  assert.ok(browser.outputs['n4.nii.gz'].byteLength > 352);
  assert.deepEqual(browser.outputs['n4.nii.gz'], node.outputs['n4.nii.gz']);
  assert.ok(Array.isArray(browser.log));
});

test('niimath reports a failed command and a missing output', async () => {
  const image = nifti(4, () => 1);
  await assert.rejects(runNiimath(createNiimath, ['missing.nii', '-add', '1', 'out.nii'], {}), (error) => error.name === 'NiimathError' && error.code !== 0);
  await assert.rejects(
    runNiimath(createNiimath, ['in.nii', '-add', '1', 'out.nii'], { inputs: { 'in.nii': image }, outputs: ['out.nii'] }),
    /wrote no out\.nii\. It wrote out\.nii\.gz/,
  );
});

// A fetch that answers from `files` (URL to bytes) and records each URL.
function fakeFetch(files) {
  const urls = [];
  const fetch = async (url, init = {}) => {
    init.signal?.throwIfAborted();
    urls.push(String(url));
    const bytes = files(String(url));
    return bytes ? new Response(bytes) : new Response('missing', { status: 404 });
  };
  return { urls, fetch };
}

test('held assets without a base URL are refused before any download', { skip: !HELD_PENDING && 'the held assets are published' }, async () => {
  const { urls, fetch } = fakeFetch(() => new Uint8Array(1));
  await assert.rejects(loadBrowserAssets({ modes: ['t1'], fetch, cache: null }), (error) => {
    assert.match(error.message, /not published yet/);
    assert.match(error.message, /models\/bison-t1\.onnx/);
    assert.doesNotMatch(error.message, /templates\//);
    return true;
  });
  assert.deepEqual(urls, []);
});

test('published assets use their pinned URL and held assets the base URL', async () => {
  const { urls, fetch } = fakeFetch((url) => {
    const asset = ASSETS.find((candidate) => url.endsWith(candidate.filename));
    return asset ? new Uint8Array(asset.bytes) : null;
  });
  await assert.rejects(loadBrowserAssets({ modes: ['t1'], heldBaseUrl: 'https://assets.test/bison', fetch, cache: null }), /^Error: templates\/COPYING: Model SHA-256 mismatch/);
  assert.deepEqual(urls, [assetsFor(['t1'])[0].url]);
  assert.ok(urls[0].startsWith(manifest.base_url));

  const held = assetsFor(['t1']).find((asset) => asset.held);
  const { urls: heldUrls, fetch: heldFetch } = fakeFetch((url) => (url.includes('assets.test') ? new Uint8Array(held.bytes + 1) : null));
  assert.equal(assetUrl(held, 'https://assets.test/bison/'), `https://assets.test/bison/${held.filename}`);
  await assert.rejects(
    loadAssets([held], { read: async (asset) => (await heldFetch(assetUrl(asset, 'https://assets.test/bison/'))).arrayBuffer() }),
    /has \d+ bytes, not \d+/,
  );
  assert.deepEqual(heldUrls, [`https://assets.test/bison/${held.filename}`]);
});

test('a size mismatch is refused, and an abort stops the download', async () => {
  const { fetch } = fakeFetch((url) => (url.endsWith('COPYING') ? new Uint8Array(3) : new Uint8Array(1)));
  await assert.rejects(loadBrowserAssets({ modes: ['t1'], heldBaseUrl: 'https://assets.test/', fetch, cache: null }), /size mismatch/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(loadBrowserAssets({ modes: ['t1'], heldBaseUrl: 'https://assets.test/', fetch, cache: null, signal: controller.signal }), { name: 'AbortError' });
});

test('the local asset directory loads and verifies through the browser loader', { skip: !process.env.BISON_ASSET_DIR && 'set BISON_ASSET_DIR' }, async () => {
  const dir = process.env.BISON_ASSET_DIR;
  const base = 'https://assets.test/bison/';
  const fetch = async (url) => {
    const name = String(url).startsWith(base) ? String(url).slice(base.length) : ASSETS.find((asset) => asset.url === String(url))?.filename;
    return new Response(await readFile(join(dir, name)));
  };
  const progress = [];
  const assets = await loadBrowserAssets({ modes: ['t1-flair'], heldBaseUrl: base, fetch, cache: null, onProgress: (message, fraction) => progress.push([message, fraction]) });
  assert.deepEqual([...assets.keys()], assetsFor(['t1-flair']).map((asset) => asset.filename));
  assert.equal(progress[0][1], 0);
  assert.ok(progress.every(([, fraction], i) => fraction >= (progress[i - 1]?.[1] ?? 0) && fraction <= 1));
});
