import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { testedBase } from '../scripts/lib/tested-base.mjs';
import { lockfileImpact } from '../scripts/lib/lockfile-impact.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { CATALOG_JOBS, loadConservativeWorkspaceGraph, WorkspaceGraphConfigurationError } from '../scripts/lib/workspace-graph.mjs';

const graph = loadConservativeWorkspaceGraph(repoRoot);

test('app-local changes select only that webapp', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/niimath/main.js']);
  assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']);
  assert.deepEqual(plan.browserApps.include.map(({ app }) => app), ['niimath']);
});

test('QSMbly runtime changes also select Brain extraction for browser tests and release', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/qsmbly/rust-wasm/src/lib.rs']);
  assert.deepEqual(plan.selected.map(app => app.id), ['qsmbly', 'brain-extraction']);
  assert.ok(plan.browserApps.include.some(({ app }) => app === 'brain-extraction'));
  assert.ok(plan.releaseApps.include.some(({ app }) => app === 'brain-extraction'));
});

test('homepage easter-egg changes select no catalog apps', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, [
    'site/easter-eggs/vessel-surfer/src/main.js',
    'site/easter-eggs/vessel-surfer-leaderboard/src/worker.js',
    'site/easter-eggs/vessel-surfer/package.json',
    '.changeset/vessel-surfer-tracks.md',
  ]);
  assert.deepEqual(plan.selected, []);
  assert.deepEqual(plan.browserApps.include, []);
  assert.equal(plan.allApps, false);
});

test('shared homepage files still select the complete app catalog', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['site/landing.js', 'site/app-theme.css', 'scripts/lib/landing-page.mjs']) {
    const plan = createAppPlan(registry, [path]);
    assert.equal(plan.selected.length, registry.apps.length, path);
  }
});

test('shared module changes select the complete app catalog', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/components/src/ui/ProgressManager.js']);
  assert.equal(plan.selected.length, registry.apps.length);
  assert.deepEqual(
    [...new Set(plan.browserApps.include.map(({ app }) => app))],
    registry.apps.filter((app) => app.ci.browser_test).map((app) => app.id),
  );
  assert.deepEqual(
    plan.gpuApps.include.map(({ app }) => app),
    registry.apps.filter((app) => app.ci.hardware_gpu).map((app) => app.id),
  );
});

test('an app change selects the macOS GPU job only for hardware-GPU apps', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['apps/brain2print/src/main.js']).gpuApps.include.map(({ app }) => app), ['brain2print']);
  assert.deepEqual(createAppPlan(registry, ['apps/niimath/index.html']).gpuApps.include, []);
});

test('toolchain facts are carried into generated matrices', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/easy-mp2rage/web/index.html']);
  assert.deepEqual(plan.apps.include, [{
    app: 'easy-mp2rage',
    path: 'easy-mp2rage',
    runtime: 'rust-wasm',
    rust_wasm: true,
    python_reference: false,
    shared_runtime: false,
    browser_test: true,
    hardware_gpu: false,
    app_scoped_runtime: true,
    release_test: 'test',
  }]);
});

test('release matrix carries an app-specific release test script', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/spinalcordtoolbox/package.json']);
  assert.equal(plan.releaseApps.include[0].app, 'spinalcordtoolbox');
  assert.equal(plan.releaseApps.include[0].release_test, 'test:release');
});

test('documentation-only changes do not spend an app-test matrix', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['docs/adr/0002-hosting-capacity-and-runtime-store.md']);
  assert.deepEqual(plan.apps.include, []);
  assert.equal(plan.allApps, false);
});

test('an app package selects only the apps that use it', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/lcmodel/src/lcmodel-io.js', 'exes/lcmodel/src/state.rs'], await graph);
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(plan.allApps, false);
});

test('packages reached through relative paths still select their apps', async () => {
  const registry = await loadAppsRegistry();
  const selected = createAppPlan(registry, ['exes/greedy/src/lib.rs'], await graph).selected.map((app) => app.id);
  assert.ok(selected.includes('greedy'), 'apps/greedy builds exes/greedy through ../../exes');
  assert.ok(!selected.includes('lcmodel'));
});

test('the shared component package selects every app', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/components/src/ui/ProgressManager.js'], await graph);
  assert.equal(plan.allApps, true);
});

test('an app model manifest selects only that app', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['models/vesselboost.manifest.json']).selected.map((app) => app.id), ['vesselboost']);
});

