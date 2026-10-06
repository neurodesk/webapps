import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const url = 'https://assets.invalid/shared.nii.gz';
const bytes = Buffer.from('shared fixture asset');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const lockedAsset = {
  sha256,
  bytes: bytes.length,
  contentType: 'application/octet-stream',
  kind: 'example',
  license: 'MIT',
  dependencies: [],
};

async function fixture(t, { model = false, conflict = false, locked = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'lock-example-assets-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['scripts/lib', 'registry', 'models', 'apps/alpha', 'apps/beta', 'storage']) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of ['scripts/lock-example-assets.mjs', 'scripts/lib/apps-registry.mjs', 'scripts/lib/model-assets.mjs']) {
    await copyFile(join(repoRoot, path), join(root, path));
  }
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const files = {
    'registry/apps.yml': {
      site: {
        domain: 'fixture.invalid',
        analytics: { measurement_id: 'G-FIXTURE', period_days: 30 },
        categories: [{ id: 'test', title: 'Test', description: 'Test apps' }],
      },
      apps: ['alpha', 'beta'].map(id => ({
        id,
        path: id,
        title: id,
        description: 'Fixture app',
        categories: ['test'],
        keywords: ['test'],
        runtime: 'static-esm',
        shell: 'static-html',
        support_status: 'experimental',
        maintainers: ['fixture'],
        source: 'fixture/apps',
        license: 'MIT',
        model_manifest: null,
        asset_manifest_schema: null,
        ci: { toolchains: ['node'], shared_runtime: false, release: false },
      })),
    },
    'apps/alpha/examples.json': [{
      id: 'first',
      files: [{ name: 'alpha.nii.gz', url, sha256: conflict ? '0'.repeat(64) : sha256, license: 'MIT' }],
    }],
    'apps/beta/examples.json': model ? [] : [{
      id: 'second',
      files: [{ name: 'beta.nii.gz', url, sha256, license: 'CC0-1.0' }],
    }],
    'registry/offline-assets.sources.json': { apps: { alpha: [], beta: [] } },
    'registry/offline-assets.lock.json': { assets: locked ? { [url]: lockedAsset } : {}, apps: { alpha: [], beta: [] } },
  };
  if (model) {
    files['models/beta.manifest.json'] = {
      app: 'beta',
      license: 'Apache-2.0',
      assets: [{ filename: 'beta.bin', url, sha256, bytes: bytes.length }],
    };
  } else {
    files['apps/alpha/examples.json'].push({
      id: 'repeated',
      files: [{ name: 'alpha-again.nii.gz', url, sha256, license: 'MIT' }],
    });
  }
  for (const [path, value] of Object.entries(files)) {
    await writeFile(join(root, path), JSON.stringify(value));
  }
  await writeFile(join(root, 'requests.jsonl'), '');
  await writeFile(join(root, 'fetch.mjs'), `
import { appendFile } from 'node:fs/promises';
globalThis.fetch = async (url) => {
  if (url !== ${JSON.stringify(url)}) throw new Error('Unexpected URL: ' + url);
  await appendFile(new URL('./requests.jsonl', import.meta.url), JSON.stringify(url) + '\\n');
  return new Response(Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'));
};
`);
  return {
    root,
    run() {
      return new Promise((resolve, reject) => {
        execFile(process.execPath, ['--import', join(root, 'fetch.mjs'), join(root, 'scripts/lock-example-assets.mjs')], {
          env: { ...process.env, TMPDIR: join(root, 'storage') },
          timeout: 10000,
        }, (error, stdout, stderr) => {
          if (error && typeof error.code !== 'number') return reject(error);
          resolve({ status: error?.code ?? 0, stdout, stderr });
        });
      });
    },
    async read(path) {
      return JSON.parse(await readFile(join(root, path), 'utf8'));
    },
    async requests() {
      const text = await readFile(join(root, 'requests.jsonl'), 'utf8');
      return text.trim() ? text.trim().split('\n').map(line => JSON.parse(line)) : [];
    },
    async snapshot() {
      return Promise.all(Object.keys(files).map(path => readFile(join(root, path), 'utf8')));
    },
  };
}

for (const model of [false, true]) {
  test(`registers every owner of a shared ${model ? 'example and model' : 'example'} URL`, async t => {
    const f = await fixture(t, { model });
    const result = await f.run();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(await f.requests(), [url], 'acquire shared bytes once');
    const sources = await f.read('registry/offline-assets.sources.json');
    const lock = await f.read('registry/offline-assets.lock.json');
    assert.deepEqual(lock.apps, { alpha: [url], beta: [url] });
    assert.deepEqual(sources.apps, {
      alpha: [{ url, sha256, bytes: bytes.length, kind: 'example', license: 'MIT' }],
      beta: [{ url, sha256, bytes: bytes.length, kind: model ? 'model' : 'example', license: model ? 'Apache-2.0' : 'CC0-1.0' }],
    });
    assert.equal(lock.assets[url].kind, model ? 'model' : 'example');
    assert.equal(lock.assets[url].license, model ? 'Apache-2.0' : 'CC0-1.0');
    const firstRun = await f.snapshot();
    assert.equal((await f.run()).status, 0);
    assert.deepEqual(await f.snapshot(), firstRun, 'rerunning must not duplicate owners or rewrite metadata');
    assert.deepEqual(await f.requests(), [url]);
  });
}

test('retains existing owner and global lock metadata on rerun', async t => {
  const f = await fixture(t, { locked: true });
  const sources = { apps: Object.fromEntries(['alpha', 'beta'].map(app => [app, [{
    url,
    sha256: 'outdated',
    bytes: 1,
    kind: 'existing-kind',
    license: 'existing-license',
    note: app,
  }]])) };
  await writeFile(join(f.root, 'registry/offline-assets.sources.json'), JSON.stringify(sources));
  const result = await f.run();
  assert.equal(result.status, 0, result.stderr);
  for (const entries of Object.values(sources.apps)) Object.assign(entries[0], { sha256, bytes: bytes.length });
  assert.deepEqual(await f.read('registry/offline-assets.sources.json'), sources);
  assert.deepEqual((await f.read('registry/offline-assets.lock.json')).assets, { [url]: lockedAsset });
  const firstRun = await f.snapshot();
  assert.equal((await f.run()).status, 0);
  assert.deepEqual(await f.snapshot(), firstRun);
  assert.deepEqual(await f.requests(), []);
});

for (const locked of [false, true]) {
  test(`rejects an earlier owner's conflicting checksum for ${locked ? 'locked' : 'new'} bytes before writing`, async t => {
    const f = await fixture(t, { model: true, conflict: true, locked });
    const before = await f.snapshot();
    const result = await f.run();
    assert.notEqual(result.status, 0, 'must reject the earlier owner checksum even when the last owner matches');
    assert.match(result.stderr, /Checksum mismatch: https:\/\/assets\.invalid\/shared\.nii\.gz/);
    assert.deepEqual(await f.snapshot(), before, 'failed validation must leave manifests and registries byte-identical');
    assert.deepEqual(await f.requests(), locked ? [] : [url]);
  });
}
