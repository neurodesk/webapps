import assert from 'node:assert/strict';
import { access, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { MAX_DESCRIPTION_LENGTH, catalogApps, findCatalog, loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { validateAssetManifest } from '../scripts/lib/scientific-assets.mjs';

test('catalog contains every app workspace without a repeated inventory', async () => {
  const registry = await loadAppsRegistry();
  const workspaceIds = [];
  for (const entry of await readdir(join(repoRoot, 'apps'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      await access(join(repoRoot, 'apps', entry.name, 'package.json'));
      workspaceIds.push(entry.name);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  assert.deepEqual(registry.apps.map(({ id }) => id).sort(), workspaceIds.sort());
});

test('every app has searchable category metadata', async () => {
  const registry = await loadAppsRegistry();
  const categoryIds = new Set(registry.site.categories.map(({ id }) => id));
  assert.equal(categoryIds.size, registry.site.categories.length);
  for (const app of registry.apps) {
    assert.ok(app.categories.every((category) => categoryIds.has(category)), `${app.id} must use declared categories`);
    assert.ok(app.keywords.length >= 3, `${app.id} must provide useful search keywords`);
  }
});

test('BrowserQC scientific assets are pinned to Hugging Face and not embedded', async () => {
  const manifest = JSON.parse(
    await readFile(join(repoRoot, 'models', 'browserqc.manifest.json'), 'utf8'),
  );
  const source = await readFile(join(repoRoot, 'packages', 'browserqc', 'src', 'pipeline.js'), 'utf8');

  assert.match(manifest.revision, /^[0-9a-f]{40}$/);
  assert.ok(manifest.base_url.includes(`/resolve/${manifest.revision}/browserqc/`));
  // The air template is the shared catalogue's avg152 entry, so its asset names its own URL.
  const air = manifest.assets.find(asset => asset.filename === 'avg152T1.nii.gz');
  assert.ok(source.includes(air.url ?? manifest.base_url + air.filename));

  for (const asset of manifest.assets) {
    await assert.rejects(
      access(join(repoRoot, 'apps', 'browserqc', 'public', asset.filename)),
      `${asset.filename} must be fetched from Hugging Face`,
    );
  }
});

test('QSMbly example data stays outside the static release artifact', async () => {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'qsmbly', 'package.json'), 'utf8'),
  );
  assert.ok(!packageJson.neurodeskWebapp.static.include.includes('data'));
});

test('CI app-test matrix covers the complete catalog', async () => {
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  assert.equal(workflow.jobs['app-tests'].needs, 'app-plan');
  assert.match(workflow.jobs['app-tests'].if, /has_apps/);
  assert.match(workflow.jobs['app-tests'].strategy.matrix, /fromJSON\(needs\.app-plan\.outputs\.apps\)/);
});

test('CI browser-e2e matrix covers exactly the apps with runnable browser suites', async () => {
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  assert.equal(workflow.jobs['browser-e2e'].needs, 'app-plan');
  assert.match(workflow.jobs['browser-e2e'].if, /has_browser_apps/);
  assert.match(workflow.jobs['browser-e2e'].strategy.matrix, /fromJSON\(needs\.app-plan\.outputs\.browser_apps\)/);
});

test('every Playwright spec an app ships is run by its browser command', async () => {
  // CI runs `test:e2e` and nothing else: a spec that command does not reach is never executed.
  const registry = await loadAppsRegistry();
  const unreached = [];
  for (const app of registry.apps) {
    const specs = (await readdir(join(repoRoot, 'apps', app.id, 'e2e')).catch(() => []))
      .filter(name => /\.spec\.[cm]?[jt]s$/.test(name));
    if (specs.length === 0) continue;
    const { scripts } = JSON.parse(await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'));
    if (!/\bplaywright test\b/.test(scripts['test:e2e'] ?? '')) unreached.push(`${app.id}: ${specs.join(', ')}`);
  }
  assert.deepEqual(unreached, []);
});

test('hardware-GPU apps run their browser suite on a macOS runner with Metal', async () => {
  const registry = await loadAppsRegistry();
  assert.ok(registry.apps.some((app) => app.ci.hardware_gpu), 'at least one app needs hardware GPU coverage');
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  const job = workflow.jobs['browser-e2e-gpu'];
  assert.equal(job.needs, 'app-plan');
  assert.match(job.if, /has_gpu_apps/);
  assert.match(job['runs-on'], /^macos-/);
  assert.match(job.strategy.matrix, /fromJSON\(needs\.app-plan\.outputs\.gpu_apps\)/);
  assert.equal(job.env.NEURODESK_HARDWARE_GPU, '1');
  assert.ok(job.steps.some((step) => step.run?.includes('scripts/e2e-test-data.mjs')), 'the job downloads test data');
});

test('the SynthSeg registry manifest stays identical to the package copy', async () => {
  // exes/synthseg/scripts/repoint_model_manifest.sh pins both; the registry reads models/.
  const registryCopy = await readFile(join(repoRoot, 'models/synthseg.manifest.json'), 'utf8');
  const packageCopy = await readFile(join(repoRoot, 'packages/synthseg/model.manifest.json'), 'utf8');
  assert.equal(registryCopy, packageCopy);
});

test('registry validation rejects ci.hardware_gpu without a browser suite', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  raw.apps[0].ci.browser_test = false;
  raw.apps[0].ci.hardware_gpu = true;
  const path = join(await mkdtemp(join(tmpdir(), 'apps-registry-')), 'apps.yml');
  await writeFile(path, stringify(raw));
  await assert.rejects(loadAppsRegistry(path), /ci\.hardware_gpu needs ci\.browser_test/);
});

test('registry validation rejects a description too long for the app bar', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  raw.apps[0].description = 'x'.repeat(MAX_DESCRIPTION_LENGTH);
  const fits = join(await mkdtemp(join(tmpdir(), 'apps-registry-')), 'apps.yml');
  await writeFile(fits, stringify(raw));
  await loadAppsRegistry(fits);
  raw.apps[0].description = 'x'.repeat(MAX_DESCRIPTION_LENGTH + 1);
  const path = join(await mkdtemp(join(tmpdir(), 'apps-registry-')), 'apps.yml');
  await writeFile(path, stringify(raw));
  await assert.rejects(loadAppsRegistry(path), /description must be at most 60 characters/);
});

test('registry validation rejects a non-boolean ci.browser_test', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  raw.apps[0].ci.browser_test = 'sometimes';
  const path = join(await mkdtemp(join(tmpdir(), 'apps-registry-')), 'apps.yml');
  await writeFile(path, stringify(raw));
  await assert.rejects(loadAppsRegistry(path), /ci\.browser_test must be a boolean/);
});

