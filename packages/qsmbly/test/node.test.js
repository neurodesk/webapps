import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import appManifest from '../../../models/qsmbly.manifest.json' with { type: 'json' };
import { EXAMPLE_ASSETS, MODEL_ASSETS, QSMXT, ensureModels, ensureNativeModelDirectory, nativeModelAssets, qsmxtEnvironment, runQsmxt } from '../src/node.js';
import { verifyNativeExamples, verifyNativeWeights } from '../src/native-registry.js';

const bin = fileURLToPath(new URL('../bin/qsmbly.js', import.meta.url));
const run = (args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

test('the CLI pins the same weights as the web app wherever both list a file', () => {
  const app = new Map(appManifest.assets.map((asset) => [asset.filename, asset]));
  let shared = 0;
  for (const asset of MODEL_ASSETS) {
    assert.match(asset.url, /^https:\/\/huggingface\.co\/qsmxt\/qsm-onnx-weights\/resolve\/[0-9a-f]{40}\//);
    assert.ok(asset.url.endsWith(`/${asset.filename}`));
    const web = app.get(asset.filename);
    if (!web) continue;
    shared += 1;
    assert.deepEqual([asset.url, asset.sha256, asset.bytes], [web.url, web.sha256, web.bytes], asset.filename);
  }
  assert.ok(shared >= 10, 'the app and CLI share the inversion and HD-BET weights');
});

test('browser reference pins its exact engine and core, with a measured native release', async () => {
  const cargo = await readFile(new URL('../../../apps/qsmbly/rust-wasm/Cargo.toml', import.meta.url), 'utf8');
  const lock = await readFile(new URL('../../../apps/qsmbly/rust-wasm/Cargo.lock', import.meta.url), 'utf8');
  const reference = JSON.parse(await readFile(new URL('../validation/browser-reference.json', import.meta.url), 'utf8'));
  const engine = /qsmxt-engine = \{[^}]*rev = "([0-9a-f]{40})"/.exec(cargo)?.[1];
  assert.match(engine ?? '', /^[0-9a-f]{40}$/);
  const lockedCommit = (name, text) => {
    const block = text.replaceAll('\r\n', '\n').split('[[package]]').find(entry => entry.includes(`name = "${name}"\n`));
    const commit = /source = "git\+[^"\n]*#([0-9a-f]{40})"/.exec(block ?? '')?.[1];
    assert.match(commit ?? '', /^[0-9a-f]{40}$/, name);
    return commit;
  };
  assert.equal(reference.qsmxtEngineCommit, engine);
  for (const text of [lock.replaceAll('\r\n', '\n'), lock.replace(/\r?\n/g, '\r\n')]) {
    assert.equal(lockedCommit('qsmxt-engine', text), engine);
    assert.equal(reference.qsmCoreCommit, lockedCommit('qsm-core', text));
  }
  assert.equal(reference.observed.nativeVersion, QSMXT.version);
  assert.equal(reference.observed.nativeCore, QSMXT.qsmCore);
  assert.deepEqual(Object.keys(QSMXT.targets).sort(), ['linux-x64', 'macos-arm64', 'windows-x64']);
  const release = JSON.parse(await readFile(new URL('../release.json', import.meta.url), 'utf8'));
  for (const [platform, target] of Object.entries(QSMXT.targets)) {
    assert.ok(target.url.startsWith(`https://github.com/QSMxT/QSMxT/releases/download/v${QSMXT.version}/qsmxt-v${QSMXT.version}-`), platform);
    assert.match(target.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(release.targets[platform].native, target.executables.map((name) => `app/native/${name}`), platform);
  }
  // The glibc build needs glibc 2.39; the static musl build runs on every x64 Linux.
  assert.match(QSMXT.targets['linux-x64'].url, /x86_64-unknown-linux-musl/);
  assert.equal(release.bundleModels, false);
});

test('offline TOML pipeline settings and model paths require the complete cache', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-config-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'settings.toml');
  for (const enabled of [true, false]) {
    await writeFile(config, `[pipeline]\ndo_segmentation = ${enabled}\ndo_analysis = ${enabled}\ndo_r2primemap = ${enabled}\ndo_chi_separation = ${enabled}\n[inversion.qsmart]\ninversion_algorithm = "qsmnet-plus"\n`);
    const result = run(['run', '/study/xqsm/bids', '/study/qsmnet/out', '--config', config], {
      XDG_CACHE_HOME: root, NEURODESK_QSMBLY_MODEL_DIR: root, NEURODESK_OFFLINE: '1',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bfrnet.onnx.*download-models/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(root), ['settings.toml']);
});

test('flaglike positional filenames do not bypass native preflight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-flags-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const env = { XDG_CACHE_HOME: root, NEURODESK_QSMBLY_MODEL_DIR: root, NEURODESK_OFFLINE: '1' };
  for (const filename of ['--help', '-h', '--dry']) {
    const result = run(['run', '--qsm-algorithm', 'xqsm', '--', filename, 'out'], env);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bfrnet.onnx.*download-models/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(root), []);
});

test('all processing commands default to complete native preflight', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-command-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const command of ['resample', 'quality-map', 'future-processing-command']) {
    const result = run([command, 'missing-input.nii'], {
      XDG_CACHE_HOME: root, NEURODESK_QSMBLY_MODEL_DIR: root, NEURODESK_OFFLINE: '1',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bfrnet.onnx.*download-models/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(root), []);
});

test('offline QSMART refuses an incomplete cache before native usage or processing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-qsmart-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variable of ['QSMBLY_OFFLINE', 'NEURODESK_OFFLINE']) {
    const result = run(['qsmart', 'field.nii', '--mask', 'mask.nii', '--output', 'out.nii', '--field-strength', '3', '--echo-time', '0.02', '--qsmart-inversion', 'xqsm'], {
      XDG_CACHE_HOME: root, NEURODESK_QSMBLY_MODEL_DIR: root, [variable]: '1',
    });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bfrnet.onnx.*download-models/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(root), []);
});

