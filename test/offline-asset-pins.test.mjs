import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';
import { modelManifestAssets } from '../scripts/lib/model-assets.mjs';

// The standalone build checks every offline asset against a sha256 in
// registry/offline-assets.lock.json, so a URL whose bytes can change breaks the
// nightly build the day its host redeploys. Each pattern names an address that
// cannot serve different bytes later.
const IMMUTABLE = [
  // Hugging Face file at a commit.
  /^https:\/\/huggingface\.co\/(?:datasets\/)?[^/]+\/[^/]+\/resolve\/[0-9a-f]{40}\//,
  // npm CDNs at an exact version.
  /^https:\/\/(?:cdn\.jsdelivr\.net\/npm|unpkg\.com|esm\.sh)\/(?:@[^/@]+\/)?[^/@]+@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\/|$)/,
  // Pyodide release.
  /^https:\/\/cdn\.jsdelivr\.net\/pyodide\/v\d+\.\d+\.\d+\//,
  // PyPI file storage is content-addressed.
  /^https:\/\/files\.pythonhosted\.org\/packages\//,
  // GitHub release asset.
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/download\/[^/]+\/[^/]+$/,
  // GitHub content at a full commit. Only hosts where that segment addresses a commit.
  /^https:\/\/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[0-9a-f]{40}\//,
  /^https:\/\/github\.com\/[^/]+\/[^/]+\/raw\/[0-9a-f]{40}\//,
  /^https:\/\/codeload\.github\.com\/[^/]+\/[^/]+\/(?:tar\.gz|zip)\/[0-9a-f]{40}$/,
  /^https:\/\/cdn\.jsdelivr\.net\/gh\/[^/]+\/[^/@]+@[0-9a-f]{40}\//,
  // Google Fonts file at a font version.
  /^https:\/\/fonts\.gstatic\.com\/s\/[^/]+\/v\d+\//,
];

const isPinned = url => IMMUTABLE.some(pattern => pattern.test(url));

const readJson = async path => JSON.parse(await readFile(join(repoRoot, path), 'utf8'));

function unpinned(urls) {
  return [...new Set(urls)].filter(url => !isPinned(url)).sort();
}

test('the pin patterns reject mutable addresses', () => {
  for (const url of [
    'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/main/examples/a.nii.gz',
    'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/v1.0/examples/a.nii.gz',
    'https://cdn.jsdelivr.net/npm/localforage/+esm',
    'https://cdn.jsdelivr.net/npm/localforage@1/+esm',
    'https://unpkg.com/@yaireo/tagify/dist/tagify.css',
    'https://unpkg.com/@niivue/niivue@latest/dist/niivue.umd.js',
    'https://raw.githubusercontent.com/niivue/niivue-demo-images/main/mni152.nii.gz',
    'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/v0.14.3/README.md',
    'https://niivue.github.io/niivue-demo-images/mni152.nii.gz',
    'https://files.au-1.osf.io/v1/resources/z79k5/providers/osfstorage/6a0315d5a6ee1f1cc6fdf838',
    'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
    'https://github.com/neurodesk/webapps/releases/latest/download/model.onnx',
    'https://example.org/model.onnx?revision=0123456789abcdef0123456789abcdef01234567',
    'https://example.org/0123456789abcdef0123456789abcdef01234567/model.onnx',
    'https://dicompare.neurodesk.org/assets/0123456789abcdef0123456789abcdef01234567/worker.js',
    'https://raw.githubusercontent.com/owner/repo/main/0123456789abcdef0123456789abcdef01234567/file.nii.gz',
    'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/main/0123456789abcdef0123456789abcdef01234567/a.nii.gz',
  ]) assert.equal(isPinned(url), false, url);
  for (const url of [
    'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/0123456789abcdef0123456789abcdef01234567/examples/a.nii.gz',
    'https://huggingface.co/onnx-community/model/resolve/0123456789abcdef0123456789abcdef01234567/model.onnx',
    'https://cdn.jsdelivr.net/npm/localforage@1.10.0/+esm',
    'https://unpkg.com/@niivue/niivue@1.0.0-rc.14/dist/niivue.umd.js',
    'https://cdn.jsdelivr.net/pyodide/v0.27.0/full/pyodide.js',
    'https://raw.githubusercontent.com/ThomasYeoLab/CBIG/d1454a611f7de10a3b36665e6fbb3fb6c770d140/README.md',
    'https://github.com/niivue/niivue-demo-images/raw/f6f98294c1fa89a3a32e8a44eab92368374150a0/mni152.nii.gz',
    'https://codeload.github.com/niivue/niivue-demo-images/tar.gz/f6f98294c1fa89a3a32e8a44eab92368374150a0',
    'https://cdn.jsdelivr.net/gh/niivue/niivue-demo-images@f6f98294c1fa89a3a32e8a44eab92368374150a0/mni152.nii.gz',
    'https://github.com/neurodesk/webapps/releases/download/musclemap-model-v1.4-fp32/musclemap.onnx',
    'https://fonts.gstatic.com/s/inter/v20/UcC73FwrK3iLTeHuS_nVMrMxCp50SjIa1ZL7W0Q5nw.woff2',
  ]) assert.equal(isPinned(url), true, url);
});

test('offline sources and their locked dependencies come from immutable URLs', async () => {
  const sources = await readJson('registry/offline-assets.sources.json');
  const lock = await readJson('registry/offline-assets.lock.json');
  const remote = Object.values(sources.apps).flat().filter(source => !source.path).map(source => source.url);
  assert.deepEqual(unpinned(remote), [], 'registry/offline-assets.sources.json: pin or mirror these sources');
  // Dependencies discovered inside fetched files (CSS fonts, module imports,
  // connectome shards) are fetched too, so their URLs must be pinned as well.
  assert.deepEqual(unpinned(Object.keys(lock.assets)), [], 'registry/offline-assets.lock.json: pin these assets');
  const python = [sources.python.base, ...sources.python.wheels];
  assert.deepEqual(unpinned(python), [], 'registry/offline-assets.sources.json python: pin these runtimes');
});

// Apps fetch these files at run time and the offline bundle serves them by the
// same URL, so they must be pinned where the app reads them, not only in the lock.
test('model manifests and examples that apps fetch use immutable URLs', async () => {
  const models = (await modelManifestAssets()).map(asset => asset.url);
  assert.deepEqual(unpinned(models), [], 'models/*.manifest.json: pin these asset URLs');
  const examples = [];
  for (const entry of await readdir(join(repoRoot, 'apps'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let list;
    try { list = await readJson(`apps/${entry.name}/examples.json`); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const example of list) for (const file of example.files || []) examples.push(file.url);
  }
  assert.deepEqual(unpinned(examples), [], 'apps/*/examples.json: pin these example URLs');
  const calmar = await readJson('apps/calmar/web/models/manifest.json');
  const calmarUrls = [];
  const collect = value => {
    if (Array.isArray(value)) value.forEach(collect);
    else if (value && typeof value === 'object') {
      for (const key of ['sourceUrl', 'indexSourceUrl']) {
        if (typeof value[key] === 'string' && value[key].startsWith('https://')) calmarUrls.push(value[key]);
      }
      Object.values(value).forEach(collect);
    }
  };
  collect(calmar);
  assert.ok(calmarUrls.length > 0);
  assert.deepEqual(unpinned(calmarUrls), [], 'apps/calmar/web/models/manifest.json: pin these asset URLs');
});