test('contract tests, tooling, docs and other workflows select no apps and no site build', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, [
    'AGENTS.md',
    'packages/components/CHANGELOG.md',
    'test/app-plan.test.mjs',
    'test/standalone-links.test.mjs',
    // The mutation-testing config names these; composite-site never reads it.
    'test/lockfile-impact.test.mjs',
    'test/date-versions.test.mjs',
    'scripts/lib/mutation-modules.mjs',
    'scripts/check-standalone-links.mjs',
    '.github/workflows/lcmodel-native.yml',
    '.github/workflows/standalone-links.yml',
    'scripts/quality/package.json',
    'eslint.config.js',
    'config/dependency-baseline.json',
    'templates/app-template/index.html',
  ], await graph);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
});

test('root files the per-app CI jobs run select the complete catalog', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['.github/workflows/ci.yml', 'scripts/lib/e2e-test-data.mjs', 'test-utils/hardware-gpu.mjs']) {
    assert.equal(createAppPlan(registry, [path], await graph).allApps, true, path);
  }
});

test('root files only the composite-site job runs select the site build and no app', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['test/mobile-layout.smoke.mjs', 'test/runtime-assets.test.mjs']) {
    const plan = createAppPlan(registry, [path], await graph);
    assert.deepEqual(plan.selected, [], path);
    assert.equal(plan.site, true, path);
  }
});

test('a root helper selects the apps that import it', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['scripts/lib/dice.mjs'], await graph);
  assert.deepEqual(plan.selected.map((app) => app.id), ['spinalcordtoolbox']);
});

test("a package's tests select only the apps that read them", async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['packages/brain-extraction/test/head-reference.mjs'], await graph).selected.map((app) => app.id), ['brain-extraction']);
  assert.deepEqual(createAppPlan(registry, ['packages/lcmodel/test/lcmodel-io.test.js'], await graph).selected, []);
});

test('a root script that names one package file reaches that file, not the whole package', async () => {
  const registry = await loadAppsRegistry();
  const contracts = createAppPlan(registry, ['packages/desktop/src/contracts.js'], await graph);
  const other = createAppPlan(registry, ['packages/desktop/src/jobs.js'], await graph);
  assert.equal(contracts.allApps, true, 'vite-app-config.mjs reaches contracts.js through app-automation.mjs');
  assert.deepEqual(other.selected.map((app) => app.id), ['dicompare'], 'only dicompare depends on the desktop package');
});

function manifest(before, after) {
  return { before: JSON.stringify(before), after: JSON.stringify(after) };
}

test('a package version bump selects the apps that use the package, since builds embed versions', async () => {
  const registry = await loadAppsRegistry();
  const manifests = new Map([['packages/synthsr/package.json', manifest({ name: 'x', version: '1.0.0' }, { name: 'x', version: '1.1.0' })]]);
  assert.ok(createAppPlan(registry, ['packages/synthsr/package.json'], await graph, manifests).selected.some((app) => app.id === 'synthsr'));
});

test('root test files app e2e scripts run select those apps', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['test/easy-mp2rage-workspace.smoke.mjs'], await graph).selected.map((app) => app.id), ['easy-mp2rage']);
  assert.ok(createAppPlan(registry, ['test/musclemap-full-pipeline-smoke.mjs'], await graph).selected.some((app) => app.id === 'musclemap'));
});

test('files the catalog e2e config reads run the site build', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['test/agentic/catalog.e2e.ts', 'test-utils/agentic-browser.ts', 'scripts/serve-agentic-site.mjs']) {
    assert.equal(createAppPlan(registry, [path], await graph).site, true, path);
  }
});

test('documentation in a package or exes/ directory selects the apps that read it', async () => {
  const registry = await loadAppsRegistry();
  assert.deepEqual(createAppPlan(registry, ['exes/compute-server/README.md'], await graph).selected.map((app) => app.id), ['spinalcordtoolbox']);
});

test('root package.json script edits count only where ci.yml runs them', async () => {
  const registry = await loadAppsRegistry();
  const scripts = { build: 'a', 'new-app': 'b', 'test:mobile': 'c' };
  const resolved = await graph;
  const plan = (after) => createAppPlan(registry, ['package.json'], resolved, new Map([['package.json', manifest({ scripts }, after)]]));
  assert.deepEqual(plan({ scripts: { ...scripts, 'new-app': 'B' } }).selected, []);
  assert.equal(plan({ scripts: { ...scripts, 'new-app': 'B' } }).site, false);
  const site = plan({ scripts: { ...scripts, 'test:mobile': 'C' } });
  assert.deepEqual(site.selected, []);
  assert.equal(site.site, true);
  assert.equal(plan({ scripts, devDependencies: { a: '1' } }).allApps, true);
});

