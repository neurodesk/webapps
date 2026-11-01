import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { parse, stringify } from 'yaml';
import { AUTOMATION_CATALOG_READERS, createAppPlan, INDEPENDENT_ROOT_DEV_DEPENDENCIES, RUNTIME_MANIFEST_READERS, SITE_ONLY_FILES } from '../scripts/lib/app-plan.mjs';
import { testedBase } from '../scripts/lib/tested-base.mjs';
import { lockfileImpact } from '../scripts/lib/lockfile-impact.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { CATALOG, CATALOG_JOBS, loadConservativeWorkspaceGraph, reachableFrom, WorkspaceGraphConfigurationError } from '../scripts/lib/workspace-graph.mjs';

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
  for (const path of ['site/app-shell.js', 'site/app-theme.css', 'site/fonts/inter.woff2', 'scripts/lib/landing-page.mjs']) {
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
  const plan = (after) => createAppPlan(registry, ['package.json'], resolved, new Map([['package.json', manifest({ scripts }, after)], ['pnpm-lock.yaml', manifest(baseLock, baseLock)]]));
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
  for (const [file, command] of [['unused-code', 'pnpm quality:unused'], ['mutation-quality', 'pnpm quality:mutations:smoke']]) {
    const workflow = parse(await readFile(join(repoRoot, `.github/workflows/${file}.yml`), 'utf8'));
    assert.ok(Object.hasOwn(workflow.on, 'pull_request'), `${file} still runs on every PR`);
    assert.ok(Object.values(workflow.jobs).some(job => job.steps.some(step => step.run === command)), command);
  }
});

test('ESLint stays out of every app build, unit test and browser test', async () => {
  // Only the lint runner, the shared config and the lint coverage test load
  // ESLint, and nothing else loads the runner or the config.
  const workspace = await graph;
  const catalog = reachableFrom(workspace, CATALOG);
  const loaders = new Set(['scripts/lint.mjs', 'eslint.config.js', 'test/lint-coverage.test.mjs']);
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
  // The per-app jobs run each app's build, test:e2e and release test script.
  for (const path of loaders) assert.ok(!catalog.has(path), `ci.yml's per-app jobs run ${path}`);
  const ci = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  for (const name of [...CATALOG_JOBS, 'composite-site']) {
    for (const step of ci.jobs[name].steps) assert.doesNotMatch(step.run ?? '', /\blint\b|eslint/, `${name} runs lint`);
  }
  const packages = await workspaceScripts();
  // The traversal crosses packages: SYNcro's build builds Greedy's WebAssembly.
  assert.ok(scriptsRun(packages, 'apps/syncro', ['build']).some(([dir, name]) => dir === 'packages/greedy' && name === 'build:wasm'));
  for (const app of await loadAppsRegistry().then(registry => registry.apps)) {
    for (const [dir, name, command] of scriptsRun(packages, `apps/${app.id}`, ['build', 'test:e2e', app.ci.release_test ?? 'test'])) {
      assert.doesNotMatch(command, /\beslint\b|scripts\/lint\.mjs|eslint\.config/, `${app.id}'s CI scripts reach ${dir} ${name}, which runs ESLint or its runner`);
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
  for (const path of ['scripts/app-plan.mjs', 'scripts/lib/app-plan.mjs', 'scripts/lib/lockfile-impact.mjs', 'scripts/lib/workspace-graph.mjs', 'scripts/lib/apps-registry.mjs', 'scripts/lib/tested-base.mjs', 'scripts/lib/standalone.mjs', 'registry/apps.yml']) {
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
      assert.equal(plan.reasons.fallback, null, path);
    }
  }
  // The shell, theme and fonts go into every app.
  for (const path of ['site/app-shell.js', 'site/app-theme.css', 'site/theme.js', 'site/fonts/inter.woff2']) {
    assert.equal(createAppPlan(registry, [path], await graph).allApps, true, path);
  }
});

test('only the composite build and its own tests read the composite-only site files', async () => {
  const workspace = await graph;
  const registry = await loadAppsRegistry();
  const readers = new Set([
    'scripts/build-site.mjs',
    'scripts/lib/landing-page.mjs',
    'scripts/lib/dicompare-routes.mjs',
    'scripts/write-analytics.mjs',
    'test-utils/dicompare-routes.mjs',
    'knip.config.mjs',
    // The planner names them to classify them.
    'scripts/lib/app-plan.mjs',
    ...SITE_ONLY_FILES,
  ]);
  // Upstream copies naming their own landing.css and SPA 404 page.
  const unrelated = new Set(['apps/qsmbly/upstream.json', 'apps/dicompare/legacy-ci/deploy.yml']);
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
  assert.equal(createAppPlan(registry, ['runtime-assets/manifest.json']).allApps, true, 'without a graph the manifest stays shared');

  // Every other reader belongs to a selected app, a package only selected apps
  // reach, the composite build, or a check outside the per-app jobs.
  const selected = new Set(plan.selected.map((app) => app.id));
  const composite = new Set(['scripts/lib/runtime-assets.mjs', 'scripts/audit-artifacts.mjs', 'test-utils/asyncify-runtime-startup.mjs']);
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
  assert.deepEqual(republished.reasons.apps.lcmodel, ['registry/standalone.json: the lcmodel entry changed']);
  const suite = plan(edit((value) => {
    value.suite.downloads[0].version = '9.9.9';
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
