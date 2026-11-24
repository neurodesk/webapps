import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODEL_ASSETS, checkInstallation, defaultCacheDir, downloadModels } from '../src/node.js';
import { METHODS, deface } from '../src/pipeline.js';

const cli = fileURLToPath(new URL('../bin/deface.js', import.meta.url));
const fixture = fileURLToPath(new URL('../../../apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz', import.meta.url));
const automation = JSON.parse(await readFile(new URL('../../../apps/deface/automation.json', import.meta.url), 'utf8'));

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'deface-node-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, cache: join(root, 'templates') };
}

function forbidNetwork(t) {
  const original = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url) => {
    requests.push(String(url));
    throw new Error('network is not available in this test');
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return requests;
}

function run(args, env = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', env: { ...process.env, NEURODESK_OFFLINE: '1', ...env } });
  if (result.error) throw result.error;
  return result;
}

// A niimath stand-in that records each argv and its staged inputs, and returns the output's name.
function recordingNiimath() {
  const calls = [];
  return {
    calls,
    async run(args, { inputs, output }) {
      calls.push({ args, inputs: Object.keys(inputs), output });
      return new TextEncoder().encode(output);
    },
  };
}

const gzipped = Uint8Array.of(0x1f, 0x8b, 0);
const templates = { template: Uint8Array.of(1), mask: Uint8Array.of(2) };

test('the command line offers exactly the web app\'s methods', () => {
  assert.deepEqual(Object.keys(METHODS), automation.operations.deface.parameters.method.enum);
  assert.equal(automation.operations.deface.parameters.method.default, 'allineate');
});