// Lockfile and registry changes are compared before and after: the apps whose
// resolved dependencies or registry entries changed are selected, and anything
// that cannot be analysed selects the whole catalog with a reason.
const dep = (version) => ({ specifier: version, version });
const link = (target) => ({ specifier: 'workspace:*', version: `link:${target}` });
function lockfile({ importers, snapshots }) {
  const packages = Object.fromEntries(Object.keys(snapshots).map((key) => [key, { resolution: { integrity: `sha512-${key}` } }]));
  return { lockfileVersion: '9.0', settings: { autoInstallPeers: true }, importers, packages, snapshots };
}
const baseLock = lockfile({
  importers: {
    '.': { devDependencies: { eslint: dep('9.0.0'), '@neurodesk/code-quality': link('scripts/quality') } },
    'apps/niimath': { dependencies: { '@niivue/niivue': dep('1.0.0'), '@neurodesk/webapp-components': link('../../packages/components') } },
    'apps/lcmodel': { dependencies: { '@neurodesk/lcmodel': link('../../packages/lcmodel') } },
    'packages/components': {},
    'packages/lcmodel': { dependencies: { fflate: dep('0.8.0') } },
    'scripts/quality': { devDependencies: { knip: dep('5.0.0') } },
    'site/easter-eggs/vessel-surfer': { dependencies: { three: dep('0.1.0') } },
  },
  snapshots: {
    '@niivue/niivue@1.0.0': { dependencies: { pako: '2.1.0' } },
    'pako@2.1.0': {},
    'eslint@9.0.0': {},
    'fflate@0.8.0': {},
    'knip@5.0.0': {},
    'three@0.1.0': {},
  },
});
function changeLock(edit) {
  const after = structuredClone(baseLock);
  edit(after);
  return after;
}
// Adds a resolved package to a lockfile.
function resolve(lock, key) {
  lock.snapshots[key] = {};
  lock.packages[key] = { resolution: { integrity: `sha512-${key}` } };
}
async function lockPlan(after) {
  const registry = await loadAppsRegistry();
  return createAppPlan(registry, ['pnpm-lock.yaml'], await graph, new Map([['pnpm-lock.yaml', manifest(baseLock, after)]]));
}

test('a lockfile-only runtime upgrade selects the apps that resolve it', async () => {
  const plan = await lockPlan(changeLock((lock) => {
    lock.snapshots['@niivue/niivue@1.0.0'].dependencies.pako = '2.1.1';
    delete lock.snapshots['pako@2.1.0'];
    delete lock.packages['pako@2.1.0'];
    resolve(lock, 'pako@2.1.1');
  }));
  assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']);
  assert.equal(plan.reasons.fallback, null);
  assert.deepEqual(plan.reasons.apps.niimath, ['pnpm-lock.yaml: importer apps/niimath resolves changed packages @niivue/niivue@1.0.0, pako@2.1.0, pako@2.1.1']);
});

test('an integrity-only lockfile change selects the apps that resolve the package', async () => {
  const plan = await lockPlan(changeLock((lock) => {
    lock.packages['@niivue/niivue@1.0.0'].resolution.integrity = 'sha512-republished';
  }));
  assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']);
});

test("a shared package's lockfile change selects the apps that use the package", async () => {
  const plan = await lockPlan(changeLock((lock) => {
    lock.importers['packages/lcmodel'].dependencies.fflate = dep('0.8.2');
    resolve(lock, 'fflate@0.8.2');
  }));
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.ok(plan.reasons.apps.lcmodel.includes('pnpm-lock.yaml: importer packages/lcmodel changed its dependency entries'));
  const components = await lockPlan(changeLock((lock) => {
    lock.importers['packages/components'] = { dependencies: { pako: dep('2.1.0') } };
  }));
  assert.equal(components.allApps, true, 'every app uses the shared component package');
  assert.equal(components.reasons.fallback, null);
});

test('a removed transitive dependency selects the apps that resolved it before', async () => {
  const plan = await lockPlan(changeLock((lock) => {
    lock.snapshots['@niivue/niivue@1.0.0'] = {};
    delete lock.snapshots['pako@2.1.0'];
    delete lock.packages['pako@2.1.0'];
  }));
  assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']);
  assert.match(plan.reasons.apps.niimath[0], /pako@2\.1\.0/);
});

test('an easter-egg lockfile change selects no app and no site build', async () => {
  const plan = await lockPlan(changeLock((lock) => {
    lock.importers['site/easter-eggs/vessel-surfer'].dependencies.three = dep('0.2.0');
    resolve(lock, 'three@0.2.0');
  }));
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
});

