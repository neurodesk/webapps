import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const appRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const repoRoot = join(appRoot, '..', '..');
const pkg = JSON.parse(await readFile(join(appRoot, 'package.json'), 'utf8'));
const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
const groups = [...manifest.families, ...(manifest.downloads ?? [])];

function requestedRuntimeFiles() {
  const command = pkg.scripts.prebuild
    .split('&&')
    .map((part) => part.trim())
    .find((part) => part.includes('fetch-app-runtime.mjs'));
  assert.ok(command, 'prebuild must fetch runtime assets through the shared fetch-app-runtime.mjs');
  return command
    .split(/\s+/)
    .filter((token) => !token.startsWith('--') && token.includes(':'))
    .flatMap((spec) => {
      const separator = spec.indexOf(':');
      const group = spec.slice(0, separator);
      return spec.slice(separator + 1).split(',').filter(Boolean).map((name) => ({ group, name }));
    });
}

test('SeedSeg pins the current ONNX Runtime Web loader contract', async () => {
  const ortGroup = groups.find((group) => group.id === 'ort-web');
  assert.equal(ortGroup.version, '1.21.0');

  const requested = requestedRuntimeFiles();
  const ortFiles = requested.filter((file) => file.group === 'ort-web').map((file) => file.name).sort();
  assert.deepEqual(ortFiles, ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort.webgpu.bundle.min.mjs']);

  const worker = await readFile(join(appRoot, 'web', 'js', 'inference-worker.js'), 'utf8');
  assert.match(worker, /import\s+\*\s+as\s+ort\s+from\s+['"]\.\.\/wasm\/ort\.webgpu\.bundle\.min\.mjs['"]/,
    'the module worker must load the ESM ONNX Runtime bundle the prebuild fetches');
});

test('SeedSeg requests the QSM WASM helpers alongside ONNX Runtime', () => {
  const requested = requestedRuntimeFiles();
  const qsmFiles = requested.filter((file) => file.group === 'qsm-wasm').map((file) => file.name).sort();
  assert.deepEqual(qsmFiles, ['qsm_wasm.js', 'qsm_wasm_bg.wasm']);
});

test('every requested runtime file is checksum-pinned in the shared manifest', () => {
  for (const { group, name } of requestedRuntimeFiles()) {
    const groupEntry = groups.find((candidate) => candidate.id === group);
    assert.ok(groupEntry, `runtime group ${group} missing from runtime-assets/manifest.json`);
    assert.ok(groupEntry.download_base, `runtime group ${group} has no download_base`);
    const file = groupEntry.files.find((candidate) => candidate.name === name);
    assert.ok(file, `${group}/${name} is not pinned in runtime-assets/manifest.json`);
    assert.match(file.sha256, /^[0-9a-f]{64}$/, `${group}/${name} has no sha256 pin`);
  }
});

test('dev serving goes through the shared COOP/COEP dev server', () => {
  assert.match(pkg.scripts.dev, /dev-server\.mjs/,
    'dev must use scripts/dev-server.mjs so local serving sends cross-origin isolation headers');
});

test('fetched runtime assets match their manifest checksums', async (t) => {
  const wasmRoot = join(appRoot, 'web', 'wasm');
  try {
    await stat(wasmRoot);
  } catch {
    t.skip('generated assets are validated by the build job');
    return;
  }

  for (const { group, name } of requestedRuntimeFiles()) {
    const pinned = groups.find((candidate) => candidate.id === group).files
      .find((candidate) => candidate.name === name).sha256;
    const bytes = await readFile(join(wasmRoot, name));
    assert.ok(bytes.length > 10_000, `${name} is unexpectedly small`);
    if (name.endsWith('.wasm')) {
      assert.deepEqual([...bytes.subarray(0, 4)], [0, 97, 115, 109], `${name} is not a WASM binary`);
    }
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert.equal(actual, pinned, `${name} does not match its manifest sha256 pin`);
  }
});