test('release workflow runs each app\'s declared release test script', async () => {
  const registry = await loadAppsRegistry();
  for (const app of registry.apps) {
    const packageJson = JSON.parse(
      await readFile(join(repoRoot, 'apps', app.id, 'package.json'), 'utf8'),
    );
    const releaseTest = app.ci.release_test ?? 'test';
    assert.ok(packageJson.scripts?.[releaseTest], `${app.id} must define ${releaseTest}`);
  }

  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/release.yml'), 'utf8'));
  const step = workflow.jobs.verify.steps.find(({ name }) => name === 'Test app');
  assert.equal(step.env.RELEASE_TEST, '${{ matrix.release_test }}');
  assert.match(step.run, /run "\$RELEASE_TEST"/);
});

test('SpinalCordToolbox routine releases exclude generated batch parity and worker inference', async () => {
  const packageJson = JSON.parse(
    await readFile(join(repoRoot, 'apps', 'spinalcordtoolbox', 'package.json'), 'utf8'),
  );
  const releaseTest = packageJson.scripts['test:release'];
  assert.match(releaseTest, /test:totalspineseg/);
  assert.match(releaseTest, /test:batch:webapp/);
  assert.doesNotMatch(releaseTest, /test:fixtures(?:\s|$)/);
  assert.doesNotMatch(releaseTest, /test:inference:e2e/);
  assert.doesNotMatch(releaseTest, /test:worker:protocol/);
});

test('every declared scientific asset manifest satisfies its selected schema', async () => {
  const registry = await loadAppsRegistry();
  const errors = [];
  for (const app of registry.apps) {
    for (const error of await validateAssetManifest(repoRoot, app)) errors.push(`${app.id}: ${error}`);
  }
  assert.deepEqual(errors, []);
});

test('pnpm is the only workspace lockfile authority', async () => {
  const found = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === 'dist-sites') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.name === 'package-lock.json') found.push(path.slice(repoRoot.length + 1));
    }
  }
  await visit(repoRoot);
  assert.deepEqual(found, []);
});