test('a quality-tool lockfile change selects what editing that tool selects, not the runtime consumers', async () => {
  const plan = await lockPlan(changeLock((lock) => {
    lock.importers['scripts/quality'].devDependencies.knip = dep('5.1.0');
    resolve(lock, 'knip@5.1.0');
  }));
  const registry = await loadAppsRegistry();
  const resolved = await graph;
  const edited = createAppPlan(registry, ['scripts/quality/lint-inventory.mjs', 'scripts/quality/lint-baseline.json'], resolved);
  assert.deepEqual(plan.selected.map((app) => app.id), edited.selected.map((app) => app.id));
  assert.equal(plan.reasons.fallback, null);
  assert.ok(!plan.selected.some((app) => app.id === 'niimath'), 'niimath does not reach the lint tooling');
});

test('lockfile changes the planner cannot scope select the whole catalog with a reason', async () => {
  const cases = {
    'root importer': [(lock) => {
      lock.importers['.'].devDependencies.eslint = dep('9.1.0');
      resolve(lock, 'eslint@9.1.0');
    }, /root's dependencies resolve for every workspace member/],
    overrides: [(lock) => {
      lock.overrides = { pako: '2.1.1' };
    }, /changed its overrides section/],
    'unresolvable dependency': [(lock) => {
      lock.importers['apps/niimath'].dependencies.missing = dep('1.0.0');
    }, /resolves missing for apps\/niimath to 1\.0\.0, which has no snapshot/],
    'unknown format': [(lock) => {
      lock.lockfileVersion = '10.0';
    }, /lockfileVersion 10\.0/],
  };
  for (const [name, [edit, reason]] of Object.entries(cases)) {
    const plan = await lockPlan(changeLock(edit));
    assert.equal(plan.allApps, true, name);
    assert.match(plan.reasons.fallback, reason, name);
  }
  const registry = await loadAppsRegistry();
  const missingBase = createAppPlan(registry, ['pnpm-lock.yaml'], await graph);
  assert.equal(missingBase.allApps, true, 'without the base lockfile');
  assert.equal(missingBase.reasons.fallback, 'pnpm-lock.yaml: the base or head lockfile is unavailable');
  const unparsable = createAppPlan(registry, ['pnpm-lock.yaml'], await graph, new Map([['pnpm-lock.yaml', { before: 'importers: [', after: JSON.stringify(baseLock) }]]));
  assert.equal(unparsable.allApps, true);
  assert.match(unparsable.reasons.fallback, /the base pnpm-lock\.yaml does not parse/);
});

test('without a workspace graph a lockfile change to a package selects the whole catalog', async () => {
  const registry = await loadAppsRegistry();
  const after = changeLock((lock) => {
    lock.importers['packages/lcmodel'].dependencies.fflate = dep('0.8.2');
    resolve(lock, 'fflate@0.8.2');
  });
  const plan = createAppPlan(registry, ['pnpm-lock.yaml'], null, new Map([['pnpm-lock.yaml', manifest(baseLock, after)]]));
  assert.equal(plan.allApps, true);
  assert.match(plan.reasons.fallback, /no workspace graph/);
});

test("the repository's own lockfile resolves every importer's dependencies", async () => {
  const text = await readFile(join(repoRoot, 'pnpm-lock.yaml'), 'utf8');
  assert.equal(lockfileImpact({ before: text, after: text }).size, 0);
});

async function registryPlan(edit, paths = ['registry/apps.yml']) {
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const after = parse(text);
  edit(after);
  return createAppPlan(await loadAppsRegistry(), paths, await graph, new Map([['registry/apps.yml', { before: text, after: stringify(after) }]]));
}
const entry = (registry, id) => registry.apps.find((app) => app.id === id);

test('a registry entry change selects that app and the site build', async () => {
  const plan = await registryPlan((registry) => {
    entry(registry, 'niimath').description = 'Changed.';
  });
  assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']);
  assert.deepEqual(plan.reasons.apps.niimath, ['registry/apps.yml: the niimath entry changed']);
  assert.equal(plan.site, true);
  const qsmbly = await registryPlan((registry) => {
    entry(registry, 'qsmbly').keywords.push('changed');
  });
  assert.deepEqual(qsmbly.selected.map((app) => app.id), ['qsmbly', 'brain-extraction']);
});

test('app registration with its lockfile importer stays scoped to that webapp', async () => {
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const without = parse(text);
  without.apps = without.apps.filter((app) => app.id !== 'surfannotate');
  const plan = createAppPlan(await loadAppsRegistry(), ['LICENSES.md', 'apps/surfannotate/package.json', 'pnpm-lock.yaml', 'registry/apps.yml'], await graph, new Map([
    ['registry/apps.yml', { before: stringify(without), after: text }],
    ['pnpm-lock.yaml', manifest(baseLock, changeLock((lock) => {
      lock.importers['apps/surfannotate'] = { dependencies: { '@niivue/niivue': dep('1.0.0') } };
    }))],
  ]));
  assert.deepEqual(plan.selected.map((app) => app.id), ['surfannotate']);
  assert.deepEqual(plan.browserApps.include.map(({ app }) => app), ['surfannotate']);
  assert.equal(plan.allApps, false);
});

test('removing or reordering registry entries selects no app but the site build', async () => {
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const retired = parse(text);
  retired.apps.push({ ...entry(retired, 'niimath'), id: 'retired', path: 'retired' });
  const removed = createAppPlan(await loadAppsRegistry(), ['registry/apps.yml'], await graph, new Map([['registry/apps.yml', { before: stringify(retired), after: text }]]));
  const reordered = await registryPlan((after) => {
    after.apps.reverse();
  });
  for (const plan of [removed, reordered]) {
    assert.deepEqual(plan.selected, []);
    assert.equal(plan.site, true);
    assert.equal(plan.reasons.fallback, null);
  }
});

test('registry changes outside the app entries select the whole catalog with a reason', async () => {
  const plan = await registryPlan((registry) => {
    registry.site.analytics.measurement_id = 'G-CHANGED';
  });
  assert.equal(plan.allApps, true);
  assert.equal(plan.reasons.fallback, 'registry/apps.yml: its site section changed, and every app build reads it');
  const duplicate = await registryPlan((registry) => {
    registry.apps.push(entry(registry, 'niimath'));
  });
  assert.match(duplicate.reasons.fallback, /missing or duplicate ids/);
  const missingBase = createAppPlan(await loadAppsRegistry(), ['registry/apps.yml'], await graph);
  assert.equal(missingBase.reasons.fallback, 'registry/apps.yml: the base or head registry is unavailable');
});

test('an offline asset lock change selects the apps whose assets changed', async () => {
  const registry = await loadAppsRegistry();
  const before = { schemaVersion: 1, assets: { u1: { sha256: 'a' }, u2: { sha256: 'b' } }, apps: { lcmodel: ['u1'], zarro: ['u2'] } };
  const after = { ...before, assets: { ...before.assets, u1: { sha256: 'c' } } };
  const plan = createAppPlan(registry, ['registry/offline-assets.lock.json'], await graph, new Map([['registry/offline-assets.lock.json', manifest(before, after)]]));
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(plan.site, true);
});

test('a root-relative path joined onto a computed repository root selects its app', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['exes/compute-server/src/tools/sct.rs'], await graph);
  assert.ok(plan.selected.some((app) => app.id === 'spinalcordtoolbox'), 'SCT test:release reads the pinned image from sct.rs');
});

