import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNiftiFromVolume } from '@neurodesk/webapp-components/file-io/nifti';
import { downloadModels, segment } from '../src/node.js';
import { MODEL_ASSETS } from '../src/assets.js';

async function workspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'vesselboost-guard-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const input = join(root, 'image.nii');
  const affine = [
    [1, 0, 0, 0],
    [0, 1, 0, 0],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
  await writeFile(
    input,
    new Uint8Array(
      createNiftiFromVolume({
        img: new Float32Array(8).fill(1),
        hdr: { dims: [2, 2, 2], pixDims: [1, 1, 1], affine },
      })
    )
  );
  const options = {
    input,
    output: join(root, 'output'),
    cacheDir: join(root, 'models'),
    offline: true,
    parameters: { biasCorrection: false },
    threads: 1,
  };
  const original = globalThis.fetch;
  globalThis.fetch = () => assert.fail('guard must refuse before any network access');
  t.after(() => {
    globalThis.fetch = original;
  });
  return { root, options };
}
test('offline missing models refuse before computation, output and network', async (t) => {
  const { root, options } = await workspace(t);
  await assert.rejects(segment(options), /vesselboost.onnx is missing from offline/);
  assert.deepEqual(await readdir(root), ['image.nii']);
});
test('a corrupt cached model refuses before inference and is not silently replaced', async (t) => {
  const { options } = await workspace(t);
  await mkdir(options.cacheDir);
  // Correct length makes this an independent SHA-256 guard, not a size check.
  await writeFile(join(options.cacheDir, 'vesselboost.onnx'), Buffer.alloc(MODEL_ASSETS[0].bytes));
  await assert.rejects(segment(options), /failed checksum verification/);
  await assert.rejects(readFile(join(options.output, 'segmentation.nii')), { code: 'ENOENT' });
});
test('a nonempty output directory refuses before reading missing models', async (t) => {
  const { options } = await workspace(t);
  await mkdir(options.output);
  await writeFile(join(options.output, 'keep.txt'), 'preserve');
  await assert.rejects(segment(options), /Output directory is not empty/);
  assert.equal(await readFile(join(options.output, 'keep.txt'), 'utf8'), 'preserve');
});
test('invalid scientific parameters and threads refuse before assets or output', async (t) => {
  const { options } = await workspace(t);
  for (const parameters of [
    { model: 'unknown' },
    { threshold: NaN },
    { downsample: 0 },
    { denoise: 'typo' },
    { overlap: 0.3 },
    { minimumComponentSize: -1 },
    { brainExtraction: 'typo' },
    { brainThreshold: 2 },
    { biasCorrection: 'false' },
    { unknown: 1 },
  ]) {
    await assert.rejects(segment({ ...options, parameters }), /Invalid|must be|Unknown/);
  }
  for (const threads of [0, -1, NaN, 1.5])
    await assert.rejects(segment({ ...options, threads }), /threads must/);
});
test('download-models checks the selected offline cache rather than starting inference', async (t) => {
  const { options } = await workspace(t);
  await assert.rejects(downloadModels(options), /missing from offline/);
});
test('source and app manifests retain all model URLs, byte counts and hashes', async () => {
  const app = JSON.parse(
    await readFile(new URL('../../../models/vesselboost.manifest.json', import.meta.url))
  );
  const pkg = JSON.parse(await readFile(new URL('../model.manifest.json', import.meta.url)));
  assert.deepEqual(pkg, app);
  assert.equal(MODEL_ASSETS.length, 5);
  for (const asset of MODEL_ASSETS) assert.equal(asset.url, app.base_url + asset.filename);
});
test('direct API and CLI self-check execute with fresh empty HOME/APPDATA outside CI', async (t) => {
  const { root } = await workspace(t);
  for (const direct of [true, false]) {
    const home = join(root, direct ? 'api-home' : 'cli-home');
    await mkdir(home);
    const api = new URL('../src/node.js', import.meta.url).href;
    const args = direct
      ? [
          '--input-type=module',
          '-e',
          `const api = await import(${JSON.stringify(
            api
          )}); console.log(JSON.stringify(await api.checkInstallation()));`,
        ]
      : [fileURLToPath(new URL('../bin/vesselboost.js', import.meta.url)), 'self-check'];
    const result = spawnSync(process.execPath, args, {
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        HOME: home,
        USERPROFILE: home,
        APPDATA: home,
        LOCALAPPDATA: home,
        TMPDIR: tmpdir(),
        TEMP: tmpdir(),
        TMP: tmpdir(),
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.executable, process.execPath);
    assert.equal(report.node, process.version);
    assert.equal(report.onnxRuntime, '1.29.0');
    assert.equal(report.executionProvider, 'cpu');
    assert.deepEqual(await readdir(home, { recursive: true }), []);
  }
});
test('CLI flags reject unsupported names and mutually contradictory bias options', () => {
  const cli = fileURLToPath(new URL('../bin/vesselboost.js', import.meta.url));
  const help = spawnSync(process.execPath, [cli, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0);
  assert.match(help.stdout, /--brain-extraction/);
  for (const args of [
    ['x', 'out', '--not-an-option'],
    ['x', 'out', '--bias-correction', '--no-bias-correction'],
  ]) {
    const run = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
    assert.equal(run.status, 1);
    assert.match(run.stderr, /Unknown option|Choose one/);
  }
});
