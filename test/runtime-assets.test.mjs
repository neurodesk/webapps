import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { access, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';

const dist = join(repoRoot, 'dist');

for (const { familyId, packageName, pinName, consumers } of [
  { familyId: 'hmc-registration-wasm', packageName: 'hmc-registration', pinName: 'HMC_REGISTRATION_WASM_SHA256', consumers: ['bison', 'hmc'] },
  { familyId: 'ants-denoise-wasm', packageName: 'ants-denoise', pinName: 'DENOISE_WASM_SHA256', consumers: ['bison', 'ants-denoise'] },
]) {
  test(`${consumers.join(' and ')} share the pinned ${packageName} binary while worker modules remain local`, async () => {
    const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
    const family = manifest.families.find(({ id }) => id === familyId);
    const pin = await import(`../packages/${packageName}/src/pin.js`);
    const checksum = pin[pinName];
    assert.equal(family?.deduplicate, true);
    assert.equal(family.files.length, 1);
    assert.equal(family.files[0].sha256, checksum);
    const runtime = `_runtime/${family.target}/${family.files[0].name}`;
    assert.equal(createHash('sha256').update(await readFile(join(dist, runtime))).digest('hex'), checksum);
    for (const app of consumers) {
      const files = await readdir(join(dist, app), { recursive: true });
      const binaryName = new RegExp(`^${packageName}(?:-[\\w-]{8})?\\.wasm$`);
      const moduleName = new RegExp(`^${packageName}(?:-[\\w-]{8})?\\.mjs$`);
      assert.ok(!files.some(file => binaryName.test(file.split('/').at(-1))), `${app}: app copy remains`);
      assert.ok(files.some(file => moduleName.test(file.split('/').at(-1))), `${app}: pthread module must remain app-local`);
      const modules = files.filter(file => /\.(?:m?js)$/.test(file));
      const references = [];
      for (const module of modules) {
        const source = await readFile(join(dist, app, module), 'utf8');
        if (source.includes(runtime)) references.push(module);
      }
      assert.ok(references.some(file => /worker.*\.js$/.test(file)), `${app}: local worker must reference the shared binary`);
    }
  });
}

test('composite site contains one checksum-verified runtime store', async () => {
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
  for (const family of manifest.families) {
    for (const file of family.files) {
      const bytes = await readFile(join(dist, '_runtime', family.target, file.name));
      assert.equal(
        createHash('sha256').update(bytes).digest('hex'),
        file.sha256,
        `${family.target}/${file.name} differs from its pinned checksum`,
      );
    }
  }
});

test('only declared app-scoped runtime families remain in composite app copies', async () => {
  const registry = await loadAppsRegistry();
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets', 'manifest.json'), 'utf8'));
  for (const app of registry.apps) {
    const appDist = join(dist, app.path);
    const ortFamily = manifest.families.find(family => app.app_scoped_runtime_families.includes(family.id) && family.files.some(file => file.name === 'ort.webgpu.bundle.min.mjs'));
    const ortHashes = new Map((ortFamily?.files ?? []).map(file => [file.name, file.sha256]));
    if (app.app_scoped_runtime_families.includes('dcm2niix')) {
      for (const file of ['index.js', 'worker.js', 'dcm2niix.js', 'dcm2niix.wasm']) {
        assert.deepEqual(await readFile(join(appDist, 'dcm2niix', file)),
          await readFile(join(dist, '_runtime', 'dcm2niix', '1.3.20260724', file)), `${app.id}: scoped ${file}`);
      }
    } else await assert.rejects(access(join(appDist, 'dcm2niix')));
    await assert.rejects(access(join(appDist, 'nifti-js')));
    await assert.rejects(access(join(appDist, 'vendor', 'webapp-components')));
    try {
      const wasm = await readdir(join(appDist, 'wasm'));
      const ortFiles = wasm.filter((name) => name.startsWith('ort')).sort();
      if (ortFamily) {
        // The shared 1.21 family also catalogs alternative loaders that not every app ships.
        const requiredFiles = ortFamily.id === 'ort-web'
          ? ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort.webgpu.bundle.min.mjs']
          : ortFamily.files.map(({ name }) => name);
        for (const name of requiredFiles) {
          assert.ok(ortFiles.includes(name), `${app.id}: missing ${name}`);
        }
        const standaloneWasm = await readdir(join(repoRoot, 'apps', app.id, 'dist', 'wasm'));
        const expectedFiles = standaloneWasm.filter(name => name.startsWith('ort')).sort();
        assert.ok(expectedFiles.length > 0, `${app.id}: standalone ORT files are missing`);
        assert.deepEqual(ortFiles, expectedFiles, `${app.id}: composite must preserve its standalone ORT files`);
        for (const name of ortFiles) {
          assert.ok(ortHashes.has(name), `${app.id}: unpinned ORT file ${name}`);
          const bytes = await readFile(join(appDist, 'wasm', name));
          assert.equal(createHash('sha256').update(bytes).digest('hex'), ortHashes.get(name), `${app.id}: scoped ${name} checksum`);
        }
      } else {
        assert.deepEqual(ortFiles, [], `${app.id} retains app-local ORT files`);
      }
    } catch (error) {
      if (error.code !== 'ENOENT' || ortFamily) throw error;
    }
  }
});

test('composite references shared runtimes from the root store', async () => {
  const registry = await loadAppsRegistry();
  let workers = 0;
  for (const app of registry.apps) {
    let source;
    try {
      source = await readFile(join(dist, app.path, 'js', 'inference-worker.js'), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    workers += 1;
    assert.match(source, /_runtime\/(?:ort-web|nifti-reader)\//, `${app.id} worker does not use shared runtime`);
    if (app.app_scoped_runtime_families.some(id => id === 'ort-web' || id.startsWith('ort-web-'))) {
      assert.match(source, /\.\.\/wasm\/ort\.webgpu\.bundle\.min\.mjs/);
      assert.doesNotMatch(source, /_runtime\/ort-web/);
    }
  }
  assert.ok(workers >= 5, `expected at least five composite inference workers, found ${workers}`);
});


test('threaded modules stay in app scope and shared ORT references name only the pinned binary', async () => {
  const registry = await loadAppsRegistry();
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const binary = manifest.families.find(family => family.id === 'ort-web-asyncify-wasm');
  assert.equal(binary.deduplicate, true);
  assert.equal(binary.files.length, 1);
  assert.equal(binary.files[0].name, 'ort-wasm-simd-threaded.asyncify-CsxMlmQ8.wasm');
  const sharedBinary = `_runtime/${binary.target}/${binary.files[0].name}`;
  const escapedBinary = sharedBinary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const exactBinaryReference = new RegExp(`${escapedBinary}(?=['"\x60])`, 'g');
  for (const app of registry.apps) {
    const directory = join(dist, app.path);
    for (const file of await readdir(directory, { recursive: true })) {
      if (!/\.(?:html|m?js)$/.test(file)) continue;
      const source = await readFile(join(directory, file), 'utf8');
      assert.doesNotMatch(source.replace(exactBinaryReference, 'verified-shared-binary'),
        /_runtime\/(?:ort-web|mindgrab-cpu|dcm2niix)\//,
        `${app.id}/${file}: threaded module escapes the app service-worker scope`);
    }
  }
});

test('composite JPEG DICOM workers use one pinned WASM without moving the workers', async () => {
  const registry = await loadAppsRegistry();
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const family = manifest.families.find(family => family.id === 'dcm2niix-jpeg');
  assert.ok(family?.deduplicate, 'JPEG DICOM WASM must declare physical deduplication');
  const asset = family.files[0];
  const runtime = join(dist, '_runtime', family.target, asset.name);
  assert.equal(createHash('sha256').update(await readFile(runtime)).digest('hex'), asset.sha256);
  let consumers = 0;
  for (const app of registry.apps) {
    const standalone = await readdir(join(repoRoot, 'apps', app.id, 'dist'), { recursive: true });
    const copies = standalone.filter(file => /(?:^|\/)dcm2niix\.jpeg[^/]*\.wasm$/.test(file));
    if (!copies.length) continue;
    consumers++;
    for (const copy of copies) await assert.rejects(access(join(dist, app.path, copy)), { code: 'ENOENT' });
    const workers = standalone.filter(file => /(?:^|\/)worker\.jpeg[^/]*\.js$/.test(file));
    assert.ok(workers.length, `${app.id}: JPEG worker must remain app-local`);
    // A bundled worker inlines the Emscripten glue; a static app keeps it beside the worker.
    const modules = standalone.filter(file => /(?:^|\/)(?:worker|dcm2niix)\.jpeg[^/]*\.js$/.test(file));
    const sources = await Promise.all(modules.map(file => readFile(join(dist, app.path, file), 'utf8')));
    assert.ok(sources.some(source => /_runtime\/dcm2niix-jpeg\/1\.2\.0\/dcm2niix\.jpeg\.wasm/.test(source)),
      `${app.id}: JPEG worker must load the shared WASM`);
  }
  assert.ok(consumers > 1, 'multiple app consumers must share the JPEG runtime');
});

test('composite apps import one nv-mcp browser client from the shared store', async () => {
  const registry = await loadAppsRegistry();
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const components = JSON.parse(await readFile(join(repoRoot, 'packages/components/package.json'), 'utf8'));
  const family = manifest.families.find(family => family.id === 'nv-mcp');
  assert.ok(family?.deduplicate, 'the nv-mcp client must declare physical deduplication');
  assert.equal(family.target, `nv-mcp/${components.devDependencies['@niivue/nv-mcp']}`,
    'the shared path must name the nv-mcp version the components bundle');
  const runtimePath = `_runtime/${family.target}/${family.files[0].name}`;
  let consumers = 0;
  for (const app of registry.apps) {
    const standalone = await readdir(join(repoRoot, 'apps', app.id, 'dist'), { recursive: true });
    const copies = standalone.filter(file => /(?:^|\/)nv-mcp-[\w-]{8}\.js$/.test(file));
    if (!copies.length) continue;
    consumers++;
    for (const copy of copies) await assert.rejects(access(join(dist, app.path, copy)), { code: 'ENOENT' }, `${app.id}/${copy} must not stay in the app`);
    let imports = 0;
    const composite = await readdir(join(dist, app.path), { recursive: true });
    for (const file of composite.filter(file => file.endsWith('.js'))) {
      const source = await readFile(join(dist, app.path, file), 'utf8');
      for (const [, reference] of source.matchAll(/import\("([^"]*nv-mcp[^"]*\.js)"\)/g)) {
        imports++;
        for (const base of ['https://example.test/', 'https://example.test/webapps/']) {
          assert.equal(new URL(reference, new URL(`${app.path}/${file}`, base)).href, new URL(runtimePath, base).href,
            `${app.id}/${file} must import the shared nv-mcp client`);
        }
      }
    }
    assert.ok(imports, `${app.id}: no module imports the shared nv-mcp client`);
  }
  assert.ok(consumers > 1, 'multiple app consumers must share the nv-mcp client');
});


test('brain extraction ships its compact shared BET kernel without a second QSM runtime', async () => {
  const directory = join(dist, 'brain-extraction', 'bet');
  assert.deepEqual((await readdir(directory, { recursive: true })).sort(), ['LICENSE', 'bet.wasm']);
  const binary = await readFile(join(directory, 'bet.wasm'));
  assert.deepEqual(binary, await readFile(join(repoRoot, 'packages/brain-extraction/wasm/bet.wasm')));
  assert.ok(binary.length < 128 * 1024, 'BET must ship the compact kernel, not the full QSM pipeline');
  await access(join(dist, 'qsmbly/wasm/qsm_wasm.js'));
  await access(join(dist, 'qsmbly/wasm/qsm_wasm_bg.wasm'));
  await access(join(dist, 'qsmbly/wasm/snippets/rayon-base/workerHelpers.js'));
});