test('ci.yml runs the composite site build on pull requests that need it', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs['composite-site'].if, "github.event_name != 'pull_request' || needs.app-plan.outputs.has_site == 'true'");
  assert.equal(ci.jobs['app-plan'].outputs.has_site, '${{ steps.plan.outputs.has_site }}');
});

test('an app with ci.e2e_shards gets one browser-e2e entry per shard', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['apps/browserqc/src/main.js'], await graph);
  assert.deepEqual(plan.browserApps.include.map(({ app, shard }) => `${app} ${shard}`), ['browserqc 1/2', 'browserqc 2/2']);
  assert.equal(plan.apps.include.length, 1, 'unit tests and builds still run once');
  assert.deepEqual(createAppPlan(registry, ['apps/niimath/main.js'], await graph).browserApps.include.map(({ shard }) => shard), ['']);
});

test('the app-plan CLI selects explicit apps without a base revision', () => {
  const output = execFileSync(process.execPath, ['scripts/app-plan.mjs', '--only', 'lcmodel,calmar'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  const plan = JSON.parse(output);
  assert.deepEqual(JSON.parse(plan.selected_ids).sort(), ['calmar', 'lcmodel']);
  assert.equal(plan.all_apps, 'false');
  assert.equal(plan.has_site, 'true');
});

test('deleting an imported root helper still selects the app that imports it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-deleted-import-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['apps/lcmodel', 'scripts/lib', '.github/workflows']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  await writeFile(join(root, '.github/workflows/ci.yml'), JSON.stringify({ jobs: {
    'composite-site': { steps: [{ run: 'echo fixture' }] },
    'app-tests': { steps: [{ run: 'echo fixture' }] },
    'browser-e2e': { steps: [{ run: 'echo fixture' }] },
    'browser-e2e-gpu': { steps: [{ run: 'echo fixture' }] },
  } }));
  await writeFile(join(root, 'apps/lcmodel/main.js'), "import '../../scripts/entry.mjs';\n");
  await writeFile(join(root, 'scripts/entry.mjs'), "import './lib/shared.mjs';\n");
  await writeFile(join(root, 'scripts/lib/shared.mjs'), 'export const value = 1;\n');
  const registry = await loadAppsRegistry();
  const selected = async () => createAppPlan(registry, ['scripts/lib/shared.mjs'], await loadConservativeWorkspaceGraph(root));
  assert.deepEqual((await selected()).selected.map((app) => app.id), ['lcmodel']);
  await rm(join(root, 'scripts/lib/shared.mjs'));
  const plan = await selected();
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(plan.site, true);
});

