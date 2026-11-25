import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, relative as relativePath, resolve as resolvePath } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { AUTOMATION_CATALOG_READERS, changedManifests, changedPathsFromGit, CI_JOB_SCOPES, CLASSIFIED_ENTRY_FIELDS, createAppPlan, e2eTestDataImpact, EASTER_EGG_INPUTS, EASTER_EGG_JOB, EASTER_EGG_OUTPUT, EASTER_EGG_PACKAGES, easterEggCannotRead, HANDOFF_CATALOG_READERS, WORKSPACE_MANIFESTS, INDEPENDENT_ROOT_DEV_DEPENDENCIES, packageTestsCanSkipOnDraft, RUNTIME_MANIFEST_READERS, UnreadableDiffError, SITE_DATA_KEYS, SITE_KEY_READERS, SITE_ONLY_FILES, SITE_THEME_CONSUMERS, SITE_THEME_FILES, workspaceConfigImpact } from '../scripts/lib/app-plan.mjs';
import { siteCheckApps, smokeApps } from '../scripts/lib/smoke-apps.mjs';
import { loadAppInformation } from '../scripts/lib/app-information.mjs';
import { hostedThemeOptions } from '../scripts/lib/catalog-sites.mjs';
import { betNeeds } from '../test-utils/qsm-bet-runtime-startup.mjs';
import { assertParity, parityPeers, segmentationsToRun } from '../test-utils/shared-binary-startup.mjs';
import { APP_JOBS, carriedApps, NIGHTLY_JOBS, RERUN_JOBS, SITE_JOBS, testedBase } from '../scripts/lib/tested-base.mjs';
import { lockfileImpact } from '../scripts/lib/lockfile-impact.mjs';
import { loadAppsRegistry, parseAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { CATALOG, CATALOG_JOBS, loadConservativeWorkspaceGraph, reachableFrom, SITE, siteJobNames, WorkspaceGraphConfigurationError } from '../scripts/lib/workspace-graph.mjs';

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

test('shared homepage files still select the complete app catalog, while theme CSS and fonts test the full site and direct consumers', async () => {
  const registry = await loadAppsRegistry();
  for (const path of ['site/app-shell.js', 'scripts/lib/landing-page.mjs']) {
    const plan = createAppPlan(registry, [path]);
    assert.equal(plan.selected.length, registry.apps.length, path);
  }
  for (const path of SITE_THEME_FILES) {
    const plan = createAppPlan(registry, [path]);
    assert.deepEqual(plan.selected.map(({ id }) => id).sort(), [...SITE_THEME_CONSUMERS].sort(), path);
    assert.equal(plan.site, true, path);
    assert.equal(plan.siteCode, true, path);
    assert.equal(plan.allApps, false, path);
  }
  const fontsPlan = createAppPlan(registry, ['site/fonts/inter.woff2']);
  assert.deepEqual(fontsPlan.selected, []);
  assert.equal(fontsPlan.site, true);
  assert.equal(fontsPlan.siteCode, true);
  assert.equal(fontsPlan.allApps, false);
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
    app_scoped_runtime: false,
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

// ci.yml's site checks cover the selected apps and the canaries unless the
// change reaches code the site jobs run: then they cover every app.
test('a change to code the site jobs run is site code; app and site data changes are not', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  for (const path of ['scripts/audit-interfaces.mjs', 'test/mobile-layout.smoke.mjs', 'test/interface-workflows.smoke.mjs', 'test/runtime-startup.smoke.mjs', 'test-utils/shared-binary-startup.mjs', 'scripts/lib/smoke-apps.mjs', 'scripts/build-site.mjs']) {
    const plan = createAppPlan(registry, [path], workspace);
    assert.equal(plan.allApps, false, path);
    assert.equal(plan.siteCode, true, path);
  }
  for (const paths of [['apps/niimath/src/main.js'], ['apps/niimath/automation.json'], ['site/landing.js', 'apps/zarro/index.html']]) {
    const plan = createAppPlan(registry, paths, workspace);
    assert.equal(plan.site, true, paths[0]);
    assert.equal(plan.siteCode, false, paths[0]);
  }
  assert.equal(createAppPlan(registry, ['apps/niimath/src/main.js', 'scripts/audit-interfaces.mjs'], workspace).siteCode, true);
  assert.equal(createAppPlan(registry, [], workspace).siteCode, true, 'a whole-catalogue plan covers every app');
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
  assert.deepEqual(other.selected.map((app) => app.id), ['dicompare', 'pipeline-builder'], 'only dicompare and Pipeline builder depend on the desktop package');
});

function manifest(before, after) {
  return { before: JSON.stringify(before), after: JSON.stringify(after) };
}

// Builds embed versions, but only as the version: no test compares one with a
// committed reference, and workspace-contracts checks that every copy agrees.
// The nightly run still builds every app at the new version.
test('a package version bump is release bookkeeping and selects no app', async () => {
  const registry = await loadAppsRegistry();
  const manifests = new Map([['packages/synthsr/package.json', manifest({ name: 'x', version: '1.0.0' }, { name: 'x', version: '1.1.0' })]]);
  assert.deepEqual(createAppPlan(registry, ['packages/synthsr/package.json'], await graph, manifests).selected, []);
  const dependency = new Map([['packages/synthsr/package.json', manifest({ name: 'x', version: '1.0.0' }, { name: 'x', version: '1.1.0', dependencies: { a: '1' } })]]);
  assert.ok(createAppPlan(registry, ['packages/synthsr/package.json'], await graph, dependency).selected.some((app) => app.id === 'synthsr'));
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
  const plan = (after) => createAppPlan(registry, ['package.json'], resolved, new Map([['package.json', manifest({ scripts }, after)], ['pnpm-lock.yaml', manifest(baseLock, baseLock)]]));
  assert.deepEqual(plan({ scripts: { ...scripts, 'new-app': 'B' } }).selected, []);
  assert.equal(plan({ scripts: { ...scripts, 'new-app': 'B' } }).site, false);
  const site = plan({ scripts: { ...scripts, 'test:mobile': 'C' } });
  assert.deepEqual(site.selected, []);
  assert.equal(site.site, true);
  assert.equal(plan({ scripts, devDependencies: { a: '1' } }).allApps, true);
  // Every root script a ci.yml job runs is an input, read from ci.yml: the guard's
  // check:integration (app-plan) and test:contracts (workspace-contracts) included.
  const workspace = await graph;
  assert.ok(workspace.jobScripts.get('app-plan').has('check:integration'));
  assert.ok(workspace.jobScripts.get('workspace-contracts').has('test:contracts') && workspace.jobScripts.get('package-tests').has('test:packages'));
  for (const name of ['check:integration', 'test:contracts', 'test:packages']) {
    const edited = plan({ scripts: { ...scripts, [name]: 'echo' } });
    assert.equal(edited.allApps, true, name);
    assert.match(edited.reasons.fallback, new RegExp(`^package\\.json: ci\\.yml's \\S+ job runs root script ${name}$`), name);
  }
  // The easter egg's pnpm install reads every package.json, so any edit to one runs it on a pull request.
  assert.deepEqual(plan({ scripts: { ...scripts, 'new-app': 'B' } }).easterEgg, ['package.json: outside the trees the job cannot read']);
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

test('root Knip and Stryker changes run their independent workflows without selecting apps', async () => {
  const registry = await loadAppsRegistry();
  for (const name of INDEPENDENT_ROOT_DEV_DEPENDENCIES) {
    const before = { devDependencies: { [name]: '1.0.0', esbuild: '1.0.0' }, scripts: {} };
    const after = { devDependencies: { [name]: '2.0.0', esbuild: '1.0.0' }, scripts: { 'quality:unused': 'node scripts/report-unused-code.mjs' } };
    const root = changeLock(lock => {
      lock.importers['.'].devDependencies[name] = dep('1.0.0');
      resolve(lock, `${name}@1.0.0`);
    });
    const plan = createAppPlan(registry, ['package.json'], await graph, new Map([['package.json', manifest(before, after)], ['pnpm-lock.yaml', manifest(root, root)]]));
    assert.deepEqual(plan.selected, [], name);
    assert.equal(plan.site, false, name);
    assert.equal(plan.reasons.fallback, null, name);
    const next = structuredClone(root);
    next.importers['.'].devDependencies[name] = dep('2.0.0');
    resolve(next, `${name}@2.0.0`);
    const locked = createAppPlan(registry, ['pnpm-lock.yaml'], await graph, new Map([['pnpm-lock.yaml', manifest(root, next)]]));
    assert.deepEqual(locked.selected, [], name);
    assert.equal(locked.site, false, name);
  }
});

test('missing root tool package metadata selects the full catalog with a fallback reason', async () => {
  const registry = await loadAppsRegistry();
  const before = changeLock(lock => { lock.importers['.'].devDependencies.knip = dep('5.0.0'); });
  const invalid = structuredClone(before);
  delete invalid.packages['knip@5.0.0'];
  for (const [base, head] of [[before, invalid], [invalid, before]]) {
    for (const path of ['pnpm-lock.yaml', 'package.json']) {
      const plan = createAppPlan(registry, [path], await graph, new Map([
        ['pnpm-lock.yaml', manifest(base, head)],
        ['package.json', manifest({ devDependencies: { knip: '5.0.0' } }, { devDependencies: { knip: '^5.0.0' } })],
      ]));
      assert.equal(plan.allApps, true, path);
      assert.equal(plan.site, true, path);
      assert.match(plan.reasons.fallback, /knip@5\.0\.0.*package metadata/, path);
    }
  }
});

test('unknown root tools, runtime dependencies and mixed changes still select the catalog', async () => {
  const registry = await loadAppsRegistry();
  for (const [before, after] of [
    [{ devDependencies: { esbuild: '1.0.0' } }, { devDependencies: { esbuild: '2.0.0' } }],
    [{ dependencies: { knip: '1.0.0' } }, { dependencies: { knip: '2.0.0' } }],
    [{ devDependencies: { knip: '1.0.0' } }, { devDependencies: { knip: '2.0.0' }, engines: { node: '>=24' } }],
  ]) {
    const plan = createAppPlan(registry, ['package.json'], await graph, new Map([['package.json', manifest(before, after)], ['pnpm-lock.yaml', manifest(baseLock, baseLock)]]));
    assert.equal(plan.selected.length, registry.apps.length);
    assert.ok(plan.reasons.fallback);
  }
});

test('Knip and Stryker remain independent of app, native and browser inputs', async () => {
  const paths = execFileSync('git', ['ls-files', '-z', '--', 'apps', 'packages', 'exes', 'test-utils'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(path => /\.(?:[cm]?[jt]sx?|json|ya?ml|toml|sh|py|rs)$|\/Makefile$/.test(path));
  for (const path of paths) {
    assert.doesNotMatch(await readFile(join(repoRoot, path), 'utf8'), /\bknip\b|@stryker-mutator\/core|\bstryker\b/, `${path} now consumes an independent root tool; revisit its CI ownership`);
  }
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/quality.yml'), 'utf8'));
  assert.ok(Object.hasOwn(workflow.on, 'pull_request'), 'the quality workflow still runs on every PR');
  for (const command of ['pnpm quality:unused', 'pnpm quality:mutations:smoke']) {
    assert.ok(Object.values(workflow.jobs).some(job => job.steps.some(step => step.run === command)), command);
  }
});

test('ESLint stays out of every app build, unit test and browser test', async () => {
  // Only the lint runner, the shared config and the lint coverage test load
  // ESLint, and nothing else loads the runner or the config.
  const workspace = await graph;
  const catalog = reachableFrom(workspace, CATALOG);
  const loaders = new Set(['scripts/lint.mjs', 'eslint.config.js', 'test-utils/lint-coverage-suite.mjs']);
  const imports = /(?:from\s*|import\s*\(\s*|require\(\s*)['"](?:(?:eslint|@eslint\/js|globals)(?:\/[^'"]*)?|[^'"]*\/(?:lint\.mjs|eslint\.config\.js))['"]|['"](?:[^'"]*\/)?scripts\/lint\.mjs['"]/;
  const sources = execFileSync('git', ['ls-files', '-z'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0').filter(path => /\.(?:[cm]?[jt]sx?)$/.test(path));
  for (const path of sources) {
    // Workspace ESLint configs re-export the root one; only ESLint loads them.
    if (loaders.has(path) || /(?:^|\/)eslint\.config\.m?js$/.test(path)) continue;
    // Contract tests run in workspace-contracts, unless a per-app job runs them.
    if (path.startsWith('test/') && !catalog.has(path)) continue;
    assert.doesNotMatch(await readFile(join(repoRoot, path), 'utf8'), imports, `${path} loads ESLint; revisit INDEPENDENT_ROOT_DEV_DEPENDENCIES`);
  }
  // The per-app and site jobs never load ESLint, its runner, or scripts/quality/.
  const siteNodes = reachableFrom(workspace, SITE);
  for (const path of loaders) {
    assert.ok(!catalog.has(path), `ci.yml's per-app jobs run ${path}`);
    assert.ok(!siteNodes.has(path), `ci.yml's site jobs run ${path}`);
  }
  assert.ok(![...catalog].some((node) => node.startsWith('scripts/quality/')), "ci.yml's per-app jobs reach scripts/quality/");
  assert.ok(![...siteNodes].some((node) => node.startsWith('scripts/quality/')), "ci.yml's site jobs reach scripts/quality/");
  const ci = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  for (const name of [...CATALOG_JOBS, ...siteJobNames(ci)]) {
    for (const step of ci.jobs[name].steps) assert.doesNotMatch(step.run ?? '', /\blint\b|eslint/, `${name} runs lint`);
  }
  const packages = await workspaceScripts();
  // The traversal crosses packages: SYNcro's build builds Greedy's WebAssembly.
  assert.ok(scriptsRun(packages, 'apps/syncro', ['build']).some(([dir, name]) => dir === 'packages/greedy' && name === 'build:wasm'));
  for (const app of await loadAppsRegistry().then(registry => registry.apps)) {
    for (const [dir, name, command] of scriptsRun(packages, `apps/${app.id}`, ['build', 'test:e2e', app.ci.release_test ?? 'test'])) {
      assert.doesNotMatch(command, /\beslint\b|scripts\/lint\.mjs|scripts\/quality\/|eslint\.config/, `${app.id}'s CI scripts reach ${dir} ${name}, which runs ESLint or its runner`);
    }
  }
});

// Every workspace package's directory, name and scripts, the root as '.'.
async function workspaceScripts() {
  const dirs = ['.', ...['apps', 'packages', 'exes', 'site/easter-eggs'].flatMap((top) => {
    try {
      return execFileSync('git', ['ls-files', '--', `${top}/*/package.json`], { cwd: repoRoot, encoding: 'utf8' }).split('\n').filter(Boolean).map((path) => path.slice(0, -'/package.json'.length));
    } catch {
      return [];
    }
  })];
  const packages = new Map();
  for (const dir of dirs) {
    const manifest = JSON.parse(await readFile(join(repoRoot, dir, 'package.json'), 'utf8'));
    packages.set(dir, { name: manifest.name, scripts: manifest.scripts ?? {} });
  }
  return packages;
}

// The [dir, script, command] triples that running `names` in `start` executes:
// lifecycle hooks, scripts run by name, and scripts in other packages reached
// through `pnpm --filter`, `-C`/`--dir`, `--prefix`, `-w`, `-r` or `cd`. An
// unresolvable filter reaches every package.
function scriptsRun(packages, start, names) {
  const resolveFilter = (from, filter) => {
    if (filter.startsWith('.')) return [join(from, filter).replace(/\/$/, '') || '.'];
    const exact = [...packages].filter(([, manifest]) => manifest.name === filter).map(([dir]) => dir);
    return exact.length ? exact : [...packages.keys()];
  };
  const seen = new Set();
  const visited = [];
  const pending = names.map((name) => [start, name]);
  while (pending.length) {
    const [dir, name] = pending.pop();
    for (const hook of [`pre${name}`, name, `post${name}`]) {
      const command = packages.get(dir)?.scripts[hook];
      if (command === undefined || seen.has(`${dir}\0${hook}`)) continue;
      seen.add(`${dir}\0${hook}`);
      visited.push([dir, hook, command]);
      let cwd = dir;
      for (const segment of command.split(/&&|\|\||;|\|/)) {
        const words = segment.trim().split(/\s+/).filter(Boolean);
        if (words[0] === 'cd' && words[1]) {
          cwd = join(cwd, words[1]);
          continue;
        }
        if (words[0] !== 'pnpm' && words[0] !== 'npm') continue;
        let targets = [cwd];
        let index = 1;
        while (index < words.length && words[index].startsWith('-')) {
          const [flag, inline] = words[index].split('=');
          const value = () => inline ?? words[++index];
          if (flag === '--filter' || flag === '-F') targets = resolveFilter(cwd, value());
          else if (flag === '-C' || flag === '--dir' || flag === '--prefix') targets = [join(cwd, value())];
          else if (flag === '-w' || flag === '--workspace-root') targets = ['.'];
          else if (flag === '-r' || flag === '--recursive') targets = [...packages.keys()];
          index += 1;
        }
        if (words[index] === 'run' || words[index] === 'run-script') index += 1;
        const script = words[index];
        if (script) for (const target of targets) pending.push([target, script]);
      }
    }
  }
  return visited;
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
      lock.importers['.'].devDependencies.esbuild = dep('9.1.0');
      resolve(lock, 'esbuild@9.1.0');
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
  assert.equal(plan.siteCode, false);
  const qsmbly = await registryPlan((registry) => {
    entry(registry, 'qsmbly').keywords.push('changed');
  });
  assert.deepEqual(qsmbly.selected.map((app) => app.id), ['qsmbly', 'brain-extraction']);
});

test('app registration with its lockfile importer stays scoped to that webapp and the builds listing every app', async () => {
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const without = parse(text);
  without.apps = without.apps.filter((app) => app.id !== 'surfannotate');
  const plan = createAppPlan(await loadAppsRegistry(), ['LICENSES.md', 'apps/surfannotate/package.json', 'pnpm-lock.yaml', 'registry/apps.yml'], await graph, new Map([
    ['registry/apps.yml', { before: stringify(without), after: text }],
    ['pnpm-lock.yaml', manifest(baseLock, changeLock((lock) => {
      lock.importers['apps/surfannotate'] = { dependencies: { '@niivue/niivue': dep('1.0.0') } };
    }))],
  ]));
  // Pipeline Builder generates a tool per operation of every registered app.
  assert.deepEqual(plan.selected.map((app) => app.id), ['surfannotate', 'pipeline-builder']);
  assert.deepEqual(plan.browserApps.include.map(({ app }) => app), ['surfannotate', 'pipeline-builder']);
  assert.equal(plan.allApps, false);
});

test('reordering registry entries selects no app but the site build; removing one selects the handoff menus and the tool catalog', async () => {
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const retired = parse(text);
  retired.apps.push({ ...entry(retired, 'niimath'), id: 'retired', path: 'retired' });
  const removed = createAppPlan(await loadAppsRegistry(), ['registry/apps.yml'], await graph, new Map([['registry/apps.yml', { before: stringify(retired), after: text }]]));
  const reordered = await registryPlan((after) => {
    after.apps.reverse();
  });
  // DICOM View's "Open in another webapp" menu listed the removed app, and Pipeline Builder its tools.
  assert.deepEqual(removed.selected.map((app) => app.id), ['dicomview', 'pipeline-builder']);
  assert.deepEqual(reordered.selected, []);
  for (const plan of [removed, reordered]) {
    assert.equal(plan.site, true);
    assert.equal(plan.reasons.fallback, null);
  }
});

// The SMOKE_APPS value ci.yml gives a pull request's site checks for `plan`.
function pullRequestSmokeApps(registry, plan) {
  return siteCheckApps(registry, { event: 'pull_request', plan: {
    all_apps: String(plan.allApps), site_code: String(plan.siteCode), selected_ids: JSON.stringify(plan.selected.map((app) => app.id)),
  } }).value;
}

test('a NODDI-only change runs the MindGrab parity check with a peer that shares its CPU binary', async () => {
  const registry = await loadAppsRegistry();
  const manifest = JSON.parse(await readFile(join(repoRoot, 'runtime-assets/manifest.json'), 'utf8'));
  const value = pullRequestSmokeApps(registry, createAppPlan(registry, ['apps/noddi/src/main.js'], await graph));
  const { apps, added } = smokeApps(registry.apps, value, parityPeers(manifest));
  const binary = manifest.families.flatMap((family) => family.files.map((file) => ({ family, file })))
    .find(({ file }) => file.name === 'brainchop-mindgrab.wasm' && file.consumers?.includes('noddi'));
  assert.ok(added.some((id) => binary.file.consumers.includes(id)), `${added.join(', ')} holds a peer of noddi`);
  const jobs = apps.filter((app) => binary.file.consumers.includes(app.id))
    .map((app) => ({ family: binary.family, file: binary.file, app, consumers: binary.file.consumers, binaryPath: binary.file.name }));
  assert.equal(assertParity(segmentationsToRun(jobs, { comparators: added }).map((job) => ({ job, sha256: 'one output', label: job.app.id }))), 1);
});

test('a change to the CALMaR fixture runs both production BET probes that segment it', async () => {
  const registry = await loadAppsRegistry();
  const value = pullRequestSmokeApps(registry, createAppPlan(registry, ['apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz'], await graph));
  const { apps } = smokeApps(registry.apps, value, betNeeds);
  for (const id of ['qsmbly', 'brain-extraction']) assert.ok(apps.some((app) => app.id === id), `${id} probes the fixture`);
});

test('a registry change to what the handoff menus list selects the apps that render one', async () => {
  const registry = await loadAppsRegistry();
  const none = await registryPlan((after) => {
    entry(after, 'bison').handoff = 'none';
  });
  assert.deepEqual(none.selected.map((app) => app.id).sort(), ['bison', 'dicomview']);
  assert.deepEqual(none.reasons.apps.dicomview, ["registry/apps.yml: an entry changed what dicomview's handoff menu lists"]);
  assert.equal(none.siteCode, false);
  assert.ok(pullRequestSmokeApps(registry, none).split(',').includes('dicomview'));
  for (const edit of [(app) => { app.title = 'Renamed'; }, (app) => { app.also_in = ['msk']; }, (app) => { app.support_status = 'retired'; }]) {
    const plan = await registryPlan((after) => edit(entry(after, 'bison')));
    assert.ok(plan.selected.some((app) => app.id === 'dicomview'), plan.reasons.apps.bison.join());
  }
  // A field the menu does not show stays with its own app.
  const described = await registryPlan((after) => {
    entry(after, 'bison').keywords.push('changed');
  });
  assert.deepEqual(described.selected.map((app) => app.id), ['bison']);
  // Without a workspace graph the readers are unknown, so every app is tested.
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const renamed = parse(text);
  entry(renamed, 'bison').title = 'Renamed';
  const blind = createAppPlan(registry, ['registry/apps.yml'], null, new Map([['registry/apps.yml', { before: text, after: stringify(renamed) }]]));
  assert.equal(blind.allApps, true);
  assert.match(blind.reasons.fallback, /the apps that render one are unknown/);
});

test('removing or registering an app selects the builds that generate tools from every registered app', async () => {
  const registry = await loadAppsRegistry();
  const files = ['registry/apps.yml', 'registry/app-information.yml', 'registry/standalone.json'];
  const [apps, information, standalone] = await Promise.all(files.map((file) => readFile(join(repoRoot, file), 'utf8')));
  const without = parse(apps);
  without.apps = without.apps.filter((app) => app.id !== 'niimath');
  const info = parse(information);
  delete info.apps.niimath;
  const catalog = JSON.parse(standalone);
  delete catalog.apps.niimath;
  const removedTexts = [stringify(without), stringify(info), `${JSON.stringify(catalog, null, 2)}\n`];
  const plan = (registered, before, after) => createAppPlan(registered, files, workspace, new Map(files.map((file, index) => [file, { before: before[index], after: after[index] }])));
  const workspace = await graph;
  const remaining = { ...registry, apps: registry.apps.filter((app) => app.id !== 'niimath') };
  // Pipeline Builder bundles a tool per operation of every registered app (scripts/lib/neuroflow-bundle.mjs).
  const removed = plan(remaining, [apps, information, standalone], removedTexts);
  assert.deepEqual(removed.selected.map((app) => app.id).sort(), ['dicomview', 'pipeline-builder']);
  assert.ok(removed.reasons.apps['pipeline-builder'].some((reason) => reason.startsWith('registry/apps.yml: the registered apps changed')));
  assert.equal(removed.allApps, false);
  const added = plan(registry, removedTexts, [apps, information, standalone]);
  assert.deepEqual(added.selected.map((app) => app.id).sort(), ['dicomview', 'niimath', 'pipeline-builder']);
  // Without a graph the builds reading the registered apps are unknown.
  const blind = createAppPlan(registry, ['registry/apps.yml'], null, new Map([['registry/apps.yml', { before: removedTexts[0], after: apps }]]));
  assert.equal(blind.allApps, true);
});

test('a registry entry field the planner does not classify tests every app', async () => {
  const text = parse(await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8'));
  const fields = new Set(text.apps.flatMap((app) => Object.keys(app)));
  assert.deepEqual([...fields].filter((field) => !CLASSIFIED_ENTRY_FIELDS.includes(field)), [], 'classify every field the registry uses');
  const plan = await registryPlan((after) => {
    entry(after, 'bison').handoff_label = 'Send';
  });
  assert.equal(plan.allApps, true);
  assert.equal(plan.reasons.fallback, "registry/apps.yml: the bison entry's handoff_label field is not one the planner classifies");
});

test('HANDOFF_CATALOG_READERS are the functions that read the handoff catalog an app page carries', async () => {
  const sources = execFileSync('git', ['ls-files', 'packages/components/src', 'site'], { cwd: repoRoot, encoding: 'utf8' }).split('\n')
    .filter((file) => /\.[cm]?[jt]sx?$/.test(file) && !file.startsWith('site/easter-eggs/'));
  const readers = [];
  for (const file of sources) {
    const text = await readFile(join(repoRoot, file), 'utf8');
    if (!text.includes('data-neurodesk-app-information')) continue;
    for (const [, name, body] of text.matchAll(/export function (\w+)\([^)]*\) \{\n([\s\S]*?)\n\}/g)) {
      if (/\.catalog\b/.test(body)) readers.push(`${file}:${name}`);
    }
  }
  assert.deepEqual(readers, HANDOFF_CATALOG_READERS.map((name) => `packages/components/src/handoff/index.js:${name}`));
});

test("a file another app's code names selects that app too", async () => {
  const registry = await loadAppsRegistry();
  // DICOM View and SeedSeg stage dicompare's embedding kit into their builds.
  const kit = createAppPlan(registry, ['apps/dicompare/public/embed/DicompareController.js'], await graph);
  assert.deepEqual(kit.selected.map((app) => app.id).sort(), ['dicompare', 'dicomview', 'seedseg']);
  assert.deepEqual(kit.reasons.apps.dicomview, ["apps/dicompare/public/embed/DicompareController.js: dicomview's code reads it"]);
  // Elsewhere in dicompare nothing else is selected.
  assert.deepEqual(createAppPlan(registry, ['apps/dicompare/src/App.tsx'], await graph).selected.map((app) => app.id), ['dicompare']);
});

test('registry changes outside the app entries and site keys select the whole catalog with a reason', async () => {
  const plan = await registryPlan((registry) => {
    registry.catalog_owner = 'someone';
  });
  assert.equal(plan.allApps, true);
  assert.equal(plan.reasons.fallback, 'registry/apps.yml: its catalog_owner section changed, and every app build reads it');
  const duplicate = await registryPlan((registry) => {
    registry.apps.push(entry(registry, 'niimath'));
  });
  assert.match(duplicate.reasons.fallback, /missing or duplicate ids/);
  const missingBase = createAppPlan(await loadAppsRegistry(), ['registry/apps.yml'], await graph);
  assert.equal(missingBase.reasons.fallback, 'registry/apps.yml: the base or head registry is unavailable');
});

test('a reworded, added or unused site category selects only the site build', async () => {
  // A new app's pull request usually rewords its category; that used to test every app.
  const reworded = await registryPlan((registry) => {
    registry.site.categories[0].description = 'Reworded for a new app.';
    registry.site.categories.push({ id: 'new-category', title: 'New', description: 'Added.' });
  });
  assert.equal(reworded.allApps, false);
  assert.deepEqual(Object.keys(reworded.reasons.apps), []);
  assert.equal(reworded.site, true);
  assert.equal(reworded.siteCode, false);
  assert.ok(reworded.reasons.site.includes('registry/apps.yml: site.categories[].description changed, and only the site build reads it'));
  const withEntry = await registryPlan((registry) => {
    registry.site.categories[0].title = 'Renamed';
    registry.apps.find((app) => app.id === 'niimath').description = 'Reworded too';
  });
  assert.deepEqual(Object.keys(withEntry.reasons.apps), ['niimath']);
  // A category no app names can go; one an app still names leaves the head registry invalid for every build.
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const withUnused = parse(text);
  withUnused.site.categories.push({ id: 'unused', title: 'Unused', description: 'No app.' });
  const dropped = createAppPlan(await loadAppsRegistry(), ['registry/apps.yml'], await graph, new Map([['registry/apps.yml', { before: stringify(withUnused), after: text }]]));
  assert.deepEqual(dropped.selected, []);
  assert.equal(dropped.reasons.fallback, null);
  const removed = await registryPlan((registry) => {
    registry.site.categories.pop();
  });
  assert.equal(removed.allApps, true);
  assert.match(removed.reasons.fallback, /^registry\/apps\.yml: it is not valid at head \(Invalid app registry: - categories must be .* for fastprep\), and every app build validates it$/);
  const mixed = await registryPlan((registry) => {
    registry.site.categories[0].description = 'Reworded.';
    registry.site.mirror = 'example.org';
  });
  assert.equal(mixed.reasons.fallback, 'registry/apps.yml: its site section has site.mirror, and no rule says which builds read it');
});

test('a site key the table does not name selects every app, whatever its depth or value', async () => {
  // Both registries validate: an empty mapping has no leaf that differs, and hub.unclassified is no key of site.hub.
  const cases = {
    'site.unclassified': (registry) => { registry.site.unclassified = {}; },
    'site.hub.unclassified': (registry) => { registry.site.hub.unclassified = 'one'; },
    'site.catalogs[].desktop.notes': (registry) => { registry.site.catalogs[0].desktop.notes = []; },
    'site.analytics.measurement_id': (registry) => { registry.site.analytics.measurement_id = { id: registry.site.analytics.measurement_id }; },
    'site.categories': (registry) => { registry.site.categories.push(structuredClone(registry.site.categories[0])); },
    // One key named brand.home, not brand then home: joined with dots it looks like a listed key.
    'site.hub["brand.home"]': (registry) => { registry.site.hub['brand.home'] = 'https://example.org/'; },
    'site.catalogs[]["desktop.release"]': (registry) => { registry.site.catalogs[0]['desktop.release'] = 'x'; },
    'site["catalogs[]"]': (registry) => { registry.site['catalogs[]'] = []; },
  };
  for (const [key, edit] of Object.entries(cases)) {
    const plan = await registryPlan(edit);
    assert.equal(plan.allApps, true, key);
    assert.match(plan.reasons.fallback ?? '', new RegExp(`^registry/apps\\.yml: (?:its site section has ${key.replace(/[.[\]]/g, '\\$&')}(?:\\.id)?, and no rule|it is not valid at head)`), key);
  }
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  for (const edit of [cases['site.unclassified'], cases['site.hub.unclassified'], cases['site.hub["brand.home"]']]) {
    const after = parse(text);
    edit(after);
    assert.doesNotThrow(() => parseAppsRegistry(stringify(after)), 'the loader accepts it, so only the shape check stops it');
  }
  // Every key of today's site section is in the table.
  const now = parse(text).site;
  const leaves = (value, path) => Array.isArray(value) ? value.flatMap((entry) => leaves(entry, `${path}[]`))
    : value !== null && typeof value === 'object' ? Object.entries(value).flatMap(([name, child]) => leaves(child, `${path}.${name}`)) : [path];
  assert.deepEqual([...new Set(leaves(now, 'site'))].filter((key) => !Object.hasOwn(SITE_KEY_READERS, key)), []);
});

test('a site key selects the apps that reach a file reading it, and only the site build reads the rest', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  // PR #872 moved the SciGet logo's link and reworded the hub's subheading.
  const text = await readFile(join(repoRoot, 'registry/apps.yml'), 'utf8');
  const before = parse(text);
  before.site.hub.description = 'Scientific software that runs locally in your browser, grouped by field.';
  for (const entry of [before.site.hub, ...before.site.catalogs.filter((catalog) => catalog.brand.name === 'SciGet')]) entry.brand.home = 'https://webapps.sciget.org/';
  const reaching = (readers) => registry.apps.filter((app) => readers.some((reader) => reachableFrom(workspace, `apps/${app.id}`).has(reader))).map(({ id }) => id);
  const links = createAppPlan(registry, ['registry/apps.yml'], workspace, new Map([['registry/apps.yml', { before: stringify(before), after: text }]]));
  // A catalogue's brand is read by the desktop scripts that hold a whole catalogue entry.
  assert.deepEqual(links.selected.map(({ id }) => id), reaching(SITE_KEY_READERS['site.catalogs[].brand.home']));
  assert.ok(links.selected.length <= 2, 'only the apps that reach the desktop suite scripts');
  assert.equal(links.reasons.fallback, null);
  assert.equal(links.site, true);
  assert.ok(links.reasons.site.includes('registry/apps.yml: site.hub.brand.home changed, and only the site build reads it'));
  const hub = await registryPlan((after) => {
    after.site.hub.description = 'Reworded.';
    after.site.hub.brand.home = 'https://example.org/';
  });
  assert.deepEqual(hub.selected, []);
  assert.equal(hub.reasons.fallback, null);
  const suite = await registryPlan((after) => {
    after.site.catalogs[1].desktop.product_name = 'MSK Desktop';
  });
  assert.deepEqual(suite.selected.map(({ id }) => id), reaching(SITE_KEY_READERS['site.catalogs[].desktop.product_name']));
  assert.ok(suite.selected.length > 0 && suite.selected.length < registry.apps.length);
  assert.match(suite.reasons.apps[suite.selected[0].id][0], /^registry\/apps\.yml: site\.catalogs\[\]\.desktop\.product_name changed, and scripts\/desktop\/\S+ reads it$/);
  const measurement = await registryPlan((after) => {
    after.site.analytics.measurement_id = 'G-CHANGED';
  });
  assert.deepEqual(measurement.selected.map(({ id }) => id), reaching(SITE_KEY_READERS['site.analytics.measurement_id']));
  assert.equal(measurement.reasons.fallback, null);
  // A catalogue that is added names a new id, which every themed build's standalone check reads.
  const added = await registryPlan((after) => {
    const desktop = { product_name: 'Spare Webapps', app_id: 'org.sciget.spare', release: 'spare-webapps', executable: 'spare-webapps' };
    after.site.catalogs.push({ ...structuredClone(after.site.catalogs[1]), id: 'spare', host: 'spareapps.sciget.org', desktop });
    const niimath = after.apps.find((app) => app.id === 'niimath');
    niimath.also_in = [...(niimath.also_in ?? []), 'spare'];
  });
  assert.equal(added.reasons.fallback, null);
  const ids = (plan) => plan.selected.map(({ id }) => id).sort();
  assert.deepEqual(ids(added), [...new Set(['niimath', ...reaching(SITE_KEY_READERS['site.catalogs[].id'])])].sort());
  assert.ok(added.reasons.apps.niimath.includes('registry/apps.yml: the niimath entry changed'));
  // Without a graph a key some app reads cannot be followed.
  const changed = parse(text);
  changed.site.analytics.measurement_id = 'G-CHANGED';
  const blind = createAppPlan(registry, ['registry/apps.yml'], null, new Map([['registry/apps.yml', { before: text, after: stringify(changed) }]]));
  assert.match(blind.reasons.fallback, /site\.analytics\.measurement_id changed, and there is no workspace graph/);
});

// Files an app build or an app's tests run that load registry/apps.yml or
// read its site section. The loader validates every key (only a valid head
// registry narrows); siteKeysRead finds what each of the others reads.
const REGISTRY_LOADER = 'scripts/lib/apps-registry.mjs';
const SITE_SECTION_READERS = new Set([
  REGISTRY_LOADER,
  'scripts/theme-app-dist.mjs',
  'scripts/lib/vite-app-config.mjs',
  'scripts/dev-server.mjs',
  'scripts/lib/standalone.mjs',
  'scripts/desktop/suite.mjs',
  'scripts/desktop/pack.mjs',
  'scripts/desktop/models-pack.mjs',
  'scripts/desktop/release-files.mjs',
  // These read app entries only.
  'scripts/lib/app-automation.mjs',
  'scripts/lib/app-examples.mjs',
  'scripts/lib/app-information.mjs',
  'scripts/lib/neuroflow-bundle.mjs',
  'test/easy-mp2rage-workspace.smoke.mjs',
  'test/examples.smoke.mjs',
  'apps/dicomview/e2e/smoke.spec.js',
  'apps/hmc/test/runtime-assets.test.js',
  'apps/pipeline-builder/e2e/smoke.spec.js',
]);
// Functions that read the site section for their caller: the keys each reads,
// and whether it hands the caller a whole catalogue entry.
const SITE_HELPERS = {
  findCatalog: { reads: ['site.catalogs[].id'], entry: true },
  primaryCatalog: { reads: ['site.domain', 'site.catalogs[].host'], entry: true },
  suiteCatalog: { reads: ['site.domain', 'site.catalogs[].id', 'site.catalogs[].host'], entry: true },
  appUrl: { reads: ['site.catalogs[].id', 'site.catalogs[].host'], entry: false },
};
const SITE_KEYS = Object.keys(SITE_KEY_READERS);
const SITE_LISTS = new Set(SITE_KEYS.flatMap((key) => [...key.matchAll(/^(.*?)\[\]/g)].map(([, list]) => list)));
const keysBelow = (path) => SITE_KEYS.filter((key) => key === path || key.startsWith(`${path}.`) || key.startsWith(`${path}[]`));
// Follows a property chain from `path` while it names site keys.
function walkSiteKeys(path, names) {
  for (const [index, name] of names.entries()) {
    const next = `${path}.${name}`;
    if (SITE_LISTS.has(path) || !keysBelow(next).length) return { path, stopped: name, rest: names.slice(index) };
    path = next;
  }
  return { path, stopped: null };
}
const chainNames = (chain) => chain.split(/\??\./).filter(Boolean);
// The index of the bracket that closes the one at `open`.
function closing(text, open) {
  let depth = 0;
  for (let index = open; index < text.length; index++) {
    if ('([{'.includes(text[index])) depth++;
    if (')]}'.includes(text[index]) && --depth === 0) return index;
  }
  return text.length;
}
// The site keys a file's text reads. A chain that names a key reads it; one
// that stops at a mapping or list hands it on, spreads it or iterates it, and
// reads every key below; a list iterated with a callback reads what the
// callback reads of its entry; a helper's whole catalogue entry reads every
// key of the entry, or of what is destructured from it. A chain that names a
// key the table lacks reads that key, so the test names it.
// Each use of the registry object in a file's code, besides `.site` chains:
// what it reads of the site section. A use the check does not recognise reads
// all of it. Recognised: `.apps`, a binding (`const registry = await
// loadAppsRegistry()`, a parameter), a destructuring without `site`, and an
// argument to a function in `callees` (defined in a listed reader, so its own
// text is checked) or to a site helper (counted by siteKeysRead).
const LOADERS = /\b(?:loadAppsRegistry|parseAppsRegistry)\(/;
function registryUses(text, callees) {
  // Comment lines and quoted strings are prose.
  const code = text.split('\n').map((line) => (/^\s*(?:\/\/|\*|\/\*)/.test(line) ? '' : line)).join('\n').replace(/(['"])(?:\\.|(?!\1)[^\\\n])*\1/g, '""');
  const names = new Set(['registry', ...[...code.matchAll(/\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?(?:loadAppsRegistry|parseAppsRegistry)\(/g)].map(([, name]) => name)]);
  const unknown = [];
  // Destructuring the loader's result directly.
  for (const match of code.matchAll(/=\s*(?:await\s+)?(?:loadAppsRegistry|parseAppsRegistry)\(/g)) {
    const before = code.slice(0, match.index).trimEnd();
    if (!before.endsWith('}')) continue;
    const pattern = code.slice(openingBrace(code, before.length - 1), before.length);
    if (/\bsite\b|\.\.\.|\[/.test(pattern)) unknown.push(`destructures ${pattern.replace(/\s+/g, ' ')} from the loader`);
  }
  // A computed member of the loader's result: `(await loadAppsRegistry())[key]`, whatever its arguments hold.
  for (const match of code.matchAll(/\b(?:loadAppsRegistry|parseAppsRegistry)\s*\(/g)) {
    const after = code.slice(closing(code, match.index + match[0].length - 1) + 1);
    if (/^\s*\)?\s*(?:\?\.)?\s*\[/.test(after)) unknown.push(`${match[0]}...)${after.slice(0, 20).split('\n')[0]} (a computed member of the loader's result)`);
  }
  for (const name of names) {
    for (const match of code.matchAll(new RegExp(String.raw`(?:(?<=\.\.\.)|(?<![\w.$'"\`/-]))${name}(?![\w$'"\`/-])`, 'g'))) {
      const [before, after] = [code.slice(0, match.index), code.slice(match.index + name.length)];
      if (/^\s*\??\.\s*(?:site|apps)\b/.test(after)) continue;
      if (/\b(?:const|let|var)\s+$/.test(before) && /^\s*=\s*(?:await\s+)?(?:loadAppsRegistry|parseAppsRegistry)\(/.test(after)) continue;
      if (/(?:function\s*\w*\s*\([^()]*|\(\s*(?:\w+\s*,\s*)*)$/.test(before) && /^[^()]*\)\s*(?:=>|\{)/.test(after)) continue;
      if (/^\s*=>/.test(after) && /[(,\s]$/.test(before)) continue;
      if (/\}\s*=\s*(?:await\s+)?$/.test(before)) {
        const end = before.trimEnd().replace(/=\s*(?:await\s+)?$/, '').trimEnd().length - 1;
        const pattern = code.slice(openingBrace(code, end), end + 1);
        if (/\bsite\b|\.\.\.|\[/.test(pattern)) unknown.push(`destructures ${pattern.replace(/\s+/g, ' ')} from ${name}`);
        continue;
      }
      const callee = /[(,]\s*$/.test(before) && /^\s*[,)]/.test(after) && calleeOf(code, match.index);
      if (callee && (callees.has(callee) || Object.hasOwn(SITE_HELPERS, callee))) continue;
      unknown.push(`${name}${after.slice(0, 20).split('\n')[0]} (${callee ? `passed to ${callee}` : 'used'})`);
    }
  }
  return unknown;
}
// The index of the `{` that opens the brace closing at `end`.
function openingBrace(text, end) {
  let depth = 0;
  for (let index = end; index >= 0; index--) {
    if (text[index] === '}') depth++;
    if (text[index] === '{' && --depth === 0) return index;
  }
  return 0;
}
// The function whose argument list holds `index`: the name before the unclosed `(`.
function calleeOf(text, index) {
  let depth = 0;
  for (let at = index - 1; at >= 0; at--) {
    if (')]}'.includes(text[at])) depth++;
    else if ('([{'.includes(text[at])) {
      if (depth === 0) return text[at] === '(' ? text.slice(0, at).match(/([\w$.]+)\s*$/)?.[1]?.split('.').pop() : null;
      depth--;
    }
  }
  return null;
}

function siteKeysRead(text, callees = new Set()) {
  const read = new Set();
  if (registryUses(text, callees).length) return new Set(SITE_KEYS);
  const add = (keys) => keys.forEach((key) => read.add(key));
  const entryReads = (param, body, entry) => {
    for (const [, chain] of body.matchAll(new RegExp(String.raw`\b${param}\b((?:\??\.\w+)*)`, 'g'))) add(keysBelow(walkSiteKeys(entry, chainNames(chain)).path));
  };
  for (const match of text.matchAll(/\.site\b((?:\??\.\w+)*)/g)) {
    const { path, stopped } = walkSiteKeys('site', chainNames(match[1]));
    const after = match.index + match[0].length;
    const callback = stopped && SITE_LISTS.has(path) && text[after] === '('
      && text.slice(after + 1, closing(text, after)).match(/^\s*(?:\(\s*)?(\w+)\s*\)?\s*=>([\s\S]*)$/);
    if (callback) entryReads(callback[1], callback[2], `${path}[]`);
    else if (stopped && !SITE_LISTS.has(path) && !/^(?:map|find|filter|some|every|flatMap|forEach|findIndex|length)$/.test(stopped)) read.add(`${path}.${stopped}`);
    else add(keysBelow(path));
  }
  // `{ site } = registry`, `({ site }) =>` and `registry['site']` hand the whole section on.
  if (/\{[^{}]*\bsite\b[^{}]*\}\s*(?:=[^=>]|\)\s*=>)|\[\s*['"`]site['"`]\s*\]/.test(text)) add(SITE_KEYS);
  for (const match of text.matchAll(new RegExp(String.raw`\b(${Object.keys(SITE_HELPERS).join('|')})\(`, 'g'))) {
    if (/function\s+$/.test(text.slice(0, match.index))) continue;
    const helper = SITE_HELPERS[match[1]];
    add(helper.reads);
    if (!helper.entry) continue;
    const chain = text.slice(closing(text, match.index + match[0].length - 1) + 1).match(/^(?:\??\.\w+)+/)?.[0];
    const destructured = text.slice(0, match.index).match(/\{([\w\s,]*)\}\s*=\s*(?:await\s+)?$/)?.[1];
    if (chain) add(keysBelow(walkSiteKeys('site.catalogs[]', chainNames(chain)).path));
    else if (destructured) for (const name of destructured.split(',').map((name) => name.trim()).filter(Boolean)) add(keysBelow(`site.catalogs[].${name}`));
    else add(keysBelow('site.catalogs[]'));
  }
  return read;
}

test('the site key reader check finds the keys a text reads, and every key of what it hands on', () => {
  const reads = (text) => [...siteKeysRead(text)].sort();
  assert.deepEqual(reads('measurementId: registry.site.analytics.measurement_id,\nhost: registry.site.hub.host'), ['site.analytics.measurement_id', 'site.hub.host']);
  assert.deepEqual(reads('registry?.site?.hub?.brand?.home'), ['site.hub.brand.home']);
  assert.deepEqual(reads('const ids = registry.site.catalogs.map(catalog => catalog.id);'), ['site.catalogs[].id']);
  assert.deepEqual(reads('const { desktop } = findCatalog(registry, id);'), ['site.catalogs[].id', ...keysBelow('site.catalogs[].desktop')].sort());
  assert.deepEqual(reads('primaryCatalog(registry).id'), ['site.catalogs[].host', 'site.catalogs[].id', 'site.domain']);
  assert.deepEqual(reads('registry.site.hub.unclassified'), ['site.hub.unclassified']);
  for (const whole of ['render(registry.site)', 'const copy = { ...registry.site.hub };', 'for (const key of Object.keys(registry.site.catalogs[0])) {}', "registry['site']", 'const { site } = registry;', 'export default ({ site }) => site;']) {
    const keys = reads(whole);
    assert.ok(keys.length > 1 && keys.every((key) => key.startsWith('site.')), whole);
  }
  assert.ok(reads('const catalog = findCatalog(registry, id); use(catalog);').length > 10, 'a whole catalogue entry');
  assert.deepEqual(reads('const site = await serveSite(dist); await page.goto(site.origin);'), []);
  // Any use of the registry object the check does not recognise reads every key (S6).
  const known = new Set(['findApp']);
  const everything = (text) => siteKeysRead(text, known).size === SITE_KEYS.length;
  for (const text of [
    'const { site: { hub: { host } } } = registry;',
    'const { apps, ...rest } = registry;',
    'const { site: { analytics } } = await loadAppsRegistry();',
    'const copy = { ...registry };',
    'writeFile(out, JSON.stringify(registry));',
    'const value = registry[key];',
    'const value = registry?.[key];',
    "const key = 'site'; const { [key]: section } = registry; const host = section.hub.host;",
    "const { [`si${'te'}`]: section } = await loadAppsRegistry();",
    "const section = (await loadAppsRegistry())[key];",
    'const section = parseAppsRegistry(text)[key];',
    "const section = parseAppsRegistry(readFileSync(path, 'utf8'))[key];",
    "const section = (await loadAppsRegistry(join(root, 'registry'))) [key];",
    'return registry;',
    'unknownHelper(registry, id);',
  ]) assert.ok(everything(text), text);
  for (const text of ['const registry = await loadAppsRegistry(); const app = findApp(registry, id);', 'const { apps } = registry;', 'export function f(registry, id) { return registry.apps.length; }', 'const ids = registry.apps.map((app) => app.id);', "test('reads the registry beside itself', () => {});"]) {
    assert.deepEqual([...siteKeysRead(text, known)], [], text);
  }
});

test('every file an app build or app test runs that loads the registry has its site keys routed', async () => {
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  const reached = new Set([...registry.apps.flatMap((app) => [...reachableFrom(workspace, `apps/${app.id}`)]), ...reachableFrom(workspace, CATALOG)]);
  // A package's files are run where its node, or its tests' node, is reached.
  const runs = (file) => file.startsWith('apps/') || reached.has(file) || reached.has(file.match(/^(?:packages|exes)\/[^/]+(?:\/tests?(?=\/))?/)?.[0]);
  const helpers = Object.keys(SITE_HELPERS).join('|');
  for (const file of filesNaming(String.raw`apps-registry|loadAppsRegistry|parseAppsRegistry|apps\.yml|\.site\b|\b(${helpers})\(`)) {
    if (file.startsWith('registry/') || !runs(file)) continue;
    assert.ok(SITE_SECTION_READERS.has(file), `${file} loads the registry or reads its site section; add it to SITE_SECTION_READERS and route the keys it reads in SITE_KEY_READERS`);
  }
  // Functions a reader may hand the registry to: those the listed readers define (their text is checked
  // here too) and the loader's, whose site reads are only the SITE_HELPERS (checked below).
  const callees = new Set();
  for (const file of SITE_SECTION_READERS) {
    for (const [, name] of (await readFile(join(repoRoot, file), 'utf8')).matchAll(/\bfunction\s+(\w+)\s*\(/g)) callees.add(name);
  }
  const readsOf = new Map();
  for (const file of SITE_SECTION_READERS) {
    assert.ok(runs(file), `${file} is no longer reached by an app; drop it`);
    if (file === REGISTRY_LOADER) continue;
    readsOf.set(file, siteKeysRead(await readFile(join(repoRoot, file), 'utf8'), callees));
    for (const key of readsOf.get(file)) {
      assert.ok(SITE_KEY_READERS[key]?.includes(file), `${file} reads ${key}; list it in SITE_KEY_READERS['${key}']`);
    }
  }
  // A listed reader reads the key, so the table selects no more than it must.
  for (const [key, readers] of Object.entries(SITE_KEY_READERS)) {
    for (const reader of readers) assert.ok(readsOf.get(reader)?.has(key), `SITE_KEY_READERS lists ${reader} for ${key}, but its text does not read it`);
  }
  // The loader's own functions that read the site section are the helpers the check knows.
  for (const file of [REGISTRY_LOADER, 'scripts/desktop/suite.mjs']) {
    const text = await readFile(join(repoRoot, file), 'utf8');
    for (const [, name, body] of text.matchAll(/^export (?:async )?function (\w+)\(([\s\S]*?)^}/gm)) {
      if (/\.site\b/.test(body) && !['loadAppsRegistry', 'parseAppsRegistry'].includes(name)) assert.ok(Object.hasOwn(SITE_HELPERS, name), `${file} ${name} reads the site section for its caller; add it to SITE_HELPERS`);
    }
  }
  // The files that read a key only for the site build are not run by any app.
  for (const reader of ['scripts/build-site.mjs', 'scripts/lib/landing-page.mjs', 'scripts/lib/hub-page.mjs', 'scripts/lib/catalog-sites.mjs', 'scripts/lib/not-found-page.mjs', 'scripts/write-analytics.mjs']) {
    assert.ok(!reached.has(reader), `${reader} is run by an app build or test; route the site keys it reads`);
  }
  // A reader added to a listed file is found: theme-app-dist.mjs reading the hub's host.
  const themed = `${await readFile(join(repoRoot, 'scripts/theme-app-dist.mjs'), 'utf8')}\nconst hub = registry.site.hub.host;\n`;
  assert.ok(siteKeysRead(themed, callees).has('site.hub.host') && !SITE_KEY_READERS['site.hub.host'].includes('scripts/theme-app-dist.mjs'));
  // So is nested destructuring the check cannot follow: it counts as reading every key.
  const nested = `${await readFile(join(repoRoot, 'scripts/theme-app-dist.mjs'), 'utf8')}\nconst { site: { hub: { host } } } = registry;\n`;
  assert.equal(siteKeysRead(nested, callees).size, SITE_KEYS.length);
});

test('an offline asset lock change selects the apps whose assets changed', async () => {
  const registry = await loadAppsRegistry();
  const before = { schemaVersion: 1, assets: { u1: { sha256: 'a' }, u2: { sha256: 'b' } }, apps: { lcmodel: ['u1'], zarro: ['u2'] } };
  const after = { ...before, assets: { ...before.assets, u1: { sha256: 'c' } } };
  const plan = createAppPlan(registry, ['registry/offline-assets.lock.json'], await graph, new Map([['registry/offline-assets.lock.json', manifest(before, after)]]));
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(plan.site, true);
  assert.equal(plan.siteCode, false);
});

test('a root-relative path joined onto a computed repository root selects its app', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['exes/compute-server/src/tools/sct.rs'], await graph);
  assert.ok(plan.selected.some((app) => app.id === 'spinalcordtoolbox'), 'SCT test:release reads the pinned image from sct.rs');
});

test('ci.yml runs the composite site build on pull requests that need it', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  assert.equal(ci.jobs['composite-site'].if, "(github.event_name != 'pull_request' || !github.event.pull_request.draft) && (github.event_name == 'push' || github.event_name == 'schedule' || needs.app-plan.outputs.has_site == 'true')");
  assert.equal(ci.jobs['app-plan'].outputs.has_site, '${{ steps.plan.outputs.has_site }}');
});

// A plan for a ci.yml edit, compared job by job with the repository's own workflow.
async function workflowPlan(edit, options) {
  const text = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const after = parse(text);
  edit(after);
  return createAppPlan(await loadAppsRegistry(), ['.github/workflows/ci.yml'], await graph, new Map([['.github/workflows/ci.yml', { before: text, after: stringify(after) }]]), options);
}

test('a ci.yml change confined to the composite site jobs selects only the site build, and its checks cover every app', async () => {
  // PR #864 changed only the interface audit step, which site-audit now runs.
  const audit = await workflowPlan((ci) => {
    ci.jobs['site-audit'].steps.find((step) => step.name === 'Audit interface consistency across the catalog').env.EXAMPLE_ASSET_REFUSE_OTHER_HOSTS = '1';
  });
  assert.deepEqual(audit.selected, []);
  assert.equal(audit.site, true);
  // It changes code the site jobs run, so the per-app site checks cover every app.
  assert.equal(audit.siteCode, true);
  assert.equal(audit.reasons.fallback, null);
  assert.deepEqual(audit.reasons.site, ['.github/workflows/ci.yml: its site-audit job changed, and it tests only the composite site']);
  // A pull request that edits ci.yml runs the easter egg: .github/ is not a tree it cannot read.
  assert.deepEqual(audit.easterEgg, ['.github/workflows/ci.yml: outside the trees the job cannot read']);
  for (const job of Object.keys(CI_JOB_SCOPES).filter((id) => CI_JOB_SCOPES[id] === 'site')) {
    const plan = await workflowPlan((ci) => {
      ci.jobs[job]['timeout-minutes'] = 7;
    });
    assert.deepEqual(plan.selected, [], job);
    assert.equal(plan.site, true, job);
    assert.equal(plan.siteCode, true, job);
  }
  // A comment or a reordered mapping changes no job.
  const text = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const comment = createAppPlan(await loadAppsRegistry(), ['.github/workflows/ci.yml'], await graph, new Map([['.github/workflows/ci.yml', { before: text, after: `${text}# a note\n` }]]));
  assert.deepEqual(comment.selected, []);
  assert.equal(comment.site, false);
});

test('a ci.yml change to a job that tests no app selects that job and no app', async () => {
  // workspace-contracts runs on every run, so its own run tests the change.
  const contracts = await workflowPlan((ci) => {
    ci.jobs['workspace-contracts'].steps.at(-1).name = 'Lint every workspace';
  });
  assert.deepEqual(contracts.selected, []);
  assert.equal(contracts.site, false);
  assert.equal(contracts.reasons.fallback, null);
  assert.deepEqual(contracts.easterEgg, ['.github/workflows/ci.yml: outside the trees the job cannot read']);
  const egg = await workflowPlan((ci) => {
    ci.jobs['homepage-easter-egg'].steps.push({ run: 'echo again' });
  });
  assert.deepEqual(egg.selected, []);
  assert.equal(egg.site, false);
  assert.deepEqual(egg.easterEgg, ['.github/workflows/ci.yml: outside the trees the job cannot read']);
  for (const job of ['full-plan', 'full-plan-withheld']) {
    const plan = await workflowPlan((ci) => {
      ci.jobs[job].steps[0].name = 'Renamed';
    });
    assert.deepEqual(plan.selected, [], job);
    assert.equal(plan.site, false, job);
  }
});

test('a ci.yml change the job comparison cannot place selects every app with a reason', async () => {
  const cases = {
    'app-tests': (ci) => ci.jobs['app-tests'].steps.push({ run: 'echo' }),
    'browser-e2e': (ci) => { ci.jobs['browser-e2e']['timeout-minutes'] = 9; },
    'browser-e2e-gpu': (ci) => { ci.jobs['browser-e2e-gpu']['timeout-minutes'] = 9; },
    'app-plan': (ci) => ci.jobs['app-plan'].steps.push({ run: 'echo' }),
    'a new job': (ci) => { ci.jobs['new-check'] = { 'runs-on': 'ubuntu-latest', steps: [{ run: 'echo' }] }; },
    on: (ci) => { ci.on.schedule[0].cron = '0 4 * * *'; },
    env: (ci) => { ci.env.EXTRA = '1'; },
    concurrency: (ci) => { ci.concurrency['cancel-in-progress'] = true; },
    permissions: (ci) => { ci.permissions.actions = 'read'; },
    defaults: (ci) => { ci.defaults = { run: { shell: 'bash' } }; },
  };
  for (const [label, edit] of Object.entries(cases)) {
    const plan = await workflowPlan(edit);
    assert.equal(plan.allApps, true, label);
    assert.match(plan.reasons.fallback, /^\.github\/workflows\/ci\.yml: its \S+ (?:job|key) (?:changed|was added)/, label);
    assert.ok(plan.easterEgg.length, label);
  }
  const registry = await loadAppsRegistry();
  const text = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  for (const [label, before, reason] of [['unparseable', 'jobs: [', /does not parse/], ['no jobs', 'name: ci\n', /has no jobs to compare/]]) {
    const plan = createAppPlan(registry, ['.github/workflows/ci.yml'], await graph, new Map([['.github/workflows/ci.yml', { before, after: text }]]));
    assert.equal(plan.allApps, true, label);
    assert.match(plan.reasons.fallback, reason, label);
  }
  // Without the base text there is nothing to compare.
  assert.equal(createAppPlan(registry, ['.github/workflows/ci.yml'], await graph).reasons.fallback, '.github/workflows/ci.yml: the base or head workflow is unavailable');
});

test('a ci.yml change narrows only within the same jobs and their own scope', async () => {
  const registry = await loadAppsRegistry();
  const text = await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8');
  const plan = (editBase, editHead) => {
    const [before, after] = [parse(text), parse(text)];
    editBase(before);
    editHead(after);
    return graph.then((workspace) => createAppPlan(registry, ['.github/workflows/ci.yml'], workspace, new Map([['.github/workflows/ci.yml', { before: stringify(before), after: stringify(after) }]])));
  };
  const none = () => {};
  // Deleting the job that runs the contract tests removes the test that would catch it.
  const deleted = await plan(none, (ci) => { delete ci.jobs['workspace-contracts']; });
  assert.equal(deleted.allApps, true);
  assert.equal(deleted.reasons.fallback, '.github/workflows/ci.yml: its workspace-contracts job was removed, and only a change within the same jobs narrows');
  assert.ok(deleted.easterEgg.length);
  // app-tests consumes an output of workspace-contracts: changing it changes what every app job sees.
  const consumed = (value) => (ci) => {
    ci.jobs['app-tests'].needs = ['app-plan', 'workspace-contracts'];
    ci.jobs['workspace-contracts'].outputs = { fixtures: value };
  };
  const output = await plan(consumed('a'), consumed('b'));
  assert.equal(output.allApps, true);
  assert.equal(output.reasons.fallback, '.github/workflows/ci.yml: its workspace-contracts job changed, and at the base app-tests needs it, which tests more than the every-run scope');
  // A narrowed job that comes to need a per-app job is skipped whenever the plan skips that job.
  const needing = await plan(none, (ci) => { ci.jobs['workspace-contracts'].needs = ['app-plan', 'app-tests']; });
  assert.equal(needing.reasons.fallback, '.github/workflows/ci.yml: its workspace-contracts job changed, and at the head it needs app-tests, which tests more than the every-run scope');
  // The site jobs need composite-site, which has their scope, so a change to it still narrows.
  const site = await plan(none, (ci) => { ci.jobs['composite-site']['timeout-minutes'] = 61; });
  assert.deepEqual(site.selected, []);
  assert.equal(site.reasons.fallback, null);
});

test('the jobs a ci.yml change can narrow to test what CI_JOB_SCOPES says', async () => {
  const ci = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  for (const [job, scope] of Object.entries(CI_JOB_SCOPES)) {
    assert.ok(ci.jobs[job], `${job} is not a ci.yml job`);
    assert.ok(!CATALOG_JOBS.includes(job) && job !== 'app-plan', `${job} tests apps`);
    assert.ok(!JSON.stringify(ci.jobs[job]).includes('matrix.app'), `${job} runs per app`);
    // The site jobs are the composite build and jobs that only consume it, directly or through other site jobs.
    if (scope === 'site' && job !== 'composite-site') {
      const needs = [ci.jobs[job].needs].flat();
      assert.ok(needs.length && needs.every((need) => CI_JOB_SCOPES[need] === 'site'), `${job} needs more than the composite site: ${needs.join(', ')}`);
    }
  }
  // The plan decides the easter egg on a pull request only, and package-tests on drafts only;
  // workspace-contracts runs on every run, and package-tests runs on every ready PR, push, nightly and dispatch.
  assert.equal(ci.jobs['homepage-easter-egg'].needs, 'app-plan');
  assert.match(ci.jobs['homepage-easter-egg'].if, new RegExp(String.raw`\(github\.event_name != 'pull_request' \|\| needs\.app-plan\.result != 'success' \|\| needs\.app-plan\.outputs\.easter_egg != '${EASTER_EGG_OUTPUT.skip}'\) \}\}$`));
  assert.equal(ci.jobs['app-plan'].outputs.easter_egg, '${{ steps.plan.outputs.easter_egg }}');
  assert.equal(ci.jobs['app-plan'].outputs.package_tests, '${{ steps.plan.outputs.package_tests }}');
  assert.equal(ci.jobs['workspace-contracts'].needs, undefined);
  for (const step of ci.jobs['workspace-contracts'].steps.filter((step) => step.run)) assert.equal(step.if, step.run === 'pnpm lint:correctness' ? "${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}" : undefined, step.run);
  assert.equal(ci.jobs['package-tests'].needs, 'app-plan');
  assert.ok(ci.jobs['package-tests'].steps.some((step) => step.run === 'pnpm test:packages'));
});

test('a draft pull request skips package-tests only when every changed path lies in a doc, changeset or easter-egg tree', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const pkgs = (paths, options) => createAppPlan(registry, paths, workspace, new Map(), options).packageTests;
  for (const path of ['docs/quality/ci-development-tiers.md', '.changeset/brave-owls.md', 'README.md', 'site/easter-eggs/vessel-surfer/src/main.js']) {
    assert.equal(packageTestsCanSkipOnDraft(path), true, path);
    assert.deepEqual(pkgs([path], { draft: true }), [], path);
  }
  for (const path of ['apps/niimath/main.js', 'apps/browserqc/src/models.json', 'apps/surfannotate/automation.json', 'packages/components/src/ui/index.js', 'exes/nii2tvx/src/main.c', 'apps/niimath/package.json', 'package.json', 'pnpm-lock.yaml', 'scripts/app-plan.mjs', '.github/workflows/ci.yml']) {
    assert.equal(packageTestsCanSkipOnDraft(path), false, path);
    assert.ok(pkgs([path], { draft: true }).length > 0, path);
  }
  assert.ok(pkgs([], { draft: true }).length > 0, 'empty diff fails open');
});

test('a pull request skips the homepage easter egg only when every changed path lies in a tree it cannot read', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const egg = (paths, options) => createAppPlan(registry, paths, workspace, new Map(), options).easterEgg;
  // The skip trees: apps, native executables, model manifests, documentation and the packages outside its closure.
  for (const path of ['apps/niimath/main.js', 'apps/lcmodel/e2e/smoke.spec.js', 'exes/greedy/core/src/lib.rs', 'models/lcmodel.manifest.json', 'docs/quality/ci-development-tiers.md', 'packages/greedy/src/index.js', 'packages/components/src/ui/index.js', 'packages/runtime-support/vendor/freebrowse/dist/index.js']) {
    assert.equal(easterEggCannotRead(path), true, path);
    assert.deepEqual(egg([path]), [], path);
  }
  assert.deepEqual(egg(['apps/niimath/main.js', 'docs/x.md', 'packages/lcmodel/src/a.js', 'exes/synthsr/Makefile', 'models/synthsr.manifest.json']), []);
  assert.deepEqual(egg(['apps/niimath/main.js'], { draft: true }), []);
  // Anything else runs it: root files, .github/, scripts/, test-utils/, test/, registry/, site/, templates/, the
  // lockfile and workspace files, the packages its commands reach, a package.json anywhere and a path no rule knows.
  for (const path of ['README.md', 'AGENTS.md', '.npmrc', '.gitattributes', 'eslint.config.js', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', '.github/workflows/standalone.yml', '.github/workflows/ci.yml', 'scripts/lint.mjs', 'scripts/lib/landing-page.mjs', 'test-utils/test-durations-reporter.mjs', 'test-utils/dice.mjs', 'test/app-plan.test.mjs', 'registry/apps.yml', 'registry/app-information.yml', 'site/landing.js', 'site/easter-eggs/vessel-surfer/src/main.js', 'templates/app-template/index.html', 'packages/analytics/src/index.js', 'packages/analytics/test/report.test.js', 'packages/README.md', 'apps/niimath/package.json', 'packages/greedy/package.json', 'packages/runtime-support/vendor/freebrowse/package.json', '.changeset/brave-owls.md', 'an-unknown-directory/file.js']) {
    assert.equal(easterEggCannotRead(path), false, path);
    assert.deepEqual(egg([path]), [`${path}: outside the trees the job cannot read`], path);
  }
  // S11: pnpm reads package.json, package.json5 and package.yaml as a workspace project's manifest, and a
  // second one beside package.json as a second project, which can take the easter egg's name. Each runs it.
  assert.deepEqual(WORKSPACE_MANIFESTS, ['package.json', 'package.json5', 'package.yaml']);
  for (const name of WORKSPACE_MANIFESTS) {
    for (const path of [`apps/probe/${name}`, `apps/niimath/${name}`, `packages/greedy/${name}`, `exes/greedy/${name}`, `docs/${name}`, name]) {
      assert.equal(easterEggCannotRead(path), false, path);
      assert.deepEqual(egg([path]), [`${path}: outside the trees the job cannot read`], path);
    }
    // The reviewer's case: a pull request that adds only apps/probe/package.yaml. A new app directory selects every app, as on main.
    const probe = createAppPlan(registry, [`apps/probe/${name}`], workspace);
    assert.equal(probe.allApps, true, name);
    assert.equal(probe.reasons.fallback, `apps/probe/${name}: no rule classifies it`);
  }
  for (const path of ['apps/niimath/package.json.orig', 'apps/niimath/my-package.yaml', 'apps/niimath/src/package.yaml.md']) assert.equal(easterEggCannotRead(path), true, path);
  // One such path is enough, and the reasons stay short.
  assert.deepEqual(egg(['apps/niimath/main.js', 'scripts/lint.mjs']), ['scripts/lint.mjs: outside the trees the job cannot read']);
  assert.equal(egg(Array.from({ length: 9 }, (_, index) => `scripts/s${index}.mjs`)).at(-1), 'and 4 more');
  // No changed paths (no base, an unreadable diff or a full run) runs it.
  assert.match(egg([])[0], /^no changed paths/);
  // It needs no workspace graph and no manifests.
  assert.deepEqual(createAppPlan(registry, ['apps/niimath/main.js'], null).easterEgg, []);
});

// S10: Playwright loads the reporter ci.yml names in PW_TEST_REPORTER in every run, the easter egg's included.
test('a change to the Playwright reporter ci.yml names runs the easter egg, as does any file its environment names', async () => {
  const plan = createAppPlan(await loadAppsRegistry(), ['test-utils/test-durations-reporter.mjs'], await graph);
  assert.deepEqual(plan.easterEgg, ['test-utils/test-durations-reporter.mjs: outside the trees the job cannot read']);
  // The files named in the environment the job sees: the workflow's, its own and its steps'.
  const ci = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  const job = ci.jobs[EASTER_EGG_JOB];
  const values = [ci.env, job.env, ...job.steps.map((step) => step.env)].flatMap((env) => Object.values(env ?? {})).map(String);
  const named = values.flatMap((value) => [...value.matchAll(/(?:\$\{\{\s*github\.workspace\s*\}\}\/|^)((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z]\w*)$/g)].map((match) => match[1]));
  assert.ok(named.includes('test-utils/test-durations-reporter.mjs'), 'the reporter is still named');
  for (const file of named) {
    assert.equal(easterEggCannotRead(file), false, `${file} is named in the easter egg's environment but lies in a skip tree`);
    assert.ok(EASTER_EGG_INPUTS.includes(file), `${file} is named in the easter egg's environment; add it to EASTER_EGG_INPUTS`);
  }
});

test("the easter egg's input table holds every file its job reads", async () => {
  const ci = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  // The job's commands. A new one needs its inputs in EASTER_EGG_INPUTS before this list changes.
  assert.deepEqual(ci.jobs[EASTER_EGG_JOB].steps.filter((step) => step.run).map((step) => step.run), [
    'pnpm install --frozen-lockfile',
    'node node_modules/@playwright/test/cli.js install --with-deps chromium',
    'node --test test/easter-egg.test.mjs',
    'pnpm --filter @neurodesk/vessel-surfer-easter-egg test',
    'pnpm --filter @neurodesk/vessel-surfer-leaderboard test',
    'pnpm --filter @neurodesk/vessel-surfer-easter-egg test:e2e',
  ]);
  // The package scripts those commands run, and the e2e server's (pnpm build && pnpm preview).
  const scripts = async (dir) => JSON.parse(await readFile(join(repoRoot, dir, 'package.json'), 'utf8')).scripts;
  const surfer = await scripts('site/easter-eggs/vessel-surfer');
  assert.deepEqual([surfer.test, surfer['test:e2e'], surfer.build, surfer.preview], ['node scripts/fetch-data.mjs && node --test test/*.test.js', 'playwright test', 'node scripts/fetch-data.mjs && vite build && node scripts/finish-build.mjs', 'node scripts/preview-site.mjs']);
  assert.equal((await scripts('site/easter-eggs/vessel-surfer-leaderboard')).test, 'node --test test/*.test.js');
  assert.match(await readFile(join(repoRoot, 'site/easter-eggs/vessel-surfer/playwright.config.js'), 'utf8'), /command:\s*"pnpm build && pnpm preview --host 127\.0\.0\.1 --port 4178 --strictPort"/);
  // Neither package depends on a workspace package; npm packages come from the lockfile.
  for (const dir of ['site/easter-eggs/vessel-surfer', 'site/easter-eggs/vessel-surfer-leaderboard']) {
    const manifest = JSON.parse(await readFile(join(repoRoot, dir, 'package.json'), 'utf8'));
    for (const spec of Object.values({ ...manifest.dependencies, ...manifest.devDependencies })) assert.ok(!/^(?:workspace|link|file):/.test(spec), `${dir} depends on ${spec}`);
  }
  // The table is the evidence for the skip list: no input lies in a tree the plan skips it for.
  for (const input of EASTER_EGG_INPUTS) assert.equal(easterEggCannotRead(input.endsWith('/') ? `${input}file.js` : input), false, `${input} is read by the easter egg but lies in a skip tree`);
  assert.deepEqual(EASTER_EGG_PACKAGES, [...new Set(EASTER_EGG_INPUTS.map((input) => input.match(/^packages\/[^/]+/)?.[0]).filter(Boolean))]);
  // Every file the job's code imports, and every path it builds on a URL, is in the table: the
  // test file, the inputs' modules and every source file of the easter-egg packages.
  const inTable = (path) => EASTER_EGG_INPUTS.some((input) => (input.endsWith('/') ? path.startsWith(input) : path === input));
  const sources = async (dir) => (await readdir(join(repoRoot, dir), { recursive: true, withFileTypes: true }))
    // eslint.config.js is lint configuration; the job runs no lint.
    .filter((entry) => entry.isFile() && /\.(?:m?js|cjs|ts)$/.test(entry.name) && entry.name !== 'eslint.config.js' && !/(?:^|\/)(?:node_modules|dist|public|\.wrangler)(?:\/|$)/.test(relativePath(repoRoot, entry.parentPath)))
    .map((entry) => relativePath(repoRoot, join(entry.parentPath, entry.name)));
  const eggSources = [...await sources('site/easter-eggs/vessel-surfer'), ...await sources('site/easter-eggs/vessel-surfer-leaderboard')];
  assert.ok(eggSources.includes('site/easter-eggs/vessel-surfer/scripts/preview-site.mjs') && eggSources.includes('site/easter-eggs/vessel-surfer/playwright.config.js'));
  const pending = ['test/easter-egg.test.mjs', ...eggSources, ...EASTER_EGG_INPUTS.filter((input) => /\.m?js$/.test(input))];
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const text = await readFile(join(repoRoot, file), 'utf8');
    for (const [, specifier] of text.matchAll(/(?:\bfrom|\bimport\s*\()\s*["'`]([^"'`]+)["'`]/g)) {
      if (!specifier.startsWith('.')) continue;
      const target = relativePath(repoRoot, resolvePath(repoRoot, dirname(file), specifier));
      assert.ok(inTable(target), `${file} imports ${target}; add it to EASTER_EGG_INPUTS`);
      pending.push(target);
    }
    // URLs built on the file's own location or on a URL named from it (`const root = new URL('../', import.meta.url)`).
    const bases = new Map([['import.meta.url', `${dirname(file)}/`]]);
    for (const [, name, literal, base] of text.matchAll(/(?:const\s+(\w+)\s*=\s*)?new URL\(\s*["'`]([^"'`$]*)[^"'`]*["'`]\s*,\s*([\w.]+)\s*\)/g)) {
      assert.ok(bases.has(base), `${file} builds a URL on ${base}, which this test cannot follow; list what it reads in EASTER_EGG_INPUTS and here`);
      const target = `${relativePath(repoRoot, resolvePath(repoRoot, bases.get(base), literal))}${literal.endsWith('/') || !literal ? '/' : ''}`.replace(/^\/$/, '');
      if (name) bases.set(name, target || '.');
      // The repository root itself is a base, not a read.
      if (target) assert.ok(inTable(target), `${file} reads ${target}; add it to EASTER_EGG_INPUTS`);
    }
  }
  assert.ok(seen.has('scripts/lib/landing-page.mjs') && seen.has('scripts/lib/apps-registry.mjs'));
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
  assert.equal(plan.site_code, 'false');
});

test('the app-plan CLI runs the easter egg on every push, nightly and dispatch, and on a pull request as its plan says', async (t) => {
  const { root } = await plannerFixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const commit = async (path) => {
    await mkdir(join(root, dirname(path)), { recursive: true });
    await writeFile(join(root, path), path);
    git('add', '-A');
    git('commit', '--quiet', '-m', path);
    return git('rev-parse', 'HEAD');
  };
  const docs = await commit('docs/notes.md');
  const reporter = await commit('test-utils/test-durations-reporter.mjs');
  const plan = (head, event, ...args) => {
    const env = { ...process.env, GITHUB_OUTPUT: '', GITHUB_EVENT_NAME: event };
    for (const name of ['GITHUB_EVENT_PATH', 'CI_DRAFT']) delete env[name];
    const output = JSON.parse(execFileSync(process.execPath, ['scripts/app-plan.mjs', '--base', base, '--head', head, ...args], { cwd: root, encoding: 'utf8', env, stdio: ['ignore', 'pipe', 'pipe'] }));
    return { ...output, reasons: JSON.parse(output.selection_reasons) };
  };
  // A docs-only pull request skips it; the same change pushed, scheduled or dispatched runs it.
  const pull = plan(docs, 'pull_request');
  assert.equal(pull.easter_egg, EASTER_EGG_OUTPUT.skip);
  assert.deepEqual(pull.reasons.easter_egg, []);
  for (const event of ['push', 'schedule', 'workflow_dispatch']) assert.equal(plan(docs, event).easter_egg, EASTER_EGG_OUTPUT.run, event);
  // A pull request that also edits the reporter (S10) runs it.
  const both = plan(reporter, 'pull_request');
  assert.equal(both.easter_egg, EASTER_EGG_OUTPUT.run);
  assert.deepEqual(both.reasons.easter_egg, ['test-utils/test-durations-reporter.mjs: outside the trees the job cannot read']);
  // A site dispatch runs it whatever changed; a gpu dispatch never does.
  assert.equal(plan(docs, 'workflow_dispatch', '--scope', 'site').easter_egg, EASTER_EGG_OUTPUT.run);
  assert.equal(plan(reporter, 'workflow_dispatch', '--scope', 'gpu').easter_egg, EASTER_EGG_OUTPUT.skip);
  // workspace-contracts tests every package on every run; the plan lists none.
  for (const output of ['packages', 'all_packages', 'has_packages']) assert.equal(pull[output], undefined, output);
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

test('executable comment-like lines retain their app consumer', async (t) => {
  const registry = await loadAppsRegistry();
  for (const name of ['block-close', 'template-continuation', 'multiline-template', 'continued-string']) {
    await t.test(name, async (t) => {
      const root = await mkdtemp(join(tmpdir(), 'app-plan-executable-comment-'));
      t.after(() => rm(root, { recursive: true, force: true }));
      for (const directory of ['apps/lcmodel', 'scripts/lib', 'packages/runtime', '.github/workflows']) {
        await mkdir(join(root, directory), { recursive: true });
      }
      await writeFile(join(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {} }));
      await writeFile(join(root, '.github/workflows/ci.yml'), JSON.stringify({ jobs: Object.fromEntries(['composite-site', ...CATALOG_JOBS].map((name) => [name, { steps: [{ run: 'echo fixture' }] }])) }));
      await writeFile(join(root, 'apps/lcmodel/main.js'), "import '../../scripts/lib/entry.mjs';\n");
      await writeFile(join(root, 'packages/runtime/index.mjs'), 'export const value = 356;\n');
      const sources = {
        'block-close': '/* block comment\n// */ export { value } from "../../packages/runtime/index.mjs";\n',
        'template-continuation': 'export const loaded = await import(`\\\n//${new URL("../../", import.meta.url).pathname}packages/runtime/index.mjs`);\n',
        'multiline-template': 'export const loaded = await import(`\n//${new URL("../../", import.meta.url).pathname}packages/runtime/index.mjs\n`.trim());\n',
        'continued-string': "export const loaded = await import('\\\n//../../packages/runtime/index.mjs'.slice(2));\n",
      };
      const entry = join(root, 'scripts/lib/entry.mjs');
      await writeFile(entry, sources[name]);
      const loaded = await import(pathToFileURL(entry));
      assert.equal(loaded.loaded?.value ?? loaded.value, 356);
      const graph = await loadConservativeWorkspaceGraph(root);
      const plan = createAppPlan(registry, ['packages/runtime/index.mjs'], graph);
      assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
    });
  }
});

test('unparsed root source retains uncertain comment references', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-unparsed-comment-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const directory of ['apps/lcmodel', 'scripts', 'packages/runtime', '.github/workflows']) {
    await mkdir(join(root, directory), { recursive: true });
  }
  await writeFile(join(root, 'package.json'), JSON.stringify({ scripts: {} }));
  await writeFile(join(root, '.github/workflows/ci.yml'), JSON.stringify({ jobs: Object.fromEntries(['composite-site', ...CATALOG_JOBS].map((name) => [name, { steps: [{ run: 'echo fixture' }] }])) }));
  await writeFile(join(root, 'apps/lcmodel/main.js'), "import '../../scripts/entry.mjs';\n");
  await writeFile(join(root, 'scripts/entry.mjs'), 'const invalid = ;\n// packages/runtime/index.mjs\n');
  const graph = await loadConservativeWorkspaceGraph(root);
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['packages/runtime/index.mjs'], graph);
  assert.deepEqual(plan.selected.map((app) => app.id), ['lcmodel']);
});

test('changing or removing the catalog interaction root script still selects only the site', async () => {
  const registry = await loadAppsRegistry();
  const before = JSON.parse(await readFile(join(repoRoot, 'package.json'), 'utf8'));
  for (const replacement of ['node scripts/changed-agent-runner.mjs', undefined]) {
    const after = structuredClone(before);
    if (replacement === undefined) delete after.scripts['test:e2e:agent'];
    else after.scripts['test:e2e:agent'] = replacement;
    const manifests = new Map([
      ['package.json', manifest(before, after)],
      ['pnpm-lock.yaml', manifest(baseLock, baseLock)],
    ]);
    const plan = createAppPlan(registry, ['package.json'], await graph, manifests);
    assert.deepEqual(plan.selected, []);
    assert.equal(plan.site, true, `interaction script ${replacement === undefined ? 'removed' : 'changed'}`);
  }
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
  const manifests = new Map([['package.json', manifest({ scripts: { build: 'node scripts/build.mjs' } }, { scripts: {} })], ['pnpm-lock.yaml', manifest(baseLock, baseLock)]]);
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
  for (const path of ['scripts/app-plan.mjs', 'scripts/lib/app-plan.mjs', 'scripts/lib/lockfile-impact.mjs', 'scripts/lib/module-closure.mjs', 'scripts/lib/shared-module-users.mjs', 'scripts/lib/workspace-graph.mjs', 'scripts/lib/apps-registry.mjs', 'scripts/lib/tested-base.mjs', 'scripts/lib/ci-usage.mjs', 'scripts/lib/github-actions.mjs', 'scripts/lib/full-plan-budget.mjs', 'scripts/lib/release-bookkeeping.mjs', 'scripts/lib/embedded-version-sites.mjs', 'scripts/lib/standalone.mjs', 'scripts/lib/app-information.mjs', 'registry/apps.yml']) {
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

// A ready pull request whose change selects every app, run through the CLI with
// a `gh` stub that answers from `state`: its live labels, its branch's ci runs
// (filtered by the query's `created>=`), each run's job names, and an optional
// call to fail.
async function budgetFixture(t) {
  const { root } = await plannerFixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  // A change to a per-app job of ci.yml selects every app; the draft plan keeps none.
  const ci = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  ci.jobs['app-tests'].steps.push({ run: 'echo change' });
  await writeFile(join(root, '.github/workflows/ci.yml'), stringify(ci));
  git('commit', '--quiet', '-am', 'head');
  const bin = join(root, 'stub-bin');
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!/usr/bin/env node
const { readFileSync } = require('node:fs');
const state = JSON.parse(readFileSync(process.env.GH_STUB_STATE, 'utf8'));
const args = process.argv.slice(2);
const path = args.find((arg) => arg.startsWith('repos/'));
const fail = (what) => { process.stderr.write('HTTP 403: ' + what + ' refused'); process.exit(1); };
if (/\\/pulls\\/\\d+$/.test(path)) {
  if (state.fail === 'labels') fail('labels');
  console.log(JSON.stringify(state.labels));
} else if (path.includes('/workflows/ci.yml/runs?')) {
  if (state.fail === 'runs') fail('runs');
  const since = Date.parse(new URL('https://x/' + path).searchParams.get('created').slice(2));
  for (const run of state.runs) if (Date.parse(run.created_at) >= since) console.log(JSON.stringify(run));
} else if (/\\/runs\\/\\d+\\/jobs/.test(path)) {
  if (state.fail === 'jobs') fail('jobs');
  for (const job of state.jobs[/\\/runs\\/(\\d+)\\//.exec(path)[1]] ?? []) console.log(JSON.stringify(job));
} else fail('unexpected ' + path);
`);
  await chmod(join(bin, 'gh'), 0o755);
  // gh is a CommonJS script beside an ESM package.json.
  await writeFile(join(bin, 'package.json'), JSON.stringify({ type: 'commonjs' }));
  await writeFile(join(root, 'event.json'), JSON.stringify({ pull_request: {
    number: 827, labels: [{ name: 'full-ci' }], head: { ref: 'feature', sha: 'b'.repeat(40), repo: { full_name: 'neurodesk/webapps' } }, base: { repo: { full_name: 'neurodesk/webapps' } },
  } }));
  const hoursAgo = (hours) => new Date(Date.now() - hours * 3600e3).toISOString().replace(/\.\d+Z$/, 'Z');
  let id = 100;
  const ciRun = (fields = {}) => ({
    id: id++, name: 'ci', event: 'pull_request', status: 'completed', conclusion: 'cancelled', head_branch: 'feature', head_sha: 'a'.repeat(40),
    created_at: hoursAgo(2), run_started_at: hoursAgo(2), updated_at: hoursAgo(1.5), pull_requests: [827], head_repository: 'neurodesk/webapps', ...fields,
  });
  const plan = async (state) => {
    await writeFile(join(root, 'state.json'), JSON.stringify(state));
    const outputFile = join(root, `output-${id++}`);
    const result = spawnSync(process.execPath, ['scripts/app-plan.mjs', '--base', 'HEAD~1', '--head', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env, PATH: `${bin}:${process.env.PATH}`, GH_STUB_STATE: join(root, 'state.json'), GITHUB_OUTPUT: outputFile,
        GITHUB_EVENT_NAME: 'pull_request', CI_DRAFT: 'false', GITHUB_EVENT_PATH: join(root, 'event.json'), GITHUB_RUN_ID: '1', GITHUB_REPOSITORY: 'neurodesk/webapps',
      },
    });
    assert.equal(result.status, 0, result.stderr);
    const outputs = Object.fromEntries((await readFile(outputFile, 'utf8')).trim().split('\n').map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return { outputs, stderr: result.stderr };
  };
  return { ciRun, hoursAgo, plan };
}

// Jobs of a whole-catalogue run from before the marker, of a full-plan run,
// and of a run that tested only the draft plan, which lists the marker as skipped.
const ran = (names) => names.map((name) => ({ name, conclusion: 'success' }));
const wholeCatalogue = ran(Array.from({ length: 140 }, (_, index) => `browser-e2e (${index})`));
const markedRun = ran(['app-plan', 'full-plan', 'app-tests (calmar)']);
const draftRun = [...ran(Array.from({ length: 35 }, (_, index) => `app-tests (${index})`)), { name: 'full-plan', conclusion: 'skipped' }];

test('a ready pull request over its full-plan budget is planned as a draft and marked withheld', async (t) => {
  const { ciRun, plan } = await budgetFixture(t);
  const runs = [ciRun(), ciRun({ conclusion: 'success' })];
  const { outputs, stderr } = await plan({ labels: [], runs, jobs: { [runs[0].id]: wholeCatalogue, [runs[1].id]: markedRun } });
  assert.equal(outputs.withheld, 'true', stderr);
  assert.equal(outputs.full_plan, 'false', 'a withheld run is not a full-plan run');
  assert.equal(outputs.all_apps, 'false');
  assert.equal(outputs.has_site, 'false');
  assert.equal(outputs.has_apps, 'false');
  assert.match(stderr, /#827 already started 2 full-plan ci runs in 24 hours \(budget 2\)/);
  assert.match(stderr, /add the full-ci label and use "Re-run all jobs"/);
});

test('the full-plan budget keeps the full plan when it cannot justify withholding it', async (t) => {
  const { ciRun, hoursAgo, plan } = await budgetFixture(t);
  const full = (outputs, label) => {
    assert.equal(outputs.withheld, 'false', label);
    assert.equal(outputs.full_plan, 'true', label);
    assert.equal(outputs.all_apps, 'true', label);
    assert.equal(outputs.has_site, 'true', label);
  };
  const spent = [ciRun(), ciRun()];
  const jobs = Object.fromEntries(spent.map((run) => [run.id, markedRun]));
  // The label is read live: the event payload already lists full-ci, so only the API answer counts.
  full((await plan({ labels: ['full-ci'], runs: spent, jobs })).outputs, 'live full-ci label');
  for (const fail of ['labels', 'runs', 'jobs']) {
    const { outputs, stderr } = await plan({ labels: [], runs: spent, jobs, fail });
    full(outputs, `failed ${fail} lookup`);
    assert.match(stderr, /keeping the full plan because the budget check failed/);
  }
  const old = [ciRun({ created_at: hoursAgo(25), run_started_at: hoursAgo(25), updated_at: hoursAgo(24.5) }), ciRun()];
  full((await plan({ labels: [], runs: old, jobs: Object.fromEntries(old.map((run) => [run.id, wholeCatalogue])) })).outputs, 'a run older than 24 hours');
  const fork = [ciRun({ pull_requests: [], head_repository: 'ada/webapps' }), ciRun()];
  full((await plan({ labels: [], runs: fork, jobs: Object.fromEntries(fork.map((run) => [run.id, markedRun])) })).outputs, 'a fork branch of the same name');
  const draftTier = [ciRun(), ciRun()];
  full((await plan({ labels: [], runs: draftTier, jobs: { [draftTier[0].id]: markedRun, [draftTier[1].id]: draftRun } })).outputs, 'a draft-tier run');
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
  assert.equal(outputs.site_code, 'true');
  assert.deepEqual(JSON.parse(outputs.selected_ids), (await loadAppsRegistry()).apps.map(app => app.id));
});

test('manifest-only tool changes validate the unchanged lockfile through the CLI', async (t) => {
  for (const name of INDEPENDENT_ROOT_DEV_DEPENDENCIES) {
    for (const variant of ['valid', 'missing metadata', 'invalid resolution', 'missing snapshot', 'unparsable', 'unavailable']) {
      await t.test(`${name}: ${variant}`, async (t) => {
        const { root, run } = await plannerFixture(t);
        const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
        git('init', '--quiet');
        const pkg = { type: 'module', devDependencies: { [name]: '1.0.0' }, scripts: {} };
        await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
        const lock = changeLock(lock => {
          lock.importers['.'].devDependencies[name] = dep('1.0.0');
          resolve(lock, `${name}@1.0.0`);
        });
        if (variant === 'missing metadata') delete lock.packages[`${name}@1.0.0`];
        if (variant === 'invalid resolution') lock.packages[`${name}@1.0.0`].resolution = {};
        if (variant === 'missing snapshot') delete lock.snapshots[`${name}@1.0.0`];
        if (variant !== 'unavailable') {
          await writeFile(join(root, 'pnpm-lock.yaml'), variant === 'unparsable' ? '[invalid' : stringify(lock));
          git('add', 'pnpm-lock.yaml');
        }
        git('add', 'package.json');
        git('commit', '--quiet', '-m', 'base');
        const base = git('rev-parse', 'HEAD');
        pkg.devDependencies[name] = '^1.0.0';
        await writeFile(join(root, 'package.json'), JSON.stringify(pkg));
        git('commit', '--quiet', '-am', 'manifest only');
        const result = run('--base', base, '--head', 'HEAD');
        assert.equal(result.status, 0, result.stderr);
        const output = JSON.parse(result.stdout);
        assert.deepEqual(output.changedPaths, ['package.json']);
        if (variant === 'valid') {
          assert.deepEqual(JSON.parse(output.selected_ids), []);
          assert.equal(output.has_site, 'false');
          assert.equal(output.fallback_reason, '');
        } else {
          assert.equal(output.all_apps, 'true', variant);
          assert.equal(output.has_site, 'true', variant);
          assert.deepEqual(JSON.parse(output.selected_ids), (await loadAppsRegistry()).apps.map(app => app.id));
          assert.match(output.fallback_reason, /pnpm-lock\.yaml/);
          if (variant === 'missing metadata' || variant === 'invalid resolution') assert.match(output.fallback_reason, /package metadata/);
          if (variant === 'missing snapshot') assert.match(output.fallback_reason, /no snapshot/);
          if (variant === 'unparsable') assert.match(output.fallback_reason, /does not parse/);
          if (variant === 'unavailable') assert.match(output.fallback_reason, /unavailable/);
        }
      });
    }
  }
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
  // A base git cannot compare is an unreadable diff, never an empty one.
  assert.match(fallback.fallback_reason, /^the changed paths could not be read: git diff 0123456789abcdef0123456789abcdef01234567\.\.\.HEAD failed/);
  assert.match(missingBase.stderr, /Full catalog and site selected: the changed paths could not be read/);
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
  // A failed run can be the base when asked for; a cancelled one never is.
  const failedNearer = [run(8, 'c', { conclusion: 'failure' }), ...runs];
  assert.equal(testedBase({ runs: failedNearer, head: 'head', branch: 'main', git }).base, 'b');
  assert.equal(testedBase({ runs: failedNearer, head: 'head', branch: 'main', git, conclusions: ['success', 'failure'] }).run.id, 8);
});

test('a failed run carries the apps whose jobs did not pass, and nothing it cannot tie to an app', () => {
  const { carried, unattributed } = carriedApps([
    { name: 'app-tests (calmar, apps/calmar, static-esm, false)', conclusion: 'failure' },
    { name: 'browser-e2e-gpu (synthsr, synthsr, vite-webgpu, true)', conclusion: 'timed_out' },
    { name: 'browser-e2e (niimath, apps/niimath, vite, false, 2/3)', conclusion: 'cancelled' },
    { name: 'browser-e2e (lcmodel, apps/lcmodel, vite, false, )', conclusion: 'success' },
    { name: 'app-tests (zarro, apps/zarro, vite, false)', conclusion: 'skipped' },
    { name: 'workspace-contracts', conclusion: 'failure' },
    { name: 'agent-interactions (desktop, 1/3)', conclusion: 'failure' },
  ]);
  assert.deepEqual([...carried.keys()], ['calmar', 'synthsr', 'niimath']);
  assert.deepEqual(unattributed, []);
  assert.deepEqual(carriedApps([{ name: 'app-plan', conclusion: 'failure' }, { name: 'a-new-job', conclusion: 'cancelled' }]).unattributed, ['app-plan', 'a-new-job']);
  // An id the registry does not know (a reordered matrix) and an unfinished job are tied to no app.
  const known = new Set(['calmar']);
  assert.deepEqual(carriedApps([{ name: 'browser-e2e (apps/calmar, calmar)', conclusion: 'failure' }], known).unattributed, ['browser-e2e (apps/calmar, calmar)']);
  assert.deepEqual(carriedApps([{ name: 'browser-e2e (calmar, apps/calmar)', conclusion: null }], known).unattributed, ['browser-e2e (calmar, apps/calmar) (not finished)']);
  assert.deepEqual([...carriedApps([{ name: 'browser-e2e (calmar, apps/calmar)', conclusion: 'failure' }], known).carried.keys()], ['calmar']);
});

// carriedApps reads a failed run's jobs by name: every ci job must be one it knows.
test('every ci job is the plan, a per-app job named by its app, or one a push or the nightly runs again', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const known = new Set(['app-plan', ...APP_JOBS, ...RERUN_JOBS, ...SITE_JOBS, ...NIGHTLY_JOBS]);
  for (const id of Object.keys(ci.jobs)) assert.ok(known.has(id), `${id} is a job carriedApps cannot place`);
  // A site job checks the apps its own plan selected, so a push after its failure diffs from the last green run.
  for (const id of SITE_JOBS) assert.deepEqual(carriedApps([{ name: id, conclusion: 'failure' }]).unattributed, [id]);
  assert.deepEqual(siteJobNames(ci).filter((id) => !SITE_JOBS.includes(id)).sort(), ['agent-interactions', 'example-cache-retention', 'processing-workflows', 'turbo-cache-retention']);
  const outputs = { 'app-tests': 'apps', 'browser-e2e': 'browser_apps', 'browser-e2e-gpu': 'gpu_apps' };
  for (const id of APP_JOBS) {
    const job = ci.jobs[id];
    assert.equal(job.name, undefined, `${id} is named by its matrix`);
    // A job it waited for could fail and skip it unexpanded, leaving nothing to carry.
    assert.equal(job.needs, 'app-plan', `${id} waits only for the plan`);
    assert.equal(job.strategy.matrix, `\${{ fromJSON(needs.app-plan.outputs.${outputs[id]}) }}`);
    assert.equal(job.strategy['fail-fast'], false, `${id} runs every app when one fails`);
  }
  // The matrix's first value, which names the job, is the app id.
  const plan = createAppPlan(await loadAppsRegistry(), ['apps/synthseg/src/main.js'], await graph);
  for (const matrix of [plan.apps, plan.browserApps, plan.gpuApps]) assert.equal(Object.keys(matrix.include[0])[0], 'app');
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
  let jobs = {};
  let status = 200;
  const server = createServer((request, response) => {
    const listed = request.url.startsWith('/repos/neurodesk/webapps/actions/workflows/ci.yml/runs?branch=main&status=completed');
    const run = request.url.match(/^\/repos\/neurodesk\/webapps\/actions\/runs\/(\d+)\/attempts\/1\/jobs\?/)?.[1];
    response.writeHead(listed || jobs[run] ? status : 404, { 'content-type': 'application/json' });
    response.end(JSON.stringify(listed ? { workflow_runs: runs } : { jobs: jobs[run] ?? [] }));
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

  // A failed run is the base: only the apps whose jobs failed there are selected again.
  const failed = { id: 3, event: 'push', head_branch: 'main', head_sha: before, conclusion: 'failure' };
  runs = [failed, ...runs];
  jobs = { 3: [
    { name: 'app-tests (calmar, apps/calmar, static-esm, false)', conclusion: 'success' },
    { name: 'browser-e2e (calmar, apps/calmar, static-esm, false, 1/2)', conclusion: 'failure' },
    { name: 'browser-e2e (niimath, apps/niimath, vite, false, )', conclusion: 'success' },
    { name: 'workspace-contracts', conclusion: 'failure' },
    { name: 'full-plan-withheld', conclusion: 'skipped' },
  ] };
  const carried = await plan();
  assert.deepEqual(JSON.parse(carried.selected_ids), sorted(['calmar', 'zarro']));
  assert.match(carried.stderr, new RegExp(`base ${before} is the head of the last failed ci run on main \\(push run 3\\); it failed for calmar, which is selected again`));
  assert.match(carried.stderr, /- calmar: failed in the base run \(browser-e2e \(calmar/);
  // A failure no app owns (the plan itself) falls back to the last green run.
  jobs = { 3: [{ name: 'app-plan', conclusion: 'failure' }] };
  const unowned = await plan();
  assert.deepEqual(JSON.parse(unowned.selected_ids), sorted(['niimath', 'calmar', 'lcmodel', 'zarro']));
  assert.match(unowned.stderr, new RegExp(`base ${tested} is the head of the last successful ci run on main.*failed in app-plan, which no app owns`));
  // A site check covered only the apps of its own run, so its failure falls back too.
  jobs = { 3: [{ name: 'site-audit', conclusion: 'failure' }] };
  assert.deepEqual(JSON.parse((await plan()).selected_ids), sorted(['niimath', 'calmar', 'lcmodel', 'zarro']));
  runs = runs.filter((each) => each !== failed);

  for (const [name, setup] of [
    ['no green run', () => { runs = []; }],
    ['a rewritten history', () => { runs = [{ id: 1, event: 'push', head_branch: 'main', head_sha: '0123456789abcdef0123456789abcdef01234567', conclusion: 'success' }]; }],
    ['an API error', () => { status = 502; }],
  ]) {
    setup();
    const fallback = await plan();
    assert.equal(fallback.all_apps, 'true', name);
    assert.match(fallback.fallback_reason, /ci run on main/, name);
  }
});

// A repository with one commit of `files`, and a function that commits more changes.
async function diffRepository(t, files) {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-diff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' });
  const write = async (files) => {
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(root, path, '..'), { recursive: true });
      await writeFile(join(root, path), text);
    }
  };
  git('init', '--quiet');
  await write(files);
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD').trim();
  return { root, git, base, commit: async (changes, moves = []) => {
    await write(changes);
    for (const [from, to] of moves) git('mv', from, to);
    git('add', '-A');
    git('commit', '--quiet', '-m', 'change');
  } };
}

test('changed paths are read NUL-delimited, so git does not quote an unusual name', async (t) => {
  const name = 'apps/niimath/ünï "quoted".js';
  const { root, git, base, commit } = await diffRepository(t, { 'README.md': 'x' });
  await commit({ [name]: 'x' });
  assert.match(git('diff', '--name-only', `${base}...HEAD`), /^"apps\/niimath\/\\303/, 'git quotes the name in its line form');
  assert.deepEqual(changedPathsFromGit({ base, cwd: root }), [name]);
});

test('changed paths keep leading and trailing spaces', async (t) => {
  const name = 'apps/niimath/ padded.js ';
  const { root, base, commit } = await diffRepository(t, { 'README.md': 'x' });
  await commit({ [name]: 'x' });
  assert.deepEqual(changedPathsFromGit({ base, cwd: root }), [name]);
});

test('changed paths hold both sides of a copy', async (t) => {
  const source = 'packages/a/test/fixtures/data.txt';
  const text = Array.from({ length: 40 }, (_, line) => `line ${line}`).join('\n');
  const { root, git, base, commit } = await diffRepository(t, { [source]: text });
  // A copy is found when its source changes in the same commit.
  await commit({ 'apps/b/copied.txt': text, [source]: `${text}\nmore` });
  assert.match(git('diff', '--name-status', '--find-copies', `${base}...HEAD`), /^C\d+\t/m);
  assert.deepEqual(changedPathsFromGit({ base, cwd: root }).sort(), ['apps/b/copied.txt', source].sort());
});

test('a diff git cannot read is not an empty one: the plan tests everything', async (t) => {
  const { root } = await diffRepository(t, { 'README.md': 'x' });
  assert.throws(() => changedPathsFromGit({ base: '0123456789abcdef0123456789abcdef01234567', cwd: root }), UnreadableDiffError);
  assert.deepEqual(changedPathsFromGit({ base: '', cwd: root }), [], 'no base is a full run');
  // The CLI selects every app, the site build and the easter egg, and says why.
  const { root: fixture, run } = await plannerFixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: fixture });
  execFileSync('git', ['-c', 'user.name=p', '-c', 'user.email=p@example.org', 'commit', '--quiet', '--allow-empty', '-m', 'x'], { cwd: fixture });
  const result = run('--base', '0123456789abcdef0123456789abcdef01234567', '--head', 'HEAD');
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.match(plan.fallback_reason, /^the changed paths could not be read: git diff 0123456789abcdef0123456789abcdef01234567\.\.\.HEAD failed/);
  assert.equal(plan.all_apps, 'true');
  assert.equal(plan.has_site, 'true');
  assert.equal(plan.easter_egg, EASTER_EGG_OUTPUT.run);
  assert.match(JSON.parse(plan.selection_reasons).easter_egg[0], /^no changed paths/);
  // The site checks cover every app too.
  assert.equal(plan.site_code, 'true');
  assert.equal(siteCheckApps(await loadAppsRegistry(), { event: 'pull_request', plan }).value, '');
});

test('a site key no app page carries is data for the per-app site checks, and any other key is code', async () => {
  const registry = await loadAppsRegistry();
  const information = await loadAppInformation(registry);
  const pages = (value) => JSON.stringify(value.apps.map((app) => hostedThemeOptions({ registry: value, information, app, version: 'x' })));
  const changed = (key) => {
    const copy = structuredClone(registry);
    const segments = key.split('.').flatMap((part) => (part.endsWith('[]') ? [part.slice(0, -2), '[]'] : [part]));
    const visit = (value, rest, parent, name) => {
      if (!rest.length) {
        parent[name] = typeof value === 'number' ? value + 1 : typeof value === 'boolean' ? !value : `${value ?? ''}-changed`;
        return;
      }
      const [head, ...tail] = rest;
      if (head === '[]') value.forEach((entry, index) => visit(entry, tail, value, index));
      else visit(value?.[head], tail, value, head);
    };
    visit(copy, segments, null, null);
    return copy;
  };
  const before = pages(registry);
  for (const key of SITE_DATA_KEYS) {
    assert.ok(Object.hasOwn(SITE_KEY_READERS, key), `${key} is a site key`);
    assert.equal(pages(changed(key)), before, `${key} reaches an app page`);
  }
  assert.notEqual(pages(changed('site.catalogs[].brand.more_apps')), before, 'the check can see a page change');
  // In the planner a data key leaves site_code false and a page key sets it.
  const hub = await registryPlan((after) => {
    after.site.hub.title = 'Renamed hub';
  });
  assert.equal(hub.allApps, false);
  assert.equal(hub.siteCode, false);
  const brand = await registryPlan((after) => {
    after.site.catalogs[0].brand.more_apps = 'More apps';
  });
  assert.equal(brand.allApps, false);
  assert.equal(brand.siteCode, true);
  assert.ok(brand.reasons.site.includes('registry/apps.yml: site.catalogs[].brand.more_apps changed, and the composite build writes it into every app page'));
});

test('a rename lists both its paths, so what reads the old path is selected', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'app-plan-rename-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  // Deface's and Brain Extraction's package tests read CALMaR's fixture.
  const fixture = 'apps/calmar/tests/fixtures/synthstrip-mini/T1.nii.gz';
  await mkdir(join(root, fixture, '..'), { recursive: true });
  await writeFile(join(root, fixture), await readFile(join(repoRoot, fixture)));
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await mkdir(join(root, 'docs'));
  git('mv', fixture, 'docs/T1.nii.gz');
  git('commit', '--quiet', '-m', 'move');
  assert.match(git('diff', '--name-status', `${base}...HEAD`), /^R100\t/, 'git pairs the move as a rename by default');
  const paths = changedPathsFromGit({ base, cwd: root });
  assert.deepEqual(paths.sort(), [fixture, 'docs/T1.nii.gz'].sort());
  const plan = createAppPlan(await loadAppsRegistry(), paths, await graph);
  // Without the old path the move would select nothing: docs/ is read by no test.
  assert.ok(plan.selected.some((app) => app.id === 'calmar'));
  assert.deepEqual(createAppPlan(await loadAppsRegistry(), ['docs/T1.nii.gz'], await graph).selected, []);
});

test('a .gitattributes change selects the apps whose files now check out differently', async (t) => {
  const { root, run } = await plannerFixture(t);
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  for (const path of ['apps/niimath/fixture.tsv', 'apps/calmar/notes.txt', 'exes/unused/data.bin']) {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), path);
  }
  await writeFile(join(root, '.gitattributes'), 'apps/calmar/*.txt whitespace=-trailing-space\n');
  git('add', '-A');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  const plan = async (attributes) => {
    await writeFile(join(root, '.gitattributes'), attributes);
    git('commit', '--quiet', '-am', attributes || 'empty');
    const result = run('--base', base, '--head', 'HEAD');
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };

  // Each plan diffs from `base`, whose only rule covers calmar's notes.
  // A new rule for an app's fixture selects that app, and no other.
  const fixture = await plan('apps/calmar/*.txt whitespace=-trailing-space\napps/niimath/*.tsv -text\n');
  assert.deepEqual(JSON.parse(fixture.selected_ids), ['niimath']);
  assert.match(JSON.parse(fixture.selection_reasons).apps.niimath[0], /^\.gitattributes: apps\/niimath\/fixture\.tsv/);
  // Removing a rule touches the files it covered.
  const removed = await plan('');
  assert.deepEqual(JSON.parse(removed.selected_ids), ['calmar']);
  // Comments and rules matching no app file select nothing.
  const none = await plan('# apps/niimath/fixture.tsv\napps/calmar/*.txt whitespace=-trailing-space\nexes/unused/*.bin -text\n');
  assert.deepEqual(JSON.parse(none.selected_ids), []);
  assert.equal(none.fallback_reason, '');
  // A pattern without a directory reaches every file it matches.
  const everywhere = await plan('apps/calmar/*.txt whitespace=-trailing-space\n*.tsv -text\n');
  assert.deepEqual(JSON.parse(everywhere.selected_ids), ['niimath']);
});

test('a .gitattributes change without a comparable base selects the full catalog', async () => {
  const registry = await loadAppsRegistry();
  const plan = createAppPlan(registry, ['.gitattributes'], await graph, new Map());
  assert.equal(plan.allApps, true);
  assert.match(plan.reasons.fallback, /\.gitattributes: the files whose attributes changed are unknown/);
});

// Tracked files, Markdown aside, whose text matches the extended regex `pattern`.
function filesNaming(pattern) {
  const grep = spawnSync('git', ['grep', '-lzE', pattern, '--', '.', ':!*.md'], { cwd: repoRoot, encoding: 'utf8' });
  assert.ok(grep.status === 0 || grep.status === 1, grep.stderr);
  return grep.stdout.split('\0').filter(Boolean);
}

test('composite-only site files select the site build and no app', async () => {
  const registry = await loadAppsRegistry();
  for (const path of SITE_ONLY_FILES) {
    for (const withGraph of [await graph, null]) {
      const plan = createAppPlan(registry, [path], withGraph);
      assert.deepEqual(plan.selected, [], path);
      assert.equal(plan.site, true, path);
      assert.equal(plan.siteCode, false, path);
      assert.equal(plan.reasons.fallback, null, path);
    }
  }
  // The shell and theme scripts go into every app's JS runtime; theme CSS tests its direct consumers + full site, fonts test the full site.
  for (const path of ['site/app-shell.js', 'site/theme.js']) {
    assert.equal(createAppPlan(registry, [path], await graph).allApps, true, path);
  }
  const themePlan = createAppPlan(registry, ['site/app-theme.css'], await graph);
  assert.deepEqual(themePlan.selected.map(({ id }) => id).sort(), [...SITE_THEME_CONSUMERS].sort());
  assert.equal(themePlan.site, true);
  assert.equal(themePlan.siteCode, true);
  assert.equal(themePlan.allApps, false);
  const fontsPlan = createAppPlan(registry, ['site/fonts/inter.woff2'], await graph);
  assert.deepEqual(fontsPlan.selected, []);
  assert.equal(fontsPlan.site, true);
  assert.equal(fontsPlan.siteCode, true);
  assert.equal(fontsPlan.allApps, false);
  // Every app source or test that directly loads site/app-theme.css or site/fonts must be in SITE_THEME_CONSUMERS.
  for (const file of filesNaming('app-theme\\.css|site/fonts')) {
    if (!file.startsWith('apps/') || file.endsWith('.md') || file.endsWith('.css')) continue;
    const appId = file.split('/')[1];
    assert.ok(SITE_THEME_CONSUMERS.includes(appId), `${file} directly loads site theme/fonts; add ${appId} to SITE_THEME_CONSUMERS`);
  }
});

test('only the composite build and its own tests read the composite-only site files', async () => {
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  const readers = new Set([
    'scripts/build-site.mjs',
    'scripts/lib/landing-page.mjs',
    'scripts/lib/dicompare-routes.mjs',
    'scripts/lib/catalog-sites.mjs',
    'scripts/lib/hub-page.mjs',
    'scripts/lib/not-found-page.mjs',
    'scripts/write-analytics.mjs',
    // Each desktop suite is its catalogue site without the host-only 404 page and headers.
    'scripts/desktop/assemble.mjs',
    'test-utils/dicompare-routes.mjs',
    'knip.config.mjs',
    // The planner names them to classify them.
    'scripts/lib/app-plan.mjs',
    ...SITE_ONLY_FILES,
  ]);
  // Upstream adaptation notes and copied deployment configuration are not runtime readers.
  const unrelated = new Set(['apps/qsmbly/upstream.json', 'apps/dicompare/upstream.json', 'apps/dicompare/legacy-ci/deploy.yml']);
  const names = [...SITE_ONLY_FILES].map((path) => path.slice('site/'.length).replaceAll('.', '\\.'));
  for (const file of filesNaming(names.join('|'))) {
    if (file.startsWith('test/') || file.startsWith('site/easter-eggs/') || unrelated.has(file)) continue;
    assert.ok(readers.has(file), `${file} names a composite-only site file; check it, then list it as a reader here`);
  }
  const catalog = reachableFrom(workspace, CATALOG);
  for (const reader of readers) {
    assert.ok(!catalog.has(reader), `ci.yml's per-app jobs run ${reader}`);
    for (const app of registry.apps) assert.ok(!reachableFrom(workspace, `apps/${app.id}`).has(reader), `${app.id} reaches ${reader}`);
  }
});

test('a runtime manifest change selects the apps that stage its files and the site build', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const reaches = (app, node) => reachableFrom(workspace, `apps/${app.id}`).has(node);
  const plan = createAppPlan(registry, ['runtime-assets/manifest.json'], workspace);
  const staging = registry.apps.filter((app) => RUNTIME_MANIFEST_READERS.some((reader) => reaches(app, reader)));
  assert.ok(staging.length > 0);
  assert.deepEqual(plan.selected.map((app) => app.id), staging.map((app) => app.id));
  assert.equal(plan.site, true);
  assert.equal(plan.siteCode, true, 'the shared runtime store of every app is assembled from it');
  assert.equal(createAppPlan(registry, ['runtime-assets/manifest.json']).allApps, true, 'without a graph the manifest stays shared');

  // Every other reader belongs to a selected app, a package only selected apps
  // reach, the composite build, or a check outside the per-app jobs.
  const selected = new Set(plan.selected.map((app) => app.id));
  const composite = new Set(['scripts/lib/runtime-assets.mjs', 'scripts/audit-artifacts.mjs', 'test-utils/asyncify-runtime-startup.mjs', 'test-utils/shared-binary-startup.mjs']);
  // The planner names the manifest to classify it.
  const planner = 'scripts/lib/app-plan.mjs';
  const catalog = reachableFrom(workspace, CATALOG);
  for (const file of composite) {
    assert.ok(!catalog.has(file), `ci.yml's per-app jobs run ${file}`);
    for (const app of registry.apps) assert.ok(!reaches(app, file), `${app.id} reaches ${file}`);
  }
  for (const file of filesNaming(String.raw`runtime-assets(/|['"]\s*,\s*['"])manifest\.json`)) {
    if (RUNTIME_MANIFEST_READERS.includes(file) || composite.has(file) || file === planner || file.startsWith('test/') || file === 'knip.config.mjs') continue;
    if (/^\.github\/workflows\/(?!ci\.yml$)/.test(file)) continue;
    const app = file.match(/^apps\/([^/]+)\//)?.[1];
    if (app) {
      assert.ok(selected.has(app), `${file} reads the runtime manifest but ${app} is not selected`);
      continue;
    }
    const owner = file.match(/^packages\/[^/]+/)?.[0];
    assert.ok(owner, `${file} reads the runtime manifest; check it, then add it to RUNTIME_MANIFEST_READERS`);
    for (const user of registry.apps.filter((candidate) => reaches(candidate, owner))) {
      assert.ok(selected.has(user.id), `${file} reads the runtime manifest, and ${user.id} reaches ${owner} but is not selected`);
    }
  }
});

test('an automation contract change also selects the apps that generate tools from every contract', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const reaches = (app, node) => reachableFrom(workspace, `apps/${app.id}`).has(node);
  const generating = registry.apps.filter((app) => AUTOMATION_CATALOG_READERS.some((reader) => reaches(app, reader)));
  assert.ok(generating.some(({ id }) => id === 'pipeline-builder'));
  const ids = (paths) => createAppPlan(registry, paths, workspace).selected.map(({ id }) => id).sort();
  assert.deepEqual(ids(['apps/n4/automation.json']), [...new Set(['n4', ...generating.map(({ id }) => id)])].sort());
  assert.deepEqual(ids(['apps/n4/src/main.js']), ['n4']);
  for (const path of ['packages/desktop/neuroflow/generator.mjs', 'packages/desktop/neuroflow/runtime/stdio.mjs', 'packages/desktop/neuroflow/vendor/tool.schema.json']) {
    assert.ok(ids([path]).includes('pipeline-builder'), `${path} is part of the catalog Pipeline builder publishes`);
  }

  // Other loaders an app's build or tests reach read only that app's own contract.
  const ownContract = new Set(['scripts/lib/app-automation.mjs', 'scripts/lib/vite-app-config.mjs', 'apps/dicompare/vite.config.mts']);
  const reached = new Set(registry.apps.flatMap((app) => [...reachableFrom(workspace, `apps/${app.id}`)]));
  for (const file of filesNaming(String.raw`\b(loadAppContract|loadCatalogContracts)\b`)) {
    const app = file.match(/^apps\/([^/]+)\//)?.[1];
    if (!app && !reached.has(file)) continue;
    if (AUTOMATION_CATALOG_READERS.includes(file) || ownContract.has(file) || generating.some(({ id }) => id === app)) continue;
    assert.fail(`${file} loads automation contracts; if it reads other apps' contracts, add it to AUTOMATION_CATALOG_READERS`);
  }
});

test('a standalone catalog change selects the apps whose entries changed', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const text = await readFile(join(repoRoot, 'registry/standalone.json'), 'utf8');
  const edit = (change) => {
    const value = JSON.parse(text);
    change(value);
    return `${JSON.stringify(value, null, 2)}\n`;
  };
  const plan = (after) => createAppPlan(registry, ['registry/standalone.json'], workspace, new Map([['registry/standalone.json', { before: text, after }]]));
  const republished = plan(edit((value) => {
    value.apps.lcmodel.downloads[0].sha256 = 'f'.repeat(64);
  }));
  assert.deepEqual(republished.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(republished.site, true);
  assert.equal(republished.siteCode, false);
  assert.deepEqual(republished.reasons.apps.lcmodel, ['registry/standalone.json: the lcmodel entry changed']);
  const suite = plan(edit((value) => {
    value.suites.neuro.downloads[0].version = '9.9.9';
  }));
  assert.deepEqual(suite.selected, []);
  assert.equal(suite.site, true);
  // Every themed build validates the whole catalog, so an invalid entry breaks every app.
  const invalid = plan(edit((value) => {
    value.apps.lcmodel.downloads[0].sha256 = 'not-a-checksum';
  }));
  assert.equal(invalid.allApps, true);
  assert.match(invalid.reasons.fallback, /not a valid catalog at head \(lcmodel: download must have a checksum\)/);
  const repository = plan(edit((value) => {
    value.repository = 'https://github.com/example/fork';
  }));
  assert.match(repository.reasons.fallback, /its repository field changed/);
  // Without both texts the change follows the graph: every themed app reaches the file.
  assert.ok(createAppPlan(registry, ['registry/standalone.json'], workspace).selected.length > 1);
});

test('only the packages every app is built from are reached by most apps', async () => {
  // A path in a root script is an edge, so prose naming a package (a reason, a
  // message) silently selects every app that runs the script. A package most
  // apps reach is either listed here on purpose or such a false edge.
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  const users = new Map();
  for (const app of registry.apps) {
    for (const node of reachableFrom(workspace, `apps/${app.id}`)) {
      if (/^(?:packages|exes)\/[^/]+$/.test(node)) users.set(node, (users.get(node) ?? 0) + 1);
    }
  }
  const hubs = [...users].filter(([, count]) => count > registry.apps.length / 2).map(([node]) => node).sort();
  assert.deepEqual(hubs, ['packages/analytics', 'packages/components', 'packages/runtime-support']);
  // The lint inventory excludes files by exact path; it reads no package and standalone lint scripts do not pull it into apps.
  const inventory = [...(workspace.edges.get('scripts/quality/lint-inventory.mjs') ?? [])];
  assert.deepEqual(inventory.filter((node) => /^(?:packages|exes)\/[^/]+$/.test(node)), []);
  // A diffusion package change reaches the diffusion apps, not every app with a lint script.
  const plan = createAppPlan(registry, ['packages/hmc/src/pool.js'], workspace);
  assert.equal(plan.reasons.fallback, null);
  assert.ok(plan.selected.some((app) => app.id === 'hmc'));
  assert.ok(!plan.selected.some((app) => app.id === 'stardist'));
  assert.ok(plan.selected.length < registry.apps.length / 3, `${plan.selected.length} apps`);
});

test('removing lint reason edges preserves the diffusion and Node driver consumers', async () => {
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  const diffusion = ['bison', 'degibbs', 'dwi2trx', 'dwicorrect', 'dwidenoise', 'fastprep', 'hmc', 'n4', 'noddi', 'sdc'];
  const cases = [
    ...[
      'packages/hmc/src/pool.js',
      'packages/noddi/src/pipeline.js',
      'packages/sdc/src/index.js',
      'packages/n4/src/index.js',
      'packages/dwi2trx/src/runner.js',
      'packages/shoreline/src/index.js',
      'packages/hmc-registration/src/index.js',
      'exes/dwi/sdc/src/lib.rs',
      'exes/sdc/core/src/lib.rs',
    ].map((path) => [path, diffusion]),
    ['packages/ants-denoise/src/index.js', ['ants-denoise', ...diffusion]],
    ['packages/node-drivers/src/niimath.js', [
      ...diffusion,
      'brain-extraction', 'brain2print', 'browserqc', 'dcm2niix', 'deface',
      'dicomview', 'edgereg', 'lcmodel', 'mri2vid', 'niimath', 'syncro',
    ]],
  ];
  for (const [path, consumers] of cases) {
    const plan = createAppPlan(registry, [path], workspace);
    assert.equal(plan.reasons.fallback, null, path);
    assert.deepEqual(plan.selected.map(({ id }) => id).sort(), [...consumers].sort(), path);
  }
});

test('an app information change selects the apps whose entries changed', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const path = 'registry/app-information.yml';
  const text = await readFile(join(repoRoot, path), 'utf8');
  const edit = (change) => {
    const value = parse(text);
    change(value);
    return stringify(value);
  };
  const plan = (after, before = text) => createAppPlan(registry, [path], workspace, new Map([[path, { before, after }]]));
  const cited = plan(edit((value) => {
    value.apps.lcmodel.citations[0].title += ' (revised)';
  }));
  assert.deepEqual(cited.selected.map((app) => app.id), ['lcmodel']);
  assert.equal(cited.site, true);
  assert.equal(cited.siteCode, false);
  assert.deepEqual(cited.reasons.apps.lcmodel, [`${path}: the lcmodel entry changed`]);
  // Comments and layout are not content.
  const reformatted = plan(stringify(parse(text)));
  assert.deepEqual(reformatted.selected, []);
  assert.equal(reformatted.reasons.fallback, null);
  // A new app arrives with its entry; the other apps' payloads are unchanged.
  const added = plan(text, edit((value) => {
    delete value.apps.lcmodel;
  }));
  assert.deepEqual(added.selected.map((app) => app.id), ['lcmodel']);
  // The shell renders the shared statements in every app.
  const shared = plan(edit((value) => {
    value.shared.execution = 'It runs entirely in your browser, on your device.';
  }));
  assert.equal(shared.allApps, true);
  assert.match(shared.reasons.fallback, /its shared section changed/);
  // Every themed build validates the whole file, so an invalid entry breaks every app.
  const invalid = plan(edit((value) => {
    value.apps.lcmodel.citations[0].doi = 'not-a-doi';
  }));
  assert.equal(invalid.allApps, true);
  assert.match(invalid.reasons.fallback, /not valid at head \(Invalid app information: - lcmodel\.citations\[0\]\.doi/);
  const unparsed = plan('apps: [unclosed');
  assert.equal(unparsed.allApps, true);
  const section = plan(edit((value) => {
    value.defaults = { packages: [] };
  }));
  assert.match(section.reasons.fallback, /its defaults section changed/);
  // A recursive alias parses and validates, but cannot be compared, at head or at the base.
  const recursive = text.replace('\n  lcmodel:\n', '\n  lcmodel: &lcmodel\n    extra: *lcmodel\n');
  assert.notEqual(recursive, text);
  for (const looped of [plan(recursive), plan(text, recursive)]) {
    assert.equal(looped.allApps, true);
    assert.match(looped.reasons.fallback, /cannot be compared/);
  }
  // Without both texts the change follows the graph: every themed app reaches the file.
  assert.ok(createAppPlan(registry, [path], workspace).selected.length > 1);
});

test('an app build and its tests read only their own entry of the app information', async () => {
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  // Readers the per-app jobs reach, and what each does with the file.
  const readers = {
    'scripts/lib/app-information.mjs': 'validates the whole file; appInformationPayload returns shared and apps[appId]',
    'scripts/lib/app-plan.mjs': 'compares the entries',
    'scripts/lib/vite-app-config.mjs': 'passes appInformationPayload(information, app.id) to the dev shell',
    'scripts/theme-app-dist.mjs': 'passes appInformationPayload(information, appId) to the built app',
    'scripts/lib/catalog-sites.mjs': 'passes appInformationPayload(information, app.id, siteAppIds) per hosted app',
    'scripts/dev-server.mjs': 'passes appInformationPayload(information, themeAppId) to static apps',
    'scripts/new-app.mjs': 'appends the new app\'s entry',
    'apps/qsmbly/e2e/citations.spec.js': 'checks information.apps.qsmbly',
    // Comments saying the shell renders Cite.
    'apps/surfannotate/src/main.js': 'names it in a comment',
    'apps/surfannotate/e2e/smoke.spec.js': 'names it in a comment',
    'apps/qsmbly/upstream.json': 'names it in a maintenance note',
    'apps/seedseg/upstream.json': 'names it in a maintenance note',
    'apps/fastprep/index.html': 'names it in a comment',
    'apps/niimath/index.html': 'names it in a comment',
    'apps/spinalcordtoolbox/scripts/test_ui_coverage.cjs': 'checks the parsed apps.spinalcordtoolbox.citations',
  };
  const reached = new Set(registry.apps.flatMap((app) => [...reachableFrom(workspace, `apps/${app.id}`)]));
  for (const file of filesNaming(String.raw`app-information(\.yml|\.mjs)|loadAppInformation|appInformationPath`)) {
    if (file === 'registry/app-information.yml' || (!file.startsWith('apps/') && !reached.has(file))) continue;
    assert.ok(Object.hasOwn(readers, file), `${file} reads the app information; check it reads only its own entry, then list it`);
  }
  const loader = await readFile(join(repoRoot, 'scripts/lib/app-information.mjs'), 'utf8');
  const payload = loader.slice(loader.indexOf('export function appInformationPayload'));
  assert.deepEqual([...payload.matchAll(/information\.(\w+)(\[\w+\])?/g)].map((match) => match[0]).sort(), ['information.apps[appId]', 'information.catalog', 'information.shared']);
  // The handoff catalog comes from registry/apps.yml, whose changes the planner reads per entry too.
  assert.match(loader, /catalog: deepFreeze\(registry\.apps/);
  assert.doesNotMatch(await readFile(join(repoRoot, 'apps/qsmbly/e2e/citations.spec.js'), 'utf8'), /(?<![-\w])information\.(?!apps\.qsmbly\b)/);
  // The planner compares parsed entries, so a reader must parse too: one matching the
  // file's text would fail on a layout change that selects no app.
  const sct = await readFile(join(repoRoot, 'apps/spinalcordtoolbox/scripts/test_ui_coverage.cjs'), 'utf8');
  assert.match(sct, /const appInformation = YAML\.parse\(fs\.readFileSync\([^\n]*app-information\.yml'\), 'utf8'\)\);/);
  assert.doesNotMatch(sct, /appInformation\.(?!apps\.spinalcordtoolbox\b)/);
});

test('the shell and its tests read only their own app entry of the standalone catalog', async () => {
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  // Readers the per-app jobs reach, and what each does with the catalog.
  const readers = {
    'scripts/lib/standalone.mjs': 'validates the whole catalog, then copies it',
    'scripts/lib/vite-app-config.mjs': 'links it in the dev shell',
    'scripts/dev-server.mjs': 'serves it to static apps',
    'site/app-shell.js': 'renders catalog.apps[metadata.id]',
    'test-utils/standalone-dialog.mjs': 'checks catalog.apps[id]',
    // A comment saying the shell renders the dialog.
    'apps/disconnectome/src/main.js': 'names it in a comment',
    'apps/disconnectome/e2e/smoke.spec.js': 'names it in a comment',
  };
  const reached = new Set(registry.apps.flatMap((app) => [...reachableFrom(workspace, `apps/${app.id}`)]));
  for (const file of filesNaming(String.raw`standalone\.json`)) {
    if (!file.startsWith('apps/') && !reached.has(file) && file !== 'site/app-shell.js') continue;
    assert.ok(Object.hasOwn(readers, file), `${file} reads the standalone catalog; check it reads only its own entry, then list it`);
  }
  for (const [file, pattern] of [['site/app-shell.js', /catalog\.(?!apps\[metadata\.id\])/], ['test-utils/standalone-dialog.mjs', /catalog\.(?!apps\[id\])/]]) {
    assert.doesNotMatch(await readFile(join(repoRoot, file), 'utf8'), pattern, `${file} reads more than its own entry`);
  }
});

// What `pnpm release` writes: changelogs, version-only manifests and the
// embedded version strings. None of it selects an app or the site build.
test('release bookkeeping selects nothing, even in shared packages', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const text = async (path) => readFile(join(repoRoot, path), 'utf8');
  const bump = async (path, edit = (manifest) => manifest) => {
    const before = await text(path);
    return [path, { before, after: JSON.stringify(edit({ ...JSON.parse(before), version: '9.9.20991231' }), null, 2) }];
  };
  const config = 'apps/n4/src/config.js';
  const configBefore = await text(config);
  const versioned = configBefore.replace(/(version: ")[^"]+(")/, '$19.9.20991231$2');
  assert.notEqual(versioned, configBefore);
  const manifests = new Map([
    await bump('packages/components/package.json'),
    await bump('packages/runtime-support/package.json'),
    await bump('apps/n4/package.json'),
    [config, { before: configBefore, after: versioned }],
  ]);
  const release = [...manifests.keys(), 'packages/components/CHANGELOG.md', 'apps/n4/CHANGELOG.md', '.changeset/n4-fix.md'];
  const plan = createAppPlan(registry, release, workspace, manifests);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
  assert.equal(plan.reasons.fallback, null);
  assert.deepEqual([...plan.bookkeeping].sort(), release.filter((path) => !path.startsWith('.changeset/')).sort());

  // Anything beyond the version keeps its usual reach.
  const code = new Map([...manifests, [config, { before: configBefore, after: `${versioned}// changed\n` }]]);
  assert.deepEqual(createAppPlan(registry, release, workspace, code).selected.map((app) => app.id), ['n4']);
  const dependency = new Map([...manifests, await bump('packages/components/package.json', (manifest) => ({ ...manifest, dependencies: { ...manifest.dependencies, added: '1.0.0' } }))]);
  assert.ok(createAppPlan(registry, release, workspace, dependency).allApps);
  // Without both texts a manifest is an ordinary code change.
  assert.ok(createAppPlan(registry, ['packages/components/package.json'], workspace).allApps);
  // release.yml publishes the apps a release's version bumps reach.
  const published = createAppPlan(registry, release, workspace, manifests, { release: true });
  assert.ok(published.allApps);
  assert.deepEqual(published.bookkeeping, []);
});

test('release.yml plans the apps to publish with version bumps counting', async () => {
  const flow = parse(await readFile(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
  const step = flow.jobs['app-plan'].steps.find((candidate) => candidate.id === 'plan');
  assert.match(step.run, /node scripts\/app-plan\.mjs --release --base "\$\{BASE_SHA:-HEAD~1\}" --head HEAD/);
});

test('a dispatched run tests what its branch changed since it left main, in the scope it asks for', async (t) => {
  const { root, run } = await plannerFixture(t);
  const registry = await loadAppsRegistry();
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  git('add', '.');
  git('commit', '--quiet', '-m', 'main');
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const gpuApp = registry.apps.find((app) => app.ci.hardware_gpu && app.ci.browser_test);
  await mkdir(join(root, 'apps', gpuApp.id), { recursive: true });
  await writeFile(join(root, 'apps', gpuApp.id, 'main.js'), '// branch change\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'branch');
  const plan = (...args) => {
    const result = run('--base', 'merge-base', '--head', 'HEAD', ...args);
    assert.equal(result.status, 0, result.stderr);
    return { outputs: JSON.parse(result.stdout), stderr: result.stderr };
  };
  const affected = plan();
  assert.deepEqual(JSON.parse(affected.outputs.selected_ids), [gpuApp.id]);
  assert.match(affected.stderr, /is where HEAD left main/);
  assert.equal(affected.outputs.has_apps, 'true');
  assert.equal(affected.outputs.has_gpu_apps, 'true');
  const gpu = plan('--scope', 'gpu').outputs;
  assert.deepEqual([gpu.has_apps, gpu.has_browser_apps, gpu.has_release_apps, gpu.has_site, gpu.has_gpu_apps], ['false', 'false', 'false', 'false', 'true']);
  assert.deepEqual(JSON.parse(gpu.gpu_apps).include.map(({ app }) => app), [gpuApp.id]);
  const site = plan('--scope', 'site').outputs;
  assert.deepEqual([site.has_apps, site.has_browser_apps, site.has_gpu_apps, site.has_site], ['false', 'false', 'false', 'true']);
  assert.notEqual(run('--base', 'merge-base', '--head', 'HEAD', '--scope', 'everything').status, 0);
  // On main itself there is nothing between it and its merge base: it plans from the tested base, like a push.
  git('update-ref', 'refs/remotes/origin/main', 'HEAD');
  const onMain = plan();
  assert.match(onMain.stderr, /last finished ci run on main is unknown|no successful ci run on main/);
  assert.equal(onMain.outputs.all_apps, 'true');
});

test('an app runs its @heavy browser tests only when the change edits it, a failed run left it untested or the run is full', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const heavy = (plan) => Object.fromEntries(plan.browserApps.include.map(({ app, heavy_tests: run }) => [app, run]));
  // A shared component every app loads reaches sdc and synthseg only through shared code.
  const shared = createAppPlan(registry, ['packages/components/src/styles/imaging-workspace.css'], workspace);
  assert.equal(heavy(shared).sdc, false);
  assert.equal(heavy(shared).synthseg, false);
  // Editing the app, its package or its exes directory runs them.
  for (const path of ['apps/sdc/src/main.js', 'packages/sdc/src/pipeline.js']) assert.equal(heavy(createAppPlan(registry, [path], workspace)).sdc, true, path);
  assert.equal(heavy(createAppPlan(registry, ['exes/synthseg/src/main.rs'], workspace)).synthseg, true);
  const both = heavy(createAppPlan(registry, ['packages/components/src/styles/imaging-workspace.css', 'apps/sdc/src/main.js'], workspace));
  assert.deepEqual([both.sdc, both.synthseg], [true, false]);
  // A failed run on main carried it, or the run is full.
  assert.equal(heavy(createAppPlan(registry, ['packages/components/src/styles/imaging-workspace.css'], workspace, new Map(), { carried: new Map([['sdc', ['browser-e2e (sdc)']]]) })).sdc, true);
  assert.ok(Object.values(heavy(createAppPlan(registry, [], workspace))).every(Boolean));
  // Release bookkeeping in the app's own directory is not an edit, and a diff of only bookkeeping is no full run.
  const changelog = heavy(createAppPlan(registry, ['packages/components/src/styles/imaging-workspace.css', 'apps/sdc/CHANGELOG.md'], workspace));
  assert.equal(changelog.sdc, false);
  const onlyBookkeeping = createAppPlan(registry, ['apps/sdc/CHANGELOG.md'], workspace, new Map(), { carried: new Map([['synthseg', ['browser-e2e (synthseg)']]]) });
  assert.deepEqual(heavy(onlyBookkeeping), { synthseg: true });
  // The tag is measured in the CPU job; the macOS GPU job runs every test.
  assert.ok(createAppPlan(registry, ['apps/sdc/src/main.js'], workspace).gpuApps.include.every((entry) => !('heavy_tests' in entry)));
});

test('pnpm-workspace.yaml narrows only for valid exact-version minimumReleaseAgeExclude relaxations and unlocked removals', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const before = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const parsed = parse(before);
  const withExclusion = before.replace(
    "  - '@niivue/nv-mcp@1.0.0-rc.7'\n",
    "  - '@niivue/nv-mcp@1.0.0-rc.7'\n  - '@example/fresh@1.2.3'\n",
  );
  assert.notEqual(withExclusion, before);
  const narrowed = createAppPlan(registry, ['pnpm-workspace.yaml'], workspace, new Map([['pnpm-workspace.yaml', { before, after: withExclusion }]]));
  assert.deepEqual(narrowed.selected, []);
  assert.equal(narrowed.site, false);
  assert.equal(narrowed.reasons.fallback, null);

  // Removing an exclusion whose package@version is still resolved in pnpm-lock.yaml
  // (or without a head lockfile) falls back because frozen install rechecks release age.
  const withoutBrainchop = before.replace("  - '@brainchop/core@1.0.0'\n", '');
  assert.notEqual(withoutBrainchop, before);
  assert.match(workspaceConfigImpact({ before, after: withoutBrainchop }).shared, /without a head lockfile/);
  const lockWithBrainchop = stringify({ lockfileVersion: '9.0', packages: { '@brainchop/core@1.0.0': {} } });
  assert.match(workspaceConfigImpact({ before, after: withoutBrainchop, lockAfter: lockWithBrainchop }).shared, /still resolved by pnpm-lock\.yaml/);
  const lockWithoutBrainchop = stringify({ lockfileVersion: '9.0', packages: { 'other@1.0.0': {} } });
  assert.deepEqual(workspaceConfigImpact({ before, after: withoutBrainchop, lockAfter: lockWithoutBrainchop }), { scoped: true });

  // Invalid specs, duplicates, other settings, YAML merge keys, and anchors/aliases fall back.
  for (const [label, edit] of [
    ['packages', (doc) => ({ ...doc, packages: [...doc.packages, 'extra/*'] })],
    ['allowBuilds', (doc) => ({ ...doc, allowBuilds: { ...doc.allowBuilds, esbuild: false } })],
    ['overrides', (doc) => ({ ...doc, overrides: { ...doc.overrides, pako: '2.1.1' } })],
    ['unknown key', (doc) => ({ ...doc, hoist: false })],
    ['non-string exclusion', (doc) => ({ ...doc, minimumReleaseAgeExclude: [123] })],
    ['non-exact latest tag', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, 'foo@latest'] })],
    ['leading-zero semver', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, 'foo@01.0.0'] })],
    ['leading-zero prerelease', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, 'foo@1.0.0-01'] })],
    ['overflowing semver', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, 'foo@99999999999999999999.1.0'] })],
    ['overlong padded semver', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, `foo@${' '.repeat(257)}1.0.0`] })],
    ['build metadata semver', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, '@brainchop/core@1.0.0+build'] })],
    ['semver range', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, 'foo@^1.0.0'] })],
    ['duplicate package name', (doc) => ({ ...doc, minimumReleaseAgeExclude: [...doc.minimumReleaseAgeExclude, 'foo@1.0.0', 'foo@2.0.0'] })],
  ]) {
    const after = stringify(edit(parsed));
    const fallback = createAppPlan(registry, ['pnpm-workspace.yaml'], workspace, new Map([['pnpm-workspace.yaml', { before, after }]]));
    assert.equal(fallback.allApps, true, label);
    assert.match(fallback.reasons.fallback, /^pnpm-workspace\.yaml:/, label);
  }
  // Overlong whitespace-padded version segment inside an otherwise in-place edit falls back.
  const paddedAfter = before.replace(
    "  - '@niivue/nv-mcp@1.0.0-rc.7'\n",
    `  - '@niivue/nv-mcp@1.0.0-rc.7'\n  - 'foo@${' '.repeat(257)}1.0.0'\n`,
  );
  assert.match(workspaceConfigImpact({ before, after: paddedAfter }).shared, /minimumReleaseAgeExclude/);
  // Reformatting or changing bytes outside minimumReleaseAgeExclude (including control characters
  // or quote changes that parsers handle differently) falls back.
  assert.match(workspaceConfigImpact({
    before: 'packages:\n  - apps/*\noverrides:\n  foo: "\\x01"\n',
    after: 'packages:\n  - apps/*\noverrides:\n  foo: "\x01"\n',
  }).shared, /control-character|control or non-ASCII/);
  assert.match(workspaceConfigImpact({
    before: 'packages:\n  - apps/*\noverrides:\n  foo: "a"\n',
    after: 'packages:\n  - apps/*\noverrides:\n  foo: "\x01"\n',
  }).shared, /control or non-ASCII/);
  assert.match(workspaceConfigImpact({
    before: "packages:\n  - apps/*\noverrides:\n  foo: '1.0.0'\n",
    after: 'packages:\n  - apps/*\noverrides:\n  foo: "1.0.0"\n',
  }).shared, /outside minimumReleaseAgeExclude/);
  const quotedMerge = 'packages:\n  - apps/*\n"<<":\n  recursiveInstall: false\n';
  const unquotedMerge = 'packages:\n  - apps/*\n<<:\n  recursiveInstall: false\n';
  assert.match(workspaceConfigImpact({ before: quotedMerge, after: unquotedMerge }).shared, /merge/);
  const yaml11OctalBefore = '%YAML 1.1\n---\npackages:\n  - apps/*\nminimumReleaseAge: 60\n';
  const yaml11OctalAfter = '%YAML 1.1\n---\npackages:\n  - apps/*\nminimumReleaseAge: 074\n';
  assert.match(workspaceConfigImpact({ before: yaml11OctalBefore, after: yaml11OctalAfter }).shared, /directives/);
  assert.match(workspaceConfigImpact({
    before: 'packages:\n  - apps/*\nminimumReleaseAge: 60\n',
    after: 'packages:\n  - apps/*\nminimumReleaseAge: 074\n',
  }).shared, /ambiguous numeric|setting changed/);
  // Unquoted ISO dates parse as Date objects under YAML 1.1 (js-yaml / pnpm) and strings under YAML 1.2.
  assert.match(workspaceConfigImpact({
    before: "packages:\n  - apps/*\noverrides:\n  foo: '2026-01-01'\n",
    after: 'packages:\n  - apps/*\noverrides:\n  foo: 2026-01-01\n',
  }).shared, /YAML 1\.1 and 1\.2/);
  const withAnchor = 'packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  - &pkg foo@1.0.0\n';
  assert.match(workspaceConfigImpact({ before, after: withAnchor }).shared, /anchors/);
  assert.match(workspaceConfigImpact({ before, after: 'packages:\n  - !!str apps/*\n' }).shared, /tags/);
  assert.match(workspaceConfigImpact({ before, after: ': bad: [yaml' }).shared, /does not parse/);
  assert.match(workspaceConfigImpact({ before, after: '- list\n' }).shared, /not a block YAML mapping/);
  // Without before/after texts, pnpm-workspace.yaml falls back conservatively.
  assert.equal(createAppPlan(registry, ['pnpm-workspace.yaml'], workspace).allApps, true);
});

test('scripts/lib/e2e-test-data.mjs narrows to apps whose pure provisioner entries changed', async () => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const before = await readFile(new URL('../scripts/lib/e2e-test-data.mjs', import.meta.url), 'utf8');

  // Modifying one app's provisioner selects only that app without forcing siteCode.
  const editDenoise = before.replace(
    'denoise: { env: [], provision: async () => ({}) },',
    "denoise: { env: ['DENOISE_FLAG'], provision: async () => ({ DENOISE_FLAG: '1' }) },",
  );
  assert.notEqual(editDenoise, before);
  const denoisePlan = createAppPlan(registry, ['scripts/lib/e2e-test-data.mjs'], workspace, new Map([['scripts/lib/e2e-test-data.mjs', { before, after: editDenoise }]]));
  assert.deepEqual(denoisePlan.selected.map((app) => app.id), ['denoise']);
  assert.equal(denoisePlan.siteCode, false);
  assert.equal(denoisePlan.reasons.fallback, null);
  assert.equal(denoisePlan.browserApps.include.every(({ heavy_tests: run }) => run), true, 'scoped provisioner edit runs @heavy tests');

  // Changing NODDI's reference provisioner selects noddi with heavy_tests: true so @heavy reference.spec.js runs,
  // including when combined with a shared fallback change in the same diff.
  const editNoddi = before.replace("NODDI_BROWSER_REFERENCE: 'check'", "NODDI_BROWSER_REFERENCE: 'write'");
  assert.notEqual(editNoddi, before);
  const noddiPlan = createAppPlan(registry, ['scripts/lib/e2e-test-data.mjs'], workspace, new Map([['scripts/lib/e2e-test-data.mjs', { before, after: editNoddi }]]));
  assert.deepEqual(noddiPlan.selected.map((app) => app.id), ['noddi']);
  assert.equal(noddiPlan.browserApps.include.every(({ heavy_tests: run }) => run), true, 'noddi provisioner edit runs @heavy browser reference');
  const wsBefore = await readFile(new URL('../pnpm-workspace.yaml', import.meta.url), 'utf8');
  const combinedFallback = createAppPlan(
    registry,
    ['scripts/lib/e2e-test-data.mjs', 'pnpm-workspace.yaml'],
    workspace,
    new Map([
      ['scripts/lib/e2e-test-data.mjs', { before, after: editNoddi }],
      ['pnpm-workspace.yaml', { before: wsBefore, after: `${wsBefore}minimumReleaseAge: 2880\n` }],
    ]),
  );
  assert.equal(combinedFallback.allApps, true);
  assert.equal(
    combinedFallback.browserApps.include.filter(({ app }) => app === 'noddi').every(({ heavy_tests: run }) => run),
    true,
    'noddi keeps heavy_tests: true even when another file triggers full-catalog fallback',
  );

  // Removing a provisioner entry selects only that app.
  const removeDenoise = before.replace('  denoise: { env: [], provision: async () => ({}) },\n', '');
  assert.deepEqual(e2eTestDataImpact({ before, after: removeDenoise }), { changed: ['denoise'] });

  // Editing only plain-string unpublished reasons selects no apps (workspace-contracts tests it).
  const editUnpublished = before.replace(
    "TOPOFIT_SURFACE_REPLAY: 'OpenRecon validation surfaces, not licensed for release',",
    "TOPOFIT_SURFACE_REPLAY: 'OpenRecon validation surfaces, not licensed for release',\n  NEW_UNPUBLISHED: 'not public',",
  );
  const unpublishedPlan = createAppPlan(registry, ['scripts/lib/e2e-test-data.mjs'], workspace, new Map([['scripts/lib/e2e-test-data.mjs', { before, after: editUnpublished }]]));
  assert.deepEqual(unpublishedPlan.selected, []);
  assert.equal(unpublishedPlan.site, false);

  // Shared helper edits, load-time side effects, TDZ hazards, strict ESM errors, prototype setters, and syntax errors fall back.
  for (const [label, after] of [
    ['shared helper', before.replace('const flag = (name) => ({ env: [name], provision: async () => ({ [name]: \'1\' }) });', 'const flag = (name) => ({ env: [name], provision: async () => ({ [name]: \'2\' }) });')],
    ['strict ESM duplicate params', before.replace('denoise: { env: [], provision: async () => ({}) },', 'denoise: { env: [], provision: (x, x) => x },')],
    ['side-effectful provisioner initializer', before.replace('denoise: { env: [], provision: async () => ({}) },', 'denoise: (globalThis.fetch = undefined, { env: [], provision: async () => ({}) }),')],
    ['side-effectful unpublished value', before.replace("TOPOFIT_SURFACE_REPLAY: 'OpenRecon validation surfaces, not licensed for release',", "TOPOFIT_SURFACE_REPLAY: (globalThis.fetch = undefined, 'reason'),")],
    ['prototype setter in provisioners', before.replace('denoise: { env: [], provision: async () => ({}) },', 'denoise: { env: [], provision: async () => ({}) },\n  __proto__: { env: [], provision: async () => ({}) },')],
    ['prototype setter in unpublished', before.replace("TOPOFIT_SURFACE_REPLAY: 'OpenRecon validation surfaces, not licensed for release',", "TOPOFIT_SURFACE_REPLAY: 'OpenRecon validation surfaces, not licensed for release',\n  __proto__: 'mutated',")],
    ['arbitrary call in provisioners', before.replace('denoise: { env: [], provision: async () => ({}) },', "denoise: run('echo', ['hi']),")],
    ['non-literal env element', before.replace('denoise: { env: [], provision: async () => ({}) },', 'denoise: { env: [root], provision: async () => ({}) },')],
    ['spread element', before.replace('denoise: { env: [], provision: async () => ({}) },', '...extraProvisioners,')],
    ['computed key', before.replace('denoise: { env: [], provision: async () => ({}) },', '[dynamicId]: { env: [], provision: async () => ({}) },')],
    ['self-reference', before.replace('denoise: { env: [], provision: async () => ({}) },', 'denoise: { env: [], provision: async (c) => provisioners.sdc.provision(c) },')],
    ['syntax error', `${before}\nexport const broken = (`],
  ]) {
    const fallback = createAppPlan(registry, ['scripts/lib/e2e-test-data.mjs'], workspace, new Map([['scripts/lib/e2e-test-data.mjs', { before, after }]]));
    assert.equal(fallback.allApps, true, label);
    assert.match(fallback.reasons.fallback, /^scripts\/lib\/e2e-test-data\.mjs:/, label);
  }
  // A const function declared after `export const provisioners` is a TDZ ReferenceError at import time.
  const tdzBefore = 'export const provisioners = { denoise: { env: [], provision: async () => ({}) } };\nconst laterFn = async () => ({});\n';
  const tdzAfter = 'export const provisioners = { denoise: { env: [], provision: laterFn } };\nconst laterFn = async () => ({});\n';
  assert.match(e2eTestDataImpact({ before: tdzBefore, after: tdzAfter }).shared, /cannot be isolated safely/);
  // A named provisioner helper that reads another app's table entry hides a cross-app dependency and falls back.
  const crossHelperBefore = [
    'async function runBeta() { return { X: provisioners.alpha.env[0] }; }',
    'export const provisioners = {',
    "  alpha: { env: ['A'], provision: async () => ({ A: '1' }) },",
    '  beta: { env: [\'X\'], provision: runBeta },',
    '};',
  ].join('\n');
  const crossHelperAfter = crossHelperBefore.replace("env: ['A']", "env: ['B']");
  assert.match(e2eTestDataImpact({ before: crossHelperBefore, after: crossHelperAfter }).shared, /cannot be isolated safely/);
  // A provisionTestData dispatcher that falls back to another app's entry hides a cross-app dependency and falls back.
  const crossDispatchBefore = [
    'export const provisioners = {',
    "  denoise: { env: ['A'], provision: async () => ({ A: '1' }) },",
    '};',
    'export async function provisionTestData(app, cache) {',
    '  const provisioner = provisioners[app] ?? provisioners.denoise;',
    '  return provisioner.provision(cache);',
    '}',
  ].join('\n');
  const crossDispatchAfter = crossDispatchBefore.replace("A: '1'", "A: '2'");
  assert.match(e2eTestDataImpact({ before: crossDispatchBefore, after: crossDispatchAfter }).shared, /cannot be isolated safely/);
  // Destructuring assignment redirecting `app` inside provisionTestData also falls back.
  const destructDispatchBefore = [
    'export const provisioners = {',
    "  denoise: { env: ['A'], provision: async () => ({ A: '1' }) },",
    '};',
    'export async function provisionTestData(app, cache) {',
    "  [app] = ['denoise'];",
    '  const provisioner = provisioners[app];',
    '  return provisioner ? provisioner.provision(cache) : {};',
    '}',
  ].join('\n');
  const destructDispatchAfter = destructDispatchBefore.replace("A: '1'", "A: '2'");
  assert.match(e2eTestDataImpact({ before: destructDispatchBefore, after: destructDispatchAfter }).shared, /cannot be isolated safely/);
  // Class declaration shadowing `app` inside provisionTestData also falls back.
  const classDispatchBefore = [
    'export const provisioners = {',
    "  denoise: { env: ['A'], provision: async () => ({ A: '1' }) },",
    '};',
    'export async function provisionTestData(app, cache) {',
    "  class app { static [Symbol.toPrimitive]() { return 'denoise'; } }",
    '  return provisioners[app].provision(cache);',
    '}',
  ].join('\n');
  const classDispatchAfter = classDispatchBefore.replace("A: '1'", "A: '2'");
  assert.match(e2eTestDataImpact({ before: classDispatchBefore, after: classDispatchAfter }).shared, /cannot be isolated safely/);
  // A provisioner delegating to another app via provisionTestData('denoise') falls back.
  const delegateBefore = [
    'export const provisioners = {',
    "  denoise: { env: ['A'], provision: async () => ({ A: '1' }) },",
    "  sdc: { env: ['A'], provision: async (cache) => provisionTestData('denoise', cache) },",
    '};',
    'export async function provisionTestData(app, cache) {',
    '  const provisioner = provisioners[app];',
    '  return provisioner ? provisioner.provision(cache) : {};',
    '}',
  ].join('\n');
  const delegateAfter = delegateBefore.replace("A: '1'", "A: '2'");
  assert.match(e2eTestDataImpact({ before: delegateBefore, after: delegateAfter }).shared, /cannot be isolated safely/);
});

test('per-app CI scripts resolve exact .json data paths without dragging in whole workspace directories, while preserving package directory loads', async (t) => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  // scripts/lib/e2e-test-data.mjs reads exes/dwi/dmipy/validation/reference.manifest.json;
  // SCRIPT_REFERENCE must resolve that exact .json file (not truncate .json to .js and fall
  // back to the whole exes/dwi directory, which would pull mindgrab-asset-path-plugin.mjs into CATALOG).
  const pluginPlan = createAppPlan(registry, ['scripts/lib/mindgrab-asset-path-plugin.mjs'], workspace);
  assert.equal(pluginPlan.reasons.fallback, null);
  assert.equal(pluginPlan.allApps, false);
  assert.ok(pluginPlan.selected.some((app) => app.id === 'sdc'));
  assert.ok(pluginPlan.selected.some((app) => app.id === 'brainchop'));
  assert.ok(!pluginPlan.selected.some((app) => app.id === 'niimath'));
  assert.ok(!pluginPlan.selected.some((app) => app.id === 'stardist'));

  // Direct per-app CI helpers still select the complete catalog.
  for (const path of ['scripts/e2e-test-data.mjs', 'scripts/probe-hardware-gpu.mjs', 'test-utils/hardware-gpu.mjs', 'scripts/desktop/scientific-evidence.mjs', 'test-utils/dwi-tracking-crop.mjs']) {
    assert.equal(createAppPlan(registry, [path], workspace).allApps, true, path);
  }

  // Real workspace graph fixture verifying exact .json data paths stay isolated while
  // package directory references (require, destructured module.require, subprocess exec)
  // still traverse into the package and its root helpers.
  const root = await mkdtemp(join(tmpdir(), 'neurodesk-catalog-imports-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'root', scripts: {} }),
    '.github/workflows/ci.yml': stringify({
      jobs: {
        'composite-site': { steps: [{ run: 'echo site' }] },
        'app-tests': { steps: [{ run: 'node scripts/cli.mjs' }] },
        'browser-e2e': { steps: [{ run: 'echo e2e' }] },
        'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
      },
    }),
    'scripts/cli.mjs': [
      "const { require: load } = module;",
      "load.call(module, '../packages/rel-req');",
      "execFileSync(process.execPath, ['packages/subproc']);",
      "readFileSync(join(root, 'exes/data-only/nested/reference.manifest.json'), 'utf8');",
    ].join('\n'),
    'packages/rel-req/package.json': JSON.stringify({ name: '@nd/rel-req' }),
    'packages/rel-req/index.js': "import '../../scripts/from-rel-req.mjs';\n",
    'packages/subproc/package.json': JSON.stringify({ name: '@nd/subproc' }),
    'packages/subproc/index.js': "import '../../scripts/from-subproc.mjs';\n",
    'exes/data-only/nested/reference.manifest.json': '{}',
    'exes/data-only/tool.js': "import '../../scripts/from-data-only.mjs';\n",
    'scripts/from-rel-req.mjs': '',
    'scripts/from-subproc.mjs': '',
    'scripts/from-data-only.mjs': '',
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const fixtureGraph = await loadConservativeWorkspaceGraph(root);
  const reached = reachableFrom(fixtureGraph, CATALOG);
  assert.equal(reached.has('scripts/from-rel-req.mjs'), true, 'destructured module.require("../packages/rel-req")');
  assert.equal(reached.has('scripts/from-subproc.mjs'), true, 'subprocess exec packages/subproc');
  assert.equal(reached.has('exes/data-only/nested/reference.manifest.json'), true, 'exact .json manifest edge');
  assert.equal(reached.has('scripts/from-data-only.mjs'), false, 'exact .json reference does not pull in exes/data-only code');

  // Prefix collisions (.json.gz, spaces in quoted names), symlinks, and directories named *.json
  // must retain the whole workspace-directory edge rather than narrowing to a misleading prefix or link.
  const prefixRoot = await mkdtemp(join(tmpdir(), 'neurodesk-json-prefix-'));
  t.after(() => rm(prefixRoot, { recursive: true, force: true }));
  const prefixFiles = {
    'package.json': JSON.stringify({ name: 'root', scripts: {} }),
    '.github/workflows/ci.yml': stringify({
      jobs: {
        'composite-site': { steps: [{ run: 'node scripts/site.mjs' }] },
        'app-tests': { steps: [{ run: 'node scripts/app-ci.mjs' }] },
        'browser-e2e': { steps: [{ run: 'echo e2e' }] },
        'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
      },
    }),
    'scripts/site.mjs': [
      "const archive = 'exes/data/reference.json.gz';",
      "const spaced = 'exes/spaced/reference.json archive';",
      "const computed = 'exes/computed/reference.json' + '.gz';",
      "const commented = 'exes/commented/reference.json' /* archive suffix */ + '.gz';",
      "const conditional = (process.env.ALT ? 'exes/conditional/alternate.json' : 'exes/conditional/reference.json') + '.gz';",
      "const viaObj = ({ file: 'exes/objprop/reference.json' }).file + '.gz';",
      "const storedBase = resolve('exes/stored/reference.json'); readFileSync(storedBase + '.gz');",
      "readFileSync(join(resolve('exes/nested/anchor.json'), '..', 'actual.json'));",
      "function anchor() { return resolve('exes/returned/anchor.json'); } readFileSync(join(anchor(), '..', 'actual.json'));",
      "import { exportedAnchor } from './exported-anchor.mjs'; readFileSync(join(exportedAnchor, '..', 'actual.json'));",
      "readFileSync(JSON.parse(readFileSync('exes/indirect/path.json', 'utf8')));",
      "const splitPath = JSON.parse(readFileSync('exes/split-indirect/path.json', 'utf8')); readFileSync(splitPath);",
      "const linked = 'exes/linked/fixture.json';",
    ].join('\n'),
    'scripts/exported-anchor.mjs': "export const exportedAnchor = resolve('exes/exported/anchor.json');\n",
    'scripts/app-ci.mjs': [
      "const mod = require('../packages/pkg/fixture.json');",
      "const rootTarget = JSON.parse(readFileSync('exes/config/path.json', 'utf8')); readFileSync(rootTarget);",
    ].join('\n'),
    'exes/config/path.json': '"scripts/runtime-input.mjs"',
    'scripts/runtime-input.mjs': 'export const ok = true;\n',
    'exes/data/reference.json': '{}',
    'exes/data/reference.json.gz': 'compressed',
    'exes/spaced/reference.json': '{}',
    'exes/spaced/reference.json archive': 'actual',
    'exes/computed/reference.json': '{}',
    'exes/computed/reference.json.gz': 'computed',
    'exes/commented/reference.json': '{}',
    'exes/commented/reference.json.gz': 'commented',
    'exes/conditional/alternate.json': '{}',
    'exes/conditional/reference.json': '{}',
    'exes/conditional/reference.json.gz': 'conditional',
    'exes/objprop/reference.json': '{}',
    'exes/objprop/reference.json.gz': 'objprop',
    'exes/stored/reference.json': '{}',
    'exes/stored/reference.json.gz': 'stored',
    'exes/nested/anchor.json': '{}',
    'exes/nested/actual.json': '{"actual":true}',
    'exes/returned/anchor.json': '{}',
    'exes/returned/actual.json': '{"returned":true}',
    'exes/exported/anchor.json': '{}',
    'exes/exported/actual.json': '{"exported":true}',
    'exes/indirect/path.json': '"exes/indirect/actual.json"',
    'exes/indirect/actual.json': '{"indirect":true}',
    'exes/split-indirect/path.json': '"exes/split-indirect/actual.json"',
    'exes/split-indirect/actual.json': '{"split":true}',
    'exes/linked/target.json': '{"real":true}',
    'packages/pkg/package.json': JSON.stringify({ name: '@nd/pkg' }),
    'packages/pkg/fixture.json/index.js': "import '../../../scripts/from-dir-json.mjs';\n",
    'scripts/from-dir-json.mjs': '',
  };
  for (const [path, text] of Object.entries(prefixFiles)) {
    await mkdir(dirname(join(prefixRoot, path)), { recursive: true });
    await writeFile(join(prefixRoot, path), text);
  }
  await symlink('target.json', join(prefixRoot, 'exes/linked/fixture.json'));
  const prefixGraph = await loadConservativeWorkspaceGraph(prefixRoot);
  assert.equal(createAppPlan(registry, ['exes/data/reference.json.gz'], prefixGraph).site, true, '.json.gz keeps exes/data edge');
  assert.equal(createAppPlan(registry, ['exes/spaced/reference.json archive'], prefixGraph).site, true, 'quoted filename with space keeps exes/spaced edge');
  assert.equal(createAppPlan(registry, ['exes/computed/reference.json.gz'], prefixGraph).site, true, 'computed path concatenation keeps exes/computed edge');
  assert.equal(createAppPlan(registry, ['exes/commented/reference.json.gz'], prefixGraph).site, true, 'commented path concatenation keeps exes/commented edge');
  assert.equal(createAppPlan(registry, ['exes/conditional/reference.json.gz'], prefixGraph).site, true, 'conditional inside computed path keeps exes/conditional edge');
  assert.equal(createAppPlan(registry, ['exes/objprop/reference.json.gz'], prefixGraph).site, true, 'object-property computed path keeps exes/objprop edge');
  assert.equal(createAppPlan(registry, ['exes/stored/reference.json.gz'], prefixGraph).site, true, 'stored resolve() result concatenated later keeps exes/stored edge');
  assert.equal(createAppPlan(registry, ['exes/nested/actual.json'], prefixGraph).site, true, 'nested join(resolve(anchor.json), .., actual.json) keeps exes/nested edge');
  assert.equal(createAppPlan(registry, ['exes/returned/actual.json'], prefixGraph).site, true, 'returned resolve(anchor.json) keeps exes/returned edge');
  assert.equal(createAppPlan(registry, ['exes/exported/actual.json'], prefixGraph).site, true, 'exported resolve(anchor.json) keeps exes/exported edge');
  assert.equal(createAppPlan(registry, ['exes/indirect/actual.json'], prefixGraph).site, true, 'nested readFileSync(JSON.parse(readFileSync(path.json))) keeps exes/indirect edge');
  assert.equal(createAppPlan(registry, ['exes/split-indirect/actual.json'], prefixGraph).site, true, 'split-statement JSON indirect read keeps exes/split-indirect edge');
  assert.equal(createAppPlan(registry, ['exes/linked/target.json'], prefixGraph).site, true, 'symlink keeps exes/linked edge');
  assert.equal(reachableFrom(prefixGraph, CATALOG).has('scripts/from-dir-json.mjs'), true, 'directory named fixture.json keeps packages/pkg edge');
  assert.equal(createAppPlan(registry, ['scripts/runtime-input.mjs'], prefixGraph).allApps, true, 'split JSON read targeting scripts/runtime-input.mjs reaches CATALOG');
});

test('lint runner and scripts/quality files select nothing when unreached, and honor confirmed CI or app reachability', async (t) => {
  const registry = await loadAppsRegistry();
  const workspace = await graph;
  const plan = createAppPlan(registry, [
    'scripts/lint.mjs',
    'scripts/quality/lint-inventory.mjs',
    'scripts/quality/lint-baseline.json',
    'scripts/quality/typed-projects.mjs',
  ], workspace);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
  assert.equal(plan.reasons.fallback, null);
  // Without a workspace graph, lint tooling cannot be proven unreached and falls back.
  assert.equal(createAppPlan(registry, ['scripts/quality/lint-inventory.mjs']).allApps, true);

  // If a CI job or an app directly reaches scripts/quality/*, the plan honors that edge.
  const root = await mkdtemp(join(tmpdir(), 'neurodesk-quality-reach-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const files = {
    'package.json': JSON.stringify({ name: 'root', scripts: {} }),
    '.github/workflows/ci.yml': stringify({
      jobs: {
        'composite-site': { steps: [{ run: 'node scripts/site.mjs' }] },
        'app-tests': { steps: [{ run: 'node scripts/ci.mjs' }] },
        'browser-e2e': { steps: [{ run: 'echo e2e' }] },
        'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
      },
    }),
    'scripts/ci.mjs': "import './quality/catalog-helper.mjs';\n",
    'scripts/site.mjs': "import './quality/site-helper.mjs';\n",
    'scripts/quality/catalog-helper.mjs': 'export const a = 1;\n',
    'scripts/quality/site-helper.mjs': 'export const b = 2;\n',
    'scripts/quality/app-helper.mjs': 'export const c = 3;\n',
    'scripts/lint.mjs': 'export const lint = 1;\n',
    'apps/niimath/main.js': "import '../../scripts/quality/app-helper.mjs';\n",
    'apps/denoise/main.js': "import '../../scripts/lint.mjs';\n",
    'apps/n4/package.json': JSON.stringify({ name: '@nd/n4', scripts: { build: 'vite build', lint: 'node ../../scripts/lint.mjs --workspace' } }),
    'apps/sdc/package.json': JSON.stringify({ name: '@nd/sdc', scripts: { build: 'pnpm lint && vite build', lint: 'node ../../scripts/lint.mjs --workspace' } }),
  };
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  const fixtureGraph = await loadConservativeWorkspaceGraph(root);
  assert.equal(createAppPlan(registry, ['scripts/quality/catalog-helper.mjs'], fixtureGraph).allApps, true, 'CATALOG reachability');
  assert.equal(createAppPlan(registry, ['scripts/quality/site-helper.mjs'], fixtureGraph).site, true, 'SITE reachability');
  assert.deepEqual(
    createAppPlan(registry, ['scripts/quality/app-helper.mjs'], fixtureGraph).selected.map((app) => app.id),
    ['niimath'],
    'direct app reachability to scripts/quality',
  );
  assert.deepEqual(
    createAppPlan(registry, ['scripts/lint.mjs'], fixtureGraph).selected.map((app) => app.id).sort(),
    ['denoise', 'sdc'],
    'direct app import and build-invoked lint select their apps while standalone lint script stays exempt',
  );

  // If a CI job invokes a workspace lint script via a root script (`pnpm --filter @nd/n4 lint`),
  // that lint command is not stripped and reaches scripts/lint.mjs and scripts/quality/*.
  const siteLintRoot = await mkdtemp(join(tmpdir(), 'neurodesk-site-lint-'));
  t.after(() => rm(siteLintRoot, { recursive: true, force: true }));
  const siteLintFiles = {
    'package.json': JSON.stringify({ name: 'root', scripts: { 'build:site': 'pnpm --filter @nd/n4 lint' } }),
    '.github/workflows/ci.yml': stringify({
      jobs: {
        'composite-site': { steps: [{ run: 'pnpm build:site' }] },
        'app-tests': { steps: [{ run: 'echo tests' }] },
        'browser-e2e': { steps: [{ run: 'echo e2e' }] },
        'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
      },
    }),
    'scripts/lint.mjs': "import './quality/helper.mjs';\n",
    'scripts/quality/helper.mjs': 'export const h = 1;\n',
    'apps/n4/package.json': JSON.stringify({ name: '@nd/n4', scripts: { lint: 'node ../../scripts/lint.mjs --workspace' } }),
  };
  for (const [path, text] of Object.entries(siteLintFiles)) {
    await mkdir(dirname(join(siteLintRoot, path)), { recursive: true });
    await writeFile(join(siteLintRoot, path), text);
  }
  const siteLintGraph = await loadConservativeWorkspaceGraph(siteLintRoot);
  assert.equal(createAppPlan(registry, ['scripts/lint.mjs'], siteLintGraph).site, true, 'CI-invoked workspace lint selects site on runner change');
  assert.equal(createAppPlan(registry, ['scripts/quality/helper.mjs'], siteLintGraph).site, true, 'CI-invoked workspace lint selects site on quality helper change');

  // Cross-workspace lint from an app build, recursive CI lint (`pnpm -r run lint`), and equals-form
  // `--filter=@nd/lint-target run lint` all propagate edges to their calling apps / CI jobs.
  for (const [label, patch, changedPath, caseManifests, check] of [
    [
      'app cross-workspace lint',
      {
        'apps/sdc/package.json': JSON.stringify({ name: '@nd/sdc', scripts: { build: 'pnpm --filter @nd/lint-target lint' } }),
        'packages/lint-target/package.json': JSON.stringify({ name: '@nd/lint-target', scripts: { lint: 'node ../../scripts/quality/helper.mjs' } }),
      },
      'scripts/quality/helper.mjs',
      new Map(),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id), ['sdc']),
    ],
    [
      'recursive CI lint',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'pnpm -r run lint' }] },
            'app-tests': { steps: [{ run: 'echo tests' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'packages/lint-target/package.json': JSON.stringify({ name: '@nd/lint-target', scripts: { lint: 'node ../../scripts/quality/helper.mjs' } }),
      },
      'scripts/quality/helper.mjs',
      new Map(),
      (plan) => assert.equal(plan.site, true),
    ],
    [
      'equals-form filter in app-tests',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'echo site' }] },
            'app-tests': { steps: [{ run: 'pnpm --filter=@nd/lint-target run lint' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'packages/lint-target/package.json': JSON.stringify({ name: '@nd/lint-target', scripts: { lint: 'node ../../scripts/quality/helper.mjs' } }),
      },
      'scripts/quality/helper.mjs',
      new Map(),
      (plan) => assert.equal(plan.allApps, true),
    ],
    [
      'explicitly linted workspace package internal file in app-tests',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'echo site' }] },
            'app-tests': { steps: [{ run: 'pnpm --filter @nd/second lint' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'packages/second/package.json': JSON.stringify({ name: '@nd/second', scripts: { lint: 'node lint.mjs' } }),
        'packages/second/lint.mjs': 'console.log(1);\n',
      },
      'packages/second/lint.mjs',
      new Map(),
      (plan) => assert.equal(plan.allApps, true),
    ],
    [
      'chained lint-to-lint cross-workspace call in app-tests',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'echo site' }] },
            'app-tests': { steps: [{ run: 'pnpm --filter @nd/first lint' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'packages/first/package.json': JSON.stringify({ name: '@nd/first', scripts: { lint: 'pnpm --filter @nd/second run lint' } }),
        'packages/second/package.json': JSON.stringify({ name: '@nd/second', scripts: { lint: 'node ../../scripts/quality/helper.mjs' } }),
      },
      'scripts/quality/helper.mjs',
      new Map(),
      (plan) => assert.equal(plan.allApps, true),
    ],
    [
      'explicitly linted app file in app-tests',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'echo site' }] },
            'app-tests': { steps: [{ run: 'pnpm --filter @nd/sdc lint' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'apps/sdc/package.json': JSON.stringify({ name: '@nd/sdc', scripts: { lint: 'node lint.mjs' } }),
        'apps/sdc/lint.mjs': 'console.log(1);\n',
      },
      'apps/sdc/lint.mjs',
      new Map(),
      (plan) => assert.equal(plan.allApps, true),
    ],
    [
      'explicitly linted package lockfile update in app-tests',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'echo site' }] },
            'app-tests': { steps: [{ run: 'pnpm --filter @nd/second lint' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'packages/second/package.json': JSON.stringify({ name: '@nd/second', scripts: { lint: 'node lint.mjs' } }),
        'packages/second/lint.mjs': 'console.log(1);\n',
      },
      'pnpm-lock.yaml',
      new Map([[
        'pnpm-lock.yaml',
        {
          before: stringify({
            lockfileVersion: '9.0',
            importers: { 'packages/second': { dependencies: { foo: { specifier: '^1.0.0', version: '1.0.0' } } } },
            packages: { 'foo@1.0.0': { resolution: { integrity: 'sha512-old' } } },
            snapshots: { 'foo@1.0.0': {} },
          }),
          after: stringify({
            lockfileVersion: '9.0',
            importers: { 'packages/second': { dependencies: { foo: { specifier: '^1.0.0', version: '1.0.1' } } } },
            packages: { 'foo@1.0.1': { resolution: { integrity: 'sha512-new' } } },
            snapshots: { 'foo@1.0.1': {} },
          }),
        },
      ]]),
      (plan) => {
        assert.equal(plan.allApps, true);
        assert.match(plan.reasons.fallback, /ci\.yml's per-app jobs run packages\/second/);
      },
    ],
    [
      'app build invokes another app lint script',
      {
        'apps/niimath/package.json': JSON.stringify({ name: '@nd/niimath', scripts: { build: 'pnpm --filter @nd/sdc lint' } }),
        'apps/sdc/package.json': JSON.stringify({ name: '@nd/sdc', scripts: { lint: 'node lint.mjs' } }),
        'apps/sdc/lint.mjs': 'console.log(1);\n',
      },
      'apps/sdc/lint.mjs',
      new Map(),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id).sort(), ['niimath', 'sdc']),
    ],
    [
      'app build invokes another app lint script via root script (`pnpm -w run`)',
      {
        'package.json': JSON.stringify({ name: 'root', scripts: { 'verify-style': 'pnpm --filter @nd/sdc lint' } }),
        'apps/niimath/package.json': JSON.stringify({ name: '@nd/niimath', scripts: { build: 'pnpm -w run verify-style' } }),
        'apps/sdc/package.json': JSON.stringify({ name: '@nd/sdc', scripts: { lint: 'node lint.mjs' } }),
        'apps/sdc/lint.mjs': 'console.log(1);\n',
      },
      'apps/sdc/lint.mjs',
      new Map(),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id).sort(), ['niimath', 'sdc']),
    ],
    [
      'editing a root script invoked by an app selects that app',
      {
        'package.json': JSON.stringify({ name: 'root', scripts: { 'verify-style': 'node scripts/ok.mjs' } }),
        'apps/niimath/package.json': JSON.stringify({ name: '@nd/niimath', scripts: { build: 'pnpm -w run verify-style' } }),
      },
      'package.json',
      new Map([
        ['package.json', {
          before: JSON.stringify({ name: 'root', scripts: { 'verify-style': 'node scripts/ok.mjs' } }),
          after: JSON.stringify({ name: 'root', scripts: { 'verify-style': 'node scripts/fail.mjs' } }),
        }],
        ['pnpm-lock.yaml', {
          before: stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }),
          after: stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }),
        }],
      ]),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']),
    ],
    [
      'editing a dotted root script invoked by an app selects that app',
      {
        'package.json': JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node scripts/ok.mjs' } }),
        'apps/niimath/package.json': JSON.stringify({ name: '@nd/niimath', scripts: { build: 'pnpm -w run verify.style' } }),
      },
      'package.json',
      new Map([
        ['package.json', {
          before: JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node scripts/ok.mjs' } }),
          after: JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node scripts/fail.mjs' } }),
        }],
        ['pnpm-lock.yaml', {
          before: stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }),
          after: stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }),
        }],
      ]),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']),
    ],
    [
      'editing a quoted dotted root script invoked by an app selects that app',
      {
        'package.json': JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node scripts/ok.mjs' } }),
        'apps/niimath/package.json': JSON.stringify({ name: '@nd/niimath', scripts: { build: "pnpm -w run 'verify.style'" } }),
      },
      'package.json',
      new Map([
        ['package.json', {
          before: JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node scripts/ok.mjs' } }),
          after: JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node scripts/fail.mjs' } }),
        }],
        ['pnpm-lock.yaml', {
          before: stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }),
          after: stringify({ lockfileVersion: '9.0', importers: { '.': {} }, packages: {}, snapshots: {} }),
        }],
      ]),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']),
    ],
    [
      'editing an exes/ script invoked by an expanded root script selects the calling app',
      {
        'package.json': JSON.stringify({ name: 'root', scripts: { 'verify.style': 'node exes/check/style.mjs' } }),
        'apps/niimath/package.json': JSON.stringify({ name: '@nd/niimath', scripts: { build: 'pnpm -w run verify.style' } }),
        'exes/check/style.mjs': 'console.log(1);\n',
      },
      'exes/check/style.mjs',
      new Map(),
      (plan) => assert.deepEqual(plan.selected.map((app) => app.id), ['niimath']),
    ],
    [
      'one explicit CI lint target does not restore unrelated apps standalone lint edges',
      {
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'pnpm --filter @nd/sdc lint' }] },
            'app-tests': { steps: [{ run: 'echo tests' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'scripts/lint.mjs': 'export const lint = 1;\n',
        'apps/sdc/package.json': JSON.stringify({ name: '@nd/sdc', scripts: { lint: 'node ../../scripts/lint.mjs --workspace' } }),
        'apps/n4/package.json': JSON.stringify({ name: '@nd/n4', scripts: { build: 'echo n4', lint: 'node ../../scripts/lint.mjs --workspace' } }),
      },
      'scripts/lint.mjs',
      new Map(),
      (plan) => {
        assert.equal(plan.site, true);
        assert.deepEqual(plan.selected.map((app) => app.id), ['sdc']);
      },
    ],
    [
      'pnpm -w run lint in composite-site',
      {
        'package.json': JSON.stringify({ name: 'root', scripts: { lint: 'node scripts/quality/root.mjs' } }),
        '.github/workflows/ci.yml': stringify({
          jobs: {
            'composite-site': { steps: [{ run: 'pnpm -w run lint' }] },
            'app-tests': { steps: [{ run: 'echo tests' }] },
            'browser-e2e': { steps: [{ run: 'echo e2e' }] },
            'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
          },
        }),
        'scripts/quality/root.mjs': 'console.log(1);\n',
      },
      'scripts/quality/root.mjs',
      new Map(),
      (plan) => assert.equal(plan.site, true),
    ],
  ]) {
    const caseRoot = await mkdtemp(join(tmpdir(), 'neurodesk-cross-lint-'));
    t.after(() => rm(caseRoot, { recursive: true, force: true }));
    const caseFiles = {
      'package.json': JSON.stringify({ name: 'root', scripts: {} }),
      '.github/workflows/ci.yml': stringify({
        jobs: {
          'composite-site': { steps: [{ run: 'echo site' }] },
          'app-tests': { steps: [{ run: 'echo tests' }] },
          'browser-e2e': { steps: [{ run: 'echo e2e' }] },
          'browser-e2e-gpu': { steps: [{ run: 'echo gpu' }] },
        },
      }),
      'scripts/quality/helper.mjs': 'export const h = 1;\n',
      ...patch,
    };
    for (const [path, text] of Object.entries(caseFiles)) {
      await mkdir(dirname(join(caseRoot, path)), { recursive: true });
      await writeFile(join(caseRoot, path), text);
    }
    const caseGraph = await loadConservativeWorkspaceGraph(caseRoot);
    check(createAppPlan(registry, [changedPath], caseGraph, caseManifests), label);
  }
});