test('catalog assigns task categories and shares apps across related categories', async () => {
  const registry = await loadAppsRegistry();
  const expected = {
    dwi2trx: ['diffusion-imaging'],
    niimath: ['preprocessing'],
    syncro: ['registration', 'lesion-mapping'],
    disconnectome: ['lesion-mapping', 'diffusion-imaging'],
    mri2vid: ['visualization'],
    surfannotate: ['surfaces', 'visualization'],
    topofit: ['surfaces'],
    samsrf: ['functional-imaging'],
    lcmodel: ['spectroscopy'],
    n4: ['preprocessing'],
    nesvor: ['reconstruction', 'fetal-imaging'],
    deface: ['privacy'],
    brainchop: ['segmentation'],
    dcm2niix: ['conversion'],
    reproin: ['conversion'],
    'calcium-imaging': ['calcium-imaging'],
    stardist: ['segmentation'],
    microsam: ['segmentation'],
    neuromorph: ['morphometry'],
    'structure-tensor': ['fibre-orientation'],
    'lightsheet-atlas': ['registration'],
    'spot-detection': ['spot-detection'],
    'microscope-qc': ['quality-control'],
    zarro: ['visualization'],
    fastprep: ['preprocessing', 'functional-imaging', 'pipelines'],
    'me-ica': ['preprocessing', 'functional-imaging'],
    hmc: ['preprocessing', 'diffusion-imaging'],
    sdc: ['diffusion-imaging', 'preprocessing'],
    dwicorrect: ['diffusion-imaging', 'preprocessing'],
    bison: ['segmentation'],
    'white-matter-lesions': ['segmentation'],
    degibbs: ['preprocessing', 'diffusion-imaging'],
  };
  for (const [id, categories] of Object.entries(expected)) {
    assert.deepEqual(registry.apps.find((app) => app.id === id).categories, categories);
  }
  for (const category of registry.site.categories) {
    const count = registry.apps.filter((app) => app.categories.includes(category.id)).length;
    assert.ok(count >= 1, `${category.id} must hold at least one app`);
  }
});

test('catalog descriptions do not repeat where apps run', async () => {
  const registry = await loadAppsRegistry();
  for (const app of registry.apps) {
    assert.doesNotMatch(app.description, /browser|locally/i, `${app.id}: the site already says every app runs locally`);
  }
});

test('registry rejects unknown or missing facets', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  const path = join(await mkdtemp(join(tmpdir(), 'apps-facets-')), 'apps.yml');
  for (const [field, value, message] of [
    ['inputs', ['png'], /inputs for musclemap must be a non-empty array of unique values/],
    ['anatomy', [], /anatomy for musclemap must be a non-empty array/],
    ['modalities', ['mri', 'mri'], /modalities for musclemap must be a non-empty array of unique values/],
    ['hardware', 'gpu', /hardware for musclemap must be one of/],
    ['remote_compute', 'yes', /remote_compute for musclemap must be true or absent/],
  ]) {
    const copy = structuredClone(raw);
    copy.apps[0][field] = value;
    await writeFile(path, stringify(copy));
    await assert.rejects(loadAppsRegistry(path), message);
  }
});

test('registry rejects missing, unknown, repeated, and legacy categories', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  const path = join(await mkdtemp(join(tmpdir(), 'apps-categories-')), 'apps.yml');
  for (const categories of [undefined, [], ['unknown'], ['visualization', 'visualization']]) {
    raw.apps[0].categories = categories;
    await writeFile(path, stringify(raw));
    await assert.rejects(loadAppsRegistry(path), /categories must be a non-empty array of unique declared category ids/);
  }
  raw.apps[0].categories = ['visualization'];
  raw.apps[0].category = 'visualization';
  await writeFile(path, stringify(raw));
  await assert.rejects(loadAppsRegistry(path), /use categories instead of category/);
});

test('registry validation rejects a handoff form apps cannot receive', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  raw.apps[0].handoff = 'mgz';
  const path = join(await mkdtemp(join(tmpdir(), 'apps-registry-')), 'apps.yml');
  await writeFile(path, stringify(raw));
  await assert.rejects(loadAppsRegistry(path), /handoff for .* must be one of nifti, dicom, none/);
});

test('every app belongs to exactly one declared catalogue', async () => {
  const registry = await loadAppsRegistry();
  const ids = new Set(registry.site.catalogs.map(({ id }) => id));
  for (const app of registry.apps) assert.ok(ids.has(app.catalog), `${app.id} must name a declared catalogue`);
  assert.deepEqual(
    registry.apps.filter(({ catalog }) => catalog === 'msk').map(({ id }) => id).sort(),
    ['carotid-flow', 'musclemap', 'seedseg'],
  );
});