test('a path named in a line comment is not an input, but code, JSDoc types and triple-slash directives are', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-comment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['apps/lcmodel', 'scripts/lib', 'exes/prose', 'exes/code', 'packages/typed', 'packages/directive', '.github/workflows']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  await writeFile(join(root, '.github/workflows/ci.yml'), JSON.stringify({ jobs: Object.fromEntries(['composite-site', ...CATALOG_JOBS].map((name) => [name, { steps: [{ run: 'echo fixture' }] }])) }));
  await writeFile(join(root, 'apps/lcmodel/main.js'), "import '../../scripts/lib/config.mjs';\n");
  await writeFile(join(root, 'scripts/lib/config.mjs'), [
    '// The composite build (scripts/build-site.mjs) mirrors exes/prose/src/lib.rs.',
    "  // registry/standalone.json is described here, not read.",
    "/** @type {import('../../packages/typed/index.js').Value} */",
    '/// <reference path="../../packages/directive/index.d.ts" />',
    "export const fixture = 'exes/code/data.bin'; // trailing comments keep their line",
    '',
  ].join('\n'));
  await writeFile(join(root, 'scripts/build-site.mjs'), 'export {};\n');
  const graph = await loadConservativeWorkspaceGraph(root);
  const registry = await loadAppsRegistry();
  const selects = (path) => createAppPlan(registry, [path], graph).selected.map((app) => app.id);
  assert.deepEqual(selects('exes/prose/src/lib.rs'), []);
  assert.deepEqual(selects('scripts/build-site.mjs'), []);
  assert.deepEqual(selects('exes/code/data.bin'), ['lcmodel']);
  assert.deepEqual(selects('packages/typed/index.js'), ['lcmodel']);
  assert.deepEqual(selects('packages/directive/index.d.ts'), ['lcmodel']);
});

test('removing a root script still selects the CI job that calls it', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-deleted-script-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.github/workflows'), { recursive: true });
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  await writeFile(join(root, '.github/workflows/ci.yml'), JSON.stringify({ jobs: {
    'composite-site': { steps: [{ run: 'pnpm build' }] },
    'app-tests': { steps: [{ run: 'echo fixture' }] },
    'browser-e2e': { steps: [{ run: 'echo fixture' }] },
    'browser-e2e-gpu': { steps: [{ run: 'echo fixture' }] },
  } }));
  const registry = await loadAppsRegistry();
  const manifests = new Map([['package.json', manifest({ scripts: { build: 'node scripts/build.mjs' } }, { scripts: {} })]]);
  const plan = createAppPlan(registry, ['package.json'], await loadConservativeWorkspaceGraph(root), manifests);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, true);
});

async function plannerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ['scripts/lib', 'registry', '.github/workflows']) {
    await mkdir(join(root, path), { recursive: true });
  }
  for (const path of ['scripts/app-plan.mjs', 'scripts/lib/app-plan.mjs', 'scripts/lib/lockfile-impact.mjs', 'scripts/lib/workspace-graph.mjs', 'scripts/lib/apps-registry.mjs', 'scripts/lib/tested-base.mjs', 'registry/apps.yml']) {
    await copyFile(join(repoRoot, path), join(root, path));
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {} }));
  await symlink(join(repoRoot, 'node_modules'), join(root, 'node_modules'), 'junction');
  const ci = { jobs: Object.fromEntries(['composite-site', ...CATALOG_JOBS].map(name => [name, { steps: [{ run: 'echo fixture' }] }])) };
  await writeFile(join(root, '.github/workflows/ci.yml'), stringify(ci));
  const run = (...args) => spawnSync(process.execPath, ['scripts/app-plan.mjs', ...args], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '' },
  });
  return { root, ci, run };
}