test('weights are verified before use and downloaded only when missing', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bytes = Buffer.from('weights');
  let requests = 0;
  const server = createServer((request, response) => {
    requests += 1;
    response.end(request.url === '/bad.onnx' ? Buffer.from('tampered') : bytes);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const asset = { model: 'demo', filename: 'demo.onnx', bytes: bytes.length, sha256, url: `${base}/demo.onnx` };
  const cacheDir = join(root, 'cache');
  await assert.rejects(ensureModels([asset], { cacheDir, offline: true }), /download-models/);
  assert.equal(requests, 0);
  assert.deepEqual(await ensureModels([asset], { cacheDir }), [join(cacheDir, 'demo.onnx')]);
  assert.deepEqual(await ensureModels([asset], { cacheDir }), [join(cacheDir, 'demo.onnx')]);
  assert.equal(requests, 1);
  await assert.rejects(ensureModels([{ ...asset, filename: 'bad.onnx', url: `${base}/bad.onnx` }], { cacheDir }), /checksum/);
  assert.deepEqual((await readdir(cacheDir)).sort(), ['demo.onnx'], 'a rejected download leaves nothing behind');
  await writeFile(join(cacheDir, 'demo.onnx'), 'corrupt');
  assert.deepEqual(await ensureModels([asset], { cacheDir }), [join(cacheDir, 'demo.onnx')]);
  assert.equal(requests, 3, 'a corrupt cached file is replaced');
});

test('native registry inventory covers all model cache files and rejects drift', () => {
  assert.equal(nativeModelAssets(), MODEL_ASSETS);
  const source = MODEL_ASSETS.map((asset) => `WeightFile { name: "${asset.filename}", url: "${asset.url}", sha256: "${asset.sha256}", bytes: ${asset.bytes} }`).join('\n');
  verifyNativeWeights(source, MODEL_ASSETS, QSMXT.weightFiles);
  for (const assets of [MODEL_ASSETS.slice(1), [...MODEL_ASSETS, { ...MODEL_ASSETS[0], filename: 'unknown.onnx' }], [{ ...MODEL_ASSETS[0], sha256: '0'.repeat(64) }, ...MODEL_ASSETS.slice(1)]]) {
    assert.throws(() => verifyNativeWeights(source, assets, QSMXT.weightFiles), /every hosted native/);
  }
});

test('native weights share one complete verified directory, including a partial offline model pack', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-native-models-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bundled = join(root, 'bundled');
  const cacheDir = join(root, 'cache');
  await Promise.all([bundled, cacheDir].map((path) => mkdir(path)));
  const asset = (name, bytes) => ({ model: name, filename: `${name}.onnx`, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), url: 'https://example.invalid/never-download' });
  const assets = [asset('first', 'first'), asset('second', 'second')];
  const previous = process.env.NEURODESK_QSMBLY_MODEL_DIR;
  process.env.NEURODESK_QSMBLY_MODEL_DIR = bundled;
  try {
    await writeFile(join(bundled, 'first.onnx'), 'first');
    await assert.rejects(ensureNativeModelDirectory(assets, { cacheDir, offline: true }), /second.onnx.*download-models/);
    await writeFile(join(cacheDir, 'second.onnx'), 'second');
    assert.equal(await ensureNativeModelDirectory(assets, { cacheDir, offline: true }), cacheDir);
    assert.equal(await readFile(join(cacheDir, 'first.onnx'), 'utf8'), 'first');
    await writeFile(join(bundled, 'first.onnx'), 'corrupt');
    assert.equal(await ensureNativeModelDirectory(assets, { cacheDir, offline: true }), cacheDir, 'corrupt pack cannot shadow the verified cache');
    assert.deepEqual([qsmxtEnvironment({ modelDir: cacheDir }).QSM_MODEL_DIR, qsmxtEnvironment({ modelDir: cacheDir }).QSM_MODEL_CACHE], [cacheDir, cacheDir]);
  } finally {
    if (previous === undefined) delete process.env.NEURODESK_QSMBLY_MODEL_DIR;
    else process.env.NEURODESK_QSMBLY_MODEL_DIR = previous;
  }
});