test('installation holds the MNI template and face mask the registry pins', async () => {
  const registry = JSON.parse(await readFile(new URL('../../../models/deface.manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(MODEL_ASSETS.map(({ filename }) => filename), ['avg152T1.nii.gz', 'avg152T1mask.nii.gz']);
  for (const asset of MODEL_ASSETS) {
    const pinned = registry.assets.find(({ filename }) => filename === asset.filename);
    assert.deepEqual({ ...pinned, url: undefined }, { filename: asset.filename, bytes: asset.bytes, sha256: asset.sha256, url: undefined });
    // The template names the shared catalogue's address; the mask keeps deface's base_url.
    assert.equal(asset.url, pinned.url ?? registry.base_url + asset.filename);
  }
});

test('each allineate method is one niimath -deface argv in the input datatype', async () => {
  const expected = {
    allineate: ['-deface', 'avg152T1.nii.gz', 'avg152T1mask.nii.gz'],
    allineate_robustfov: ['-robustfov', '-deface', 'avg152T1.nii.gz', 'avg152T1mask.nii.gz'],
    allineate_hel: ['-deface', 'avg152T1.nii.gz', 'avg152T1mask.nii.gz', '-cost', 'hel'],
    allineate_hel_robustfov: ['-robustfov', '-deface', 'avg152T1.nii.gz', 'avg152T1mask.nii.gz', '-cost', 'hel'],
  };
  for (const [method, operations] of Object.entries(expected)) {
    const niimath = recordingNiimath();
    const result = await deface({ input: gzipped, method, templates, niimath });
    assert.deepEqual(niimath.calls, [{
      args: ['input.nii.gz', '-gz', '0', ...operations, 'defaced.nii', '-odt', 'input'],
      inputs: ['input.nii.gz', 'avg152T1.nii.gz', 'avg152T1mask.nii.gz'],
      output: 'defaced.nii',
    }], method);
    assert.equal(result.image.name, 'defaced.nii');
    assert.equal(result.mask, undefined);
  }
});

test('an uncompressed input is staged under a .nii name', async () => {
  const niimath = recordingNiimath();
  await deface({ input: Uint8Array.of(92, 1, 0, 0), method: 'allineate', templates, niimath });
  assert.equal(niimath.calls[0].args[0], 'input.nii');
});

test('the allineate methods refuse to run without the templates', async () => {
  await assert.rejects(deface({ input: gzipped, method: 'allineate', niimath: recordingNiimath() }), /MNI template and face mask/);
});

test('MindGrab methods multiply the (cropped) input by its mask, grown for a border', async () => {
  const requests = [];
  const mindgrab = {
    version: '0.1.20260925',
    async segment(input, options) {
      requests.push({ input: new TextDecoder().decode(input), options });
      return { mask: new TextEncoder().encode('mask').buffer, backend: 'cpu', elapsedMs: 1 };
    },
  };
  const mul = (native) => ({ args: [native, '-gz', '0', '-mul', 'brain-mask.nii', 'defaced.nii', '-odt', 'input'], inputs: [native, 'brain-mask.nii'], output: 'defaced.nii' });
  const robustfov = { args: ['input.nii.gz', '-gz', '0', '-robustfov', 'robustfov.nii', '-odt', 'input'], inputs: ['input.nii.gz'], output: 'robustfov.nii' };
  const close = { args: ['mindgrab-mask.nii', '-gz', '0', '-close', '1', '8', '0', 'brain-mask.nii', '-odt', 'input'], inputs: ['mindgrab-mask.nii'], output: 'brain-mask.nii' };
  const expected = {
    mindgrab: [mul('input.nii.gz')],
    mindgrab_robust: [robustfov, mul('robustfov.nii')],
    mindgrab8: [close, mul('input.nii.gz')],
    mindgrab_robust8: [robustfov, close, mul('robustfov.nii')],
  };
  for (const [method, calls] of Object.entries(expected)) {
    const niimath = recordingNiimath();
    requests.length = 0;
    const result = await deface({ input: gzipped, method, niimath, mindgrab, mindgrabOptions: { backend: 'cpu' } });
    assert.deepEqual(niimath.calls, calls, method);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0].options, { backend: 'cpu', model: 'mindgrab', mask: true, gzipOutput: false });
    assert.equal(requests[0].input, method.includes('robust') ? 'robustfov.nii' : '\u001f�\u0000');
    assert.equal(result.mask.name, 'brain-mask.nii');
    assert.deepEqual(result.provenance.mindgrab, { version: '0.1.20260925', model: 'mindgrab', backend: 'cpu', elapsedMs: 1 });
  }
});

test('an unknown method is refused before anything runs', async () => {
  const niimath = recordingNiimath();
  await assert.rejects(deface({ input: gzipped, method: 'spm', templates, niimath }), /Method must be allineate, .* or mindgrab_robust8, not "spm"/);
  assert.deepEqual(niimath.calls, []);
});

test('the template directory comes from the launcher variable', () => {
  const original = process.env.NEURODESK_DEFACE_MODEL_DIR;
  process.env.NEURODESK_DEFACE_MODEL_DIR = '/opt/deface/models';
  try {
    assert.equal(defaultCacheDir(), '/opt/deface/models');
  } finally {
    if (original === undefined) delete process.env.NEURODESK_DEFACE_MODEL_DIR;
    else process.env.NEURODESK_DEFACE_MODEL_DIR = original;
  }
});

test('offline installation names the missing template and never downloads', async (t) => {
  const { cache } = await workspace(t);
  const requests = forbidNetwork(t);
  await assert.rejects(downloadModels({ cacheDir: cache, offline: true }), /avg152T1\.nii\.gz is missing from the offline model directory/);
  assert.deepEqual(requests, []);
});

test('a corrupted cached template fails verification instead of loading', async (t) => {
  const { cache } = await workspace(t);
  forbidNetwork(t);
  await mkdir(cache);
  await writeFile(join(cache, 'avg152T1.nii.gz'), 'not the template');
  await assert.rejects(downloadModels({ cacheDir: cache }), /Cached avg152T1\.nii\.gz failed checksum verification/);
});

test('the launcher environment alone keeps the allineate methods offline and writes nothing', async (t) => {
  const { root, cache } = await workspace(t);
  const input = join(root, 'head.nii.gz');
  await copyFile(fixture, input);
  const result = run([input, join(root, 'out')], { NEURODESK_DEFACE_MODEL_DIR: cache });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /avg152T1\.nii\.gz is missing from the offline model directory/);
  assert.deepEqual(await readdir(root), ['head.nii.gz']);
});

test('the command line refuses bad arguments before reading the input', async (t) => {
  const { root } = await workspace(t);
  const output = join(root, 'out');
  assert.match(run([fixture, output, '--method', 'spm']).stderr, /--method must be one of allineate, .*mindgrab_robust8, not "spm"/);
  assert.match(run([join(root, 'head.mgz'), output]).stderr, /is not NIfTI/);
  assert.match(run([fixture]).stderr, /Give one NIfTI image and a new output directory/);
  assert.match(run(['self-check', 'extra']).stderr, /self-check does not accept arguments/);
  assert.match(run(['download-models', '--method', 'mindgrab']).stderr, /download-models does not accept --method/);
  await mkdir(output);
  await writeFile(join(output, 'keep.txt'), 'existing');
  assert.match(run([fixture, output, '--method', 'mindgrab']).stderr, /is not empty/);
  assert.match(run(['--help']).stdout, /mindgrab_robust8/);
});

test('self-check runs the vendored niimath WebAssembly and loads MindGrab', async () => {
  const report = await checkInstallation();
  assert.equal(report.niimathSmokeTestVoxels, 512);
  assert.equal(report.mindgrab, '1.0.0');
});