test('missing, renamed and reusable CI jobs trigger a visible full-coverage fallback', async (t) => {
  const { root, ci, run } = await plannerFixture(t);
  const registry = await loadAppsRegistry();
  for (const name of ['composite-site', ...CATALOG_JOBS]) {
    for (const variant of ['missing', 'renamed', 'reusable', 'empty', 'non-array']) {
      const altered = structuredClone(ci);
      if (variant === 'renamed') altered.jobs[`${name}-renamed`] = altered.jobs[name];
      if (variant === 'missing' || variant === 'renamed') delete altered.jobs[name];
      if (variant === 'reusable') altered.jobs[name] = { uses: './.github/workflows/reusable.yml' };
      if (variant === 'empty') altered.jobs[name] = { steps: [] };
      if (variant === 'non-array') altered.jobs[name] = { steps: {} };
      await writeFile(join(root, '.github/workflows/ci.yml'), stringify(altered));
      await assert.rejects(loadConservativeWorkspaceGraph(root), error => error instanceof WorkspaceGraphConfigurationError && error.message.includes(name));
      const result = run('--only', 'niimath');
      assert.equal(result.status, 0, `${name} ${variant}: ${result.stderr}`);
      const output = JSON.parse(result.stdout);
      assert.deepEqual(JSON.parse(output.selected_ids), registry.apps.map(app => app.id));
      assert.equal(output.all_apps, 'true');
      assert.equal(output.has_site, 'true');
      assert.match(output.fallback_reason, new RegExp(name));
      assert.match(result.stderr, /selecting the full catalog and site/);
      assert.deepEqual(JSON.parse(output.browser_apps), createAppPlan(registry).browserApps);
      assert.deepEqual(JSON.parse(output.gpu_apps), createAppPlan(registry).gpuApps);
    }
  }
});

test('unrelated workflow parsing errors remain fatal', async (t) => {
  const { root, run } = await plannerFixture(t);
  await writeFile(join(root, '.github/workflows/ci.yml'), 'jobs: [');
  const result = run('--only', 'niimath');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /YAMLParseError/);
  assert.doesNotMatch(result.stderr, /selecting the full catalog and site/);
});

test('workflow outputs include the fallback reason and complete matrices', async (t) => {
  const { root, ci } = await plannerFixture(t);
  delete ci.jobs['app-tests'];
  await writeFile(join(root, '.github/workflows/ci.yml'), stringify(ci));
  const outputFile = join(root, 'github-output');
  const result = spawnSync(process.execPath, ['scripts/app-plan.mjs', '--only', 'niimath'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: outputFile },
  });
  assert.equal(result.status, 0, result.stderr);
  const outputs = Object.fromEntries((await readFile(outputFile, 'utf8')).trim().split('\n').map(line => {
    const equals = line.indexOf('=');
    return [line.slice(0, equals), line.slice(equals + 1)];
  }));
  assert.match(outputs.fallback_reason, /app-tests/);
  assert.match(JSON.parse(outputs.selection_reasons).fallback, /app-tests/);
  assert.equal(outputs.all_apps, 'true');
  assert.equal(outputs.has_site, 'true');
  assert.deepEqual(JSON.parse(outputs.selected_ids), (await loadAppsRegistry()).apps.map(app => app.id));
});

test('the CLI compares the lockfile at the merge base and reports why it selected each app', async (t) => {
  const { root, run } = await plannerFixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await writeFile(join(root, 'pnpm-lock.yaml'), stringify(baseLock));
  git('add', 'pnpm-lock.yaml');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'pnpm-lock.yaml'), stringify(changeLock((lock) => {
    lock.packages['@niivue/niivue@1.0.0'].resolution.integrity = 'sha512-republished';
  })));
  git('commit', '--quiet', '-am', 'head');
  const summaryFile = join(root, 'step-summary');
  const result = spawnSync(process.execPath, ['scripts/app-plan.mjs', '--base', base, '--head', 'HEAD'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: '', GITHUB_STEP_SUMMARY: summaryFile },
  });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.deepEqual(JSON.parse(output.selected_ids), ['niimath']);
  assert.equal(output.fallback_reason, '');
  assert.deepEqual(JSON.parse(output.selection_reasons).apps, {
    niimath: ['pnpm-lock.yaml: importer apps/niimath resolves changed packages @niivue/niivue@1.0.0'],
  });
  assert.match(await readFile(summaryFile, 'utf8'), /Selected 1 of \d+ apps[^]*- niimath: pnpm-lock\.yaml: importer apps\/niimath/);

  const missingBase = run('--base', '0123456789abcdef0123456789abcdef01234567', '--head', 'HEAD');
  assert.equal(missingBase.status, 0, missingBase.stderr);
  const fallback = JSON.parse(missingBase.stdout);
  assert.equal(fallback.all_apps, 'true');
  assert.match(fallback.fallback_reason, /no changed paths/);
  assert.match(missingBase.stderr, /Full catalog and site selected: no changed paths/);
});