test('both offline switches refuse an incomplete native cache before launching QSMxT', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variable of ['QSMBLY_OFFLINE', 'NEURODESK_OFFLINE']) {
    const result = run(['run', 'missing-bids', 'out'], { XDG_CACHE_HOME: root, NEURODESK_QSMBLY_MODEL_DIR: root, [variable]: '1' });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /bfrnet.onnx.*download-models/);
    assert.equal(result.stdout, '');
  }
  assert.deepEqual(await readdir(root), []);
});

test('offline example downloads stop before native launch', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-example-offline-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const variable of ['QSMBLY_OFFLINE', 'NEURODESK_OFFLINE']) {
    for (const args of [['example', join(root, 'out')], ['example', '--', '--list']]) {
      const result = run(args, { XDG_CACHE_HOME: root, [variable]: '1' });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Offline QSMbly does not support example downloads/);
      assert.equal(result.stdout, '');
    }
  }
  assert.deepEqual(await readdir(root), []);
});

test('native SLURM and TUI cannot bypass wrapper preflight online or offline', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'qsmbly-slurm-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const offline of ['0', '1']) {
    for (const args of [['slurm', 'bids', 'out', '--account', 'test'], ['slurm', '--submit'], ['slurm', '--', '--help'], ['tui'], ['tui', '--', '--help']]) {
      const result = run(args, { XDG_CACHE_HOME: root, NEURODESK_OFFLINE: offline });
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /does not support native SLURM generation or the TUI/);
      assert.equal(result.stdout, '');
    }
  }
  assert.deepEqual(await readdir(root), []);
});

test('every native example URL uses the pinned mirror and registry checksums', () => {
  const base = 'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/0fe86ccf8b742dfa2272c608bf25c95f5e809853/qsmbly/native-examples/v9.22.0';
  assert.equal(EXAMPLE_ASSETS.length, 23);
  for (const asset of EXAMPLE_ASSETS) {
    assert.equal(asset.filename, `${asset.id}.zip`);
    assert.equal(asset.url, `${base}/${asset.filename}`);
  }
  assert.equal(qsmxtEnvironment({ environment: { QSMXT_EXAMPLE_BASE_URL: 'https://example.invalid/mutable' } }).QSMXT_EXAMPLE_BASE_URL, base);
  const source = EXAMPLE_ASSETS.map((asset) => `Example { id: "${asset.id}", bytes: ${asset.bytes}, sha256: "${asset.sha256}" }`).join('\n');
  verifyNativeExamples(source, EXAMPLE_ASSETS);
  for (const assets of [EXAMPLE_ASSETS.slice(1), [{ ...EXAMPLE_ASSETS[0], sha256: '0'.repeat(64) }, ...EXAMPLE_ASSETS.slice(1)]]) {
    assert.throws(() => verifyNativeExamples(source, assets), /every native QSMxT acquisition/);
  }
});

test('QSMxT reads only the complete model directory the wrapper verified', () => {
  const previous = process.env.NEURODESK_QSMBLY_MODEL_DIR;
  try {
    process.env.NEURODESK_QSMBLY_MODEL_DIR = '/opt/qsmbly/models';
    assert.deepEqual(
      [qsmxtEnvironment({ modelDir: '/cache' }).QSM_MODEL_DIR, qsmxtEnvironment({ modelDir: '/cache' }).QSM_MODEL_CACHE],
      ['/cache', '/cache'],
    );
    delete process.env.NEURODESK_QSMBLY_MODEL_DIR;
    assert.equal(qsmxtEnvironment({ modelDir: '/cache' }).QSM_MODEL_DIR, '/cache');
  } finally {
    if (previous === undefined) delete process.env.NEURODESK_QSMBLY_MODEL_DIR;
    else process.env.NEURODESK_QSMBLY_MODEL_DIR = previous;
  }
});

test('the wrapper keeps its own commands and refuses to replace the pinned QSMxT', () => {
  const help = run(['--help']);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /download-models/);
  assert.match(help.stdout, new RegExp(`QSMxT ${QSMXT.version.replaceAll('.', '\\.')}`));
  const update = run(['update']);
  assert.equal(update.status, 1);
  assert.match(update.stderr, /Install a newer QSMbly release/);
  const unknown = run(['download-models', '--model', 'nonesuch'], { QSMBLY_OFFLINE: '1' });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /Unknown model nonesuch/);
});

test('the exported native runner also refuses the mutable updater before preflight', async () => {
  await assert.rejects(runQsmxt(['update']), /Install a newer QSMbly release/);
});