test('changedManifests loads pnpm-workspace.yaml, pnpm-lock.yaml, and scripts/lib/e2e-test-data.mjs from git', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'neurodesk-manifests-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=planner', '-c', 'user.email=planner@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  await mkdir(join(root, 'scripts/lib'), { recursive: true });
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  - old@0.1.0\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\npackages:\n  old@0.1.0: {}\n');
  await writeFile(join(root, 'scripts/lib/e2e-test-data.mjs'), 'export const provisioners = {};\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'base');
  const base = git('rev-parse', 'HEAD');
  await writeFile(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\nminimumReleaseAgeExclude:\n  - foo@1.0.0\n');
  await writeFile(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: "9.0"\npackages:\n  foo@1.0.0: {}\n');
  await writeFile(join(root, 'scripts/lib/e2e-test-data.mjs'), 'export const provisioners = { denoise: { env: [], provision: async () => ({}) } };\n');
  git('add', '.');
  git('commit', '--quiet', '-m', 'head');
  const manifests = changedManifests({ base, head: 'HEAD', cwd: root, changedPaths: ['pnpm-workspace.yaml', 'scripts/lib/e2e-test-data.mjs'] });
  assert.equal(manifests.has('pnpm-workspace.yaml'), true);
  assert.equal(manifests.has('pnpm-lock.yaml'), true);
  assert.equal(manifests.has('scripts/lib/e2e-test-data.mjs'), true);
  assert.deepEqual(workspaceConfigImpact({ ...manifests.get('pnpm-workspace.yaml'), lockAfter: manifests.get('pnpm-lock.yaml').after }), { scoped: true });
  assert.deepEqual(e2eTestDataImpact(manifests.get('scripts/lib/e2e-test-data.mjs')), { changed: ['denoise'] });
});