test('a push diffs from the nearest green run on the branch, not from a pull request or another branch', () => {
  // main: a - b - c - head; d is off main.
  const order = ['a', 'b', 'c', 'head'];
  const git = {
    isAncestor: (ancestor, descendant) => order.includes(ancestor) && order.indexOf(ancestor) <= order.indexOf(descendant),
    distance: (ancestor, descendant) => order.indexOf(descendant) - order.indexOf(ancestor),
  };
  const run = (id, head_sha, extra = {}) => ({ id, head_sha, event: 'push', head_branch: 'main', conclusion: 'success', ...extra });
  const runs = [
    run(7, 'c', { event: 'pull_request' }),
    run(6, 'c', { head_branch: 'feature' }),
    run(5, 'c', { conclusion: 'cancelled' }),
    run(4, 'd'),
    run(3, 'head', { event: 'schedule' }),
    run(2, 'a', { event: 'schedule' }),
    run(1, 'b'),
  ];
  assert.equal(testedBase({ runs, head: 'head', branch: 'main', git }).base, 'b');
  const none = testedBase({ runs: runs.slice(0, 5), head: 'head', branch: 'main', git });
  assert.equal(none.base, null);
  assert.match(none.reason, /no successful ci run on main/);
});

test('a push run tests the merges whose own runs were cancelled, and falls back without a green base', async (t) => {
  const { root, run } = await plannerFixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  const commit = async (path) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), path);
    git('add', path);
    git('commit', '--quiet', '-m', path);
    return git('rev-parse', 'HEAD');
  };
  git('init', '--quiet');
  const tested = await commit('README.md');
  // Two merges whose push runs were cancelled, then the merge this run tests.
  await commit('apps/niimath/cancelled.js');
  await commit('apps/calmar/cancelled.js');
  const before = await commit('apps/lcmodel/cancelled.js');
  const head = await commit('apps/zarro/head.js');
  let runs = [];
  let status = 200;
  const server = createServer((request, response) => {
    const expected = request.url.startsWith('/repos/neurodesk/webapps/actions/workflows/ci.yml/runs?branch=main&status=success');
    response.writeHead(expected ? status : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ workflow_runs: runs }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const env = { ...process.env, GITHUB_OUTPUT: '', GITHUB_REPOSITORY: 'neurodesk/webapps', GITHUB_TOKEN: 'token', GITHUB_API_URL: `http://127.0.0.1:${server.address().port}` };
  const plan = async () => {
    const result = await new Promise((resolve) => {
      const child = spawn(process.execPath, ['scripts/app-plan.mjs', '--base', 'last-success', '--head', head], { cwd: root, env });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    return { ...JSON.parse(result.stdout), stderr: result.stderr };
  };
  const order = (await loadAppsRegistry()).apps.map((app) => app.id);
  const sorted = (ids) => [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));

  // The push's own `before` selects only zarro.
  assert.deepEqual(JSON.parse(JSON.parse(run('--base', before, '--head', head).stdout).selected_ids), ['zarro']);
  runs = [
    { id: 2, event: 'push', head_branch: 'main', head_sha: before, conclusion: 'cancelled' },
    { id: 1, event: 'push', head_branch: 'main', head_sha: tested, conclusion: 'success' },
  ];
  const union = await plan();
  assert.deepEqual(JSON.parse(union.selected_ids), sorted(['niimath', 'calmar', 'lcmodel', 'zarro']));
  assert.equal(union.fallback_reason, '');
  assert.match(union.stderr, new RegExp(`base ${tested} is the head of the last successful ci run on main`));

  for (const [name, setup] of [
    ['no green run', () => { runs = []; }],
    ['a rewritten history', () => { runs = [{ id: 1, event: 'push', head_branch: 'main', head_sha: '0123456789abcdef0123456789abcdef01234567', conclusion: 'success' }]; }],
    ['an API error', () => { status = 502; }],
  ]) {
    setup();
    const fallback = await plan();
    assert.equal(fallback.all_apps, 'true', name);
    assert.match(fallback.fallback_reason, /successful ci run on main/, name);
  }
});