test('every catalogue and the hub name a logo the site ships', async () => {
  const registry = await loadAppsRegistry();
  for (const entry of [registry.site.hub, ...registry.site.catalogs]) {
    await access(join(repoRoot, 'site', entry.brand.logo));
  }
});

test('registry rejects unknown, missing and repeated catalogue membership', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  const path = join(await mkdtemp(join(tmpdir(), 'apps-catalogs-')), 'apps.yml');
  const original = raw.apps[0].catalog;
  for (const catalog of [undefined, 'unknown', ['neuro', 'msk']]) {
    raw.apps[0].catalog = catalog;
    await writeFile(path, stringify(raw));
    await assert.rejects(loadAppsRegistry(path), /catalog for musclemap must be exactly one declared catalog id/);
  }
  raw.apps[0].catalog = original;
  await writeFile(path, stringify(raw));
  await loadAppsRegistry(path);
});

test('also_in lists other declared catalogues, each once', async () => {
  const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
  const path = join(await mkdtemp(join(tmpdir(), 'apps-also-in-')), 'apps.yml');
  for (const alsoIn of [[], 'neuro', ['unknown'], [raw.apps[0].catalog], ['neuro', 'neuro']]) {
    raw.apps[0].also_in = alsoIn;
    await writeFile(path, stringify(raw));
    await assert.rejects(loadAppsRegistry(path), /also_in for musclemap must list other declared catalog ids, each once/);
  }
  raw.apps[0].also_in = ['neuro'];
  await writeFile(path, stringify(raw));
  const registry = await loadAppsRegistry(path);
  assert.ok(catalogApps(registry, findCatalog(registry, 'neuro')).some(({ id }) => id === 'musclemap'));
});

test('registry rejects duplicate catalogue hosts and ids, and catalogues without apps', async () => {
  const cases = [
    [raw => { raw.site.catalogs[1].host = raw.site.catalogs[0].host; }, /duplicate catalog host: webapps\.neurodesk\.org/],
    [raw => { raw.site.catalogs[1].host = raw.site.hub.host; }, /duplicate catalog host: webapps\.sciget\.org/],
    [raw => { raw.site.catalogs[1].id = 'neuro'; }, /duplicate catalog id: neuro/],
    [raw => { raw.site.catalogs[1].id = 'hub'; }, /catalog id hub is reserved for the hub page/],
    [raw => { raw.site.catalogs.push({ ...raw.site.catalogs[1], id: 'empty', host: 'empty.sciget.org' }); }, /catalog empty has no apps/],
    [raw => { raw.site.catalogs[1].hosting = 'pages'; }, /exactly one catalog must use pages hosting, on site\.domain/],
    [raw => { raw.site.catalogs[0].hosting = 'worker'; }, /exactly one catalog must use pages hosting, on site\.domain/],
    [raw => { raw.site.catalogs[1].hosting = 'netlify'; }, /hosting for catalog msk must be one of: pages, worker/],
    [raw => { delete raw.site.hub; }, /site\.hub\.host must be a host name/],
    [raw => { raw.site.catalogs[1].brand.logo = '../secret.svg'; }, /catalog msk\.brand\.logo must name an SVG file/],
    [raw => { raw.site.catalogs = []; }, /site\.catalogs must be a non-empty array/],
  ];
  for (const [mutate, message] of cases) {
    const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
    mutate(raw);
    const path = join(await mkdtemp(join(tmpdir(), 'apps-catalogs-')), 'apps.yml');
    await writeFile(path, stringify(raw));
    await assert.rejects(loadAppsRegistry(path), message);
  }
});

test('registry rejects a former path that is repeated or still in use', async () => {
  for (const [paths, message] of [
    [['dicom2vid'], /former_paths for .* must be unique app paths/],
    [['dicomview'], /former path dicomview is a current app path/],
  ]) {
    const raw = parse(await readFile(join(repoRoot, 'registry', 'apps.yml'), 'utf8'));
    raw.apps[0].former_paths = paths;
    const path = join(await mkdtemp(join(tmpdir(), 'apps-catalogs-')), 'apps.yml');
    await writeFile(path, stringify(raw));
    await assert.rejects(loadAppsRegistry(path), message);
  }
});
