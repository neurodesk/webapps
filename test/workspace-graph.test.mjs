// The workspace graph's path rules on a small fixture tree: which directories and root files
// each node reaches, so a change selects the apps and CI jobs that use it.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test, { after } from 'node:test';
import { stringify } from 'yaml';
import { CATALOG, CATALOG_JOBS, INDEPENDENT_CONFIG, SITE, WorkspaceGraphConfigurationError, loadConservativeWorkspaceGraph, reachableFrom } from '../scripts/lib/workspace-graph.mjs';

const json = (value) => JSON.stringify(value, null, 2);

const jobs = (runs) => ({
  jobs: Object.fromEntries(Object.entries(runs).map(([name, steps]) => [name, {
    steps: steps.map((run) => (run === null ? { uses: 'actions/checkout@v5' } : { run })),
  }])),
});

const CI = jobs({
  // The split form of a root path is not read from CI commands.
  'composite-site': ['pnpm build', null, 'node -e "load(\'registry\', \'ci.json\')"'],
  'app-tests': ['node test/catalog.test.mjs\npnpm --filter @nd/alpha build\npnpm --filter @nd/alpha run unused'],
  'browser-e2e': ['pnpm loop'],
  'browser-e2e-gpu': ['node test-utils/gpu.mjs --flag'],
  lint: ['node scripts/lint-only.mjs'],
});

const ROOT_PACKAGE = json({
  scripts: {
    build: 'node scripts/build.mjs && pnpm run check && pnpm install',
    check: 'node test-utils/check.mjs',
    loop: 'node scripts/loop.mjs; pnpm loop',
    unused: 'node scripts/unused.mjs',
  },
});

// Every workspace directory that exists only to be reached (or not reached).
const EMPTY_PACKAGES = [
  'beta-only', 'built', 'covered', 'cts', 'docs', 'fits', 'fixtures', 'hidden', 'html', 'installed', 'large',
  'makefile-copy', 'named', 'plain', 'python', 'shell', 'sketch', 'styles', 'templated', 'text-file', 'unquoted',
  'vendored', 'viewer', 'yaml', 'yml',
];

const FILES = {
  // Written first so directory order on disk is not already sorted.
  'packages/zeta/package.json': json({ name: '@nd/zeta' }),
  'exes/tool/package.json': json({ name: '@nd/tool' }),

  'package.json': ROOT_PACKAGE,
  '.github/workflows/ci.yml': stringify(CI),
  'e2e.config.ts': 'export default {};\n',
  'vite.config.mjs': 'export default {};\n',
  'old.vite.config.js': 'export default {};\n',
  'tsconfig.json': '{}\n',
  'tsconfig.agentic.json': '{}\n',
  'eslint.config.mjs': 'export default [];\n',
  'knip.config.js': 'export default {};\n',
  'stryker.config.mjs': 'export default {};\n',
  'other.config.json': '{}\n',
  'root-helper.js': '',
  'settings.json.yml': '',
  'README.md': 'scripts/never.mjs\n',

  // Apps: one with a manifest and every kind of reference, one without a manifest.
  'apps/README.md': '../packages/hidden/x\n',
  'apps/alpha/package.json': json({
    name: '@nd/alpha',
    dependencies: { '@nd/core': 'workspace:*', '@nd/beta-app': 'workspace:*', 'left-pad': '1.0.0' },
    devDependencies: {
      '@nd/zeta': 'workspace:*',
      '@nd/tool': 'workspace:*',
      // `./` keeps these paths out of the text references, so only the file: rule can find them.
      '@nd/vendored': 'file:../../packages/./vendored',
      '@nd/kit': 'file:../../exes/./kit',
      outside: 'file:../../vendor/outside',
      group: 'file:../../packages',
      app: 'file:../beta-app',
      '@nd/util': '^1.0.0',
    },
    peerDependencies: { '@nd/peer': 'workspace:^' },
    optionalDependencies: { '@nd/optional': 'workspace:~' },
  }),
  'apps/alpha/src/main.js': [
    "import '../../../packages/viewer/src/index.js';",
    "const kernel = 'exes/kernel/src/lib.rs';",
    'const missing = "packages/missing/index.js";',
    'const spaced = `packages/templated`;',
    'const notQuoted = packages/unquoted;',
    "import fixture from '../../../packages/fixtures/test/data.js';",
    "import checks from '../../../packages/fixtures/tests/more.js';",
    "const guide = 'packages/docs/guides/USAGE.md';",
    "const readme = 'packages/docs/README.md';",
    "const deep = 'packages/docs/a/b/DEEP.md';",
    "import theme from '../../../scripts/theme.mjs';",
    "import dice from '../../../test-utils/dice.mjs';",
    "const apps = '../../../registry/apps.yml';",
    "const unrooted = 'scripts/not-relative.mjs';",
    "const notFile = '../../../scripts/directory';",
  ].join('\n'),
  'apps/alpha/Makefile': 'include ../../exes/maker/rules.mk\n',
  'apps/alpha/Cargo.toml': 'path = "../../exes/cargo"\n',
  'apps/alpha/build.sh': 'cp ../../packages/shell/out .\n',
  'apps/alpha/style.css': '@import "../../packages/styles/base.css";\n',
  'apps/alpha/page.html': '<script src="../../packages/html/x.js"></script>\n',
  'apps/alpha/tool.py': 'open("../../packages/python/x")\n',
  'apps/alpha/config.yaml': 'path: ../../packages/yaml/x\n',
  'apps/alpha/config.yml': 'path: ../../packages/yml/x\n',
  'apps/alpha/src/types.d.cts': "import '../../../packages/cts/x';\n",
  'apps/alpha/notes.txt': '../../packages/text-file/x\n',
  'apps/alpha/Makefile.old': '../../packages/text-file/x\n',
  'apps/alpha/OldMakefile': '../../packages/text-file/x\n',
  'apps/alpha/backup.js.orig': '../../packages/text-file/x\n',
  'apps/alpha/dist/bundle.js': '../../packages/built/x\n',
  'apps/alpha/node_modules/dep/index.js': '../../packages/installed/x\n',
  'apps/alpha/target/out.rs': '../../exes/compiled/x\n',
  'apps/alpha/coverage/report.json': '"packages/covered/x"\n',
  'apps/alpha/.turbo/log.json': '"packages/built/x"\n',
  'apps/alpha/.vite/deps.js': '"packages/built/x"\n',
  'apps/alpha/test-results/result.json': '"packages/built/x"\n',
  'apps/alpha/playwright-report/report.js': '"packages/built/x"\n',
  // One byte over and exactly at the 1 MiB limit for scanned text.
  'apps/alpha/large.json': `${' '.repeat(1024 * 1024 - 24)}"../../packages/large/x"\n`,
  'apps/alpha/fits.json': `${' '.repeat(1024 * 1024 - 24)}"../../packages/fits/x"\n`,
  'apps/beta/index.js': "import '../../packages/core/src/index.js';\nimport '../../apps/alpha/src/main.js';\n",
  'apps/beta-app/package.json': json({ name: '@nd/beta-app' }),
  'apps/beta-app/index.js': "import '../../packages/beta-only/x.js';\n",

  // Packages and executables.
  'packages/core/package.json': json({ name: '@nd/core', dependencies: { '@nd/util': 'workspace:*', '@nd/missing': 'workspace:*' } }),
  'packages/core/src/index.js': "import '../../../packages/core/src/self.js';\nimport { value } from '@nd/util';\nimport 'yaml';\n",
  'packages/core/README.md': 'docs\n',
  'packages/util/package.json': json({ name: '@nd/util' }),
  'packages/util/src/value.js': 'export const value = 1;\n',
  'packages/util/src/helper.mjs': 'export const helper = 1;\n',
  'packages/peer/package.json': json({ name: '@nd/peer' }),
  'packages/optional/package.json': json({ name: '@nd/optional' }),
  'packages/scoped/package.json': json({ name: '@nd/scoped' }),
  'packages/spaced/package.json': json({ name: '@nd/spaced' }),
  'packages/unscoped/package.json': json({ name: 'unscoped' }),
  'packages/broken/package.json': '{ not json',
  'packages/broken/src/x.js': "const tool = '../../exes/tool';\n",
  ...Object.fromEntries(EMPTY_PACKAGES.map((name) => [`packages/${name}/index.js`, ''])),
  'exes/kernel/src/lib.rs': '',
  'exes/kit/src/lib.rs': '',
  'exes/maker/rules.mk': '',
  'exes/cargo/Cargo.toml': '',
  'exes/compiled/src/main.rs': '',
  'exes/tool/src/main.rs': '',
  'exes/script-tool/src/main.rs': '',

  // Root files reached from apps and from CI commands.
  'scripts/theme.mjs': [
    "import { helper } from './lib/helper.mjs';",
    "import { core } from '@nd/core';",
    "import { scoped } from '@nd/scoped';",
    "import { spaced } from  '@nd/spaced';",
    "import { unscoped } from 'unscoped';",
    "import 'unscoped-side-effect';",
    'import { parse } from "yaml";',
    "import data from '../registry/data.json';",
    "export { other } from './lib/other.js';",
    "import notes from './notes.md';",
    "const exe = join(root, 'exes','script-tool');",
    "const missingExe = join(root, 'exes', 'absent');",
    "const tool = join(root, 'exes', 'tool');",
    "const util = 'packages/util/src/value.js';",
    "const helperFile = 'packages/util/src/helper.mjs';",
    "const gone = 'packages/util/src/gone.js';",
    "const readme = 'packages/core/README.md';",
    "const sketch = 'packages/sketch/drawing.png';",
    "const plain = 'packages/plain';",
    "const apps = readFile('registry/apps.yml');",
    "const offline = join(root, 'registry', 'offline.json');",
    'const helpers = join(root, "test-utils", "helpers.mjs");',
    "const fixtures = glob('test-utils/fixtures/one*.json');",
    "const templates = glob('scripts/templates/*');",
    "const absent = glob('test-utils/absent/*.json');",
    "const exact = 'test-utils/fixtures/one.json';",
    "const notSource = read('test-utils/data.js.json');",
    "const docs = 'docs/guide.mjs';",
    "const prefixed = 'my-scripts/x.mjs';",
  ].join('\n'),
  'scripts/lib/helper.mjs': [
    "import './helper.mjs';",
    "import '../../vite.config.mjs';",
    "import '../../root-helper.js';",
    "import '../../settings.json.yml';",
    "import '../../outside/file.js';",
    "import '../../../beyond.js';",
  ].join('\n'),
  'scripts/lib/other.js': "export const other = 'packages/named';\n",
  'scripts/templates/page.html': '<p></p>\n',
  'scripts/templates/image.png': '',
  'scripts/build.mjs': "import './build.mjs';\nimport '../registry/site.json';\n",
  'scripts/loop.mjs': "import './loop.mjs';\nimport './loop-b.mjs';\n",
  'scripts/loop-b.mjs': "import './loop.mjs';\n",
  'scripts/lint-only.mjs': '',
  'scripts/unused.mjs': '',
  'scripts/notes.md': "import '../packages/core/src/index.js';\n",
  'test/catalog.test.mjs': "import '../test-utils/shared.mjs';\n",
  'test-utils/check.mjs': "const items = ['registry', 'site.json'];\n",
  'test-utils/gpu.mjs': '',
  'test-utils/shared.mjs': "import { value } from '@nd/util';\nimport '@nd/core';\n",
  'test-utils/helpers.mjs': '',
  'test-utils/data.js.json': '"packages/hidden"\n',
  'test-utils/fixtures/one.json': '{}\n',
  'test-utils/fixtures/nested/two.json': '{}\n',
  'test-utils/fixtures/image.png': '',
  'registry/apps.yml': "import '../scripts/never.mjs';\n",
  'registry/ci.json': '{}\n',
  'registry/data.json': '{}\n',
  'registry/offline.json': '{}\n',
  'registry/site.json': '{}\n',
};

async function fixture(files) {
  const root = await mkdtemp(join(tmpdir(), 'workspace-graph-'));
  after(() => rm(root, { recursive: true, force: true }));
  for (const [path, text] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), text);
  }
  for (const directory of ['scripts/directory', '.github/workflows']) await mkdir(join(root, directory), { recursive: true });
  return root;
}

const graph = await loadConservativeWorkspaceGraph(await fixture(FILES));

const edgesOf = ({ edges }) => Object.fromEntries([...edges].map(([node, uses]) => [node, [...uses].sort()]).sort(([a], [b]) => a.localeCompare(b)));

test('every workspace directory is a node, in name order within each group', () => {
  const packages = [...EMPTY_PACKAGES, 'broken', 'core', 'optional', 'peer', 'scoped', 'spaced', 'unscoped', 'util', 'zeta'].sort();
  assert.deepEqual(graph.nodes, [
    'apps/alpha', 'apps/beta', 'apps/beta-app',
    ...packages.map((name) => `packages/${name}`),
    'exes/cargo', 'exes/compiled', 'exes/kernel', 'exes/kit', 'exes/maker', 'exes/script-tool', 'exes/tool',
  ]);
  assert.ok(Object.isFrozen(graph));
  assert.ok(Object.isFrozen(graph.nodes));
});

test('every node reaches exactly the directories and root files its sources name', () => {
  const empty = [];
  const leaves = Object.fromEntries(graph.nodes.filter((node) => !['apps/alpha', 'apps/beta', 'apps/beta-app', 'packages/broken', 'packages/core'].includes(node)).map((node) => [node, empty]));
  assert.deepEqual(edgesOf(graph), edgesOf({ edges: new Map(Object.entries({
    ...leaves,
    [CATALOG]: ['scripts/loop.mjs', 'test-utils/gpu.mjs', 'test/catalog.test.mjs'],
    [SITE]: ['e2e.config.ts', 'scripts/build.mjs', 'test-utils/check.mjs', 'tsconfig.agentic.json', 'tsconfig.json', 'vite.config.mjs'],
    'apps/alpha': [
      'exes/cargo', 'exes/kernel', 'exes/kit', 'exes/maker', 'exes/tool',
      'packages/core', 'packages/cts', 'packages/docs', 'packages/docs/README.md', 'packages/docs/a/b/DEEP.md',
      'packages/docs/guides/USAGE.md', 'packages/fits', 'packages/fixtures', 'packages/fixtures/test', 'packages/fixtures/tests',
      'packages/html', 'packages/optional', 'packages/peer', 'packages/python', 'packages/shell', 'packages/styles',
      'packages/templated', 'packages/vendored', 'packages/viewer', 'packages/yaml', 'packages/yml', 'packages/zeta',
      'registry/apps.yml', 'scripts/theme.mjs', 'test-utils/dice.mjs',
    ],
    'apps/beta': ['packages/core'],
    'apps/beta-app': ['packages/beta-only'],
    'packages/broken': ['exes/tool'],
    'packages/core': ['packages/util'],
    'e2e.config.ts': empty,
    'packages/core/README.md': empty,
    'packages/util/src/helper.mjs': empty,
    'packages/util/src/value.js': empty,
    'registry/apps.yml': empty,
    'registry/data.json': empty,
    'registry/offline.json': empty,
    'registry/site.json': empty,
    'root-helper.js': empty,
    'scripts/build.mjs': ['registry/site.json'],
    'scripts/lib/helper.mjs': ['root-helper.js', 'vite.config.mjs'],
    'scripts/lib/other.js': ['packages/named'],
    'scripts/loop-b.mjs': ['scripts/loop.mjs'],
    'scripts/loop.mjs': ['scripts/loop-b.mjs'],
    'scripts/templates/page.html': empty,
    'scripts/theme.mjs': [
      'exes/script-tool', 'exes/tool', 'packages/core', 'packages/core/README.md', 'packages/plain', 'packages/scoped', 'packages/sketch',
      'packages/spaced', 'packages/unscoped', 'packages/util', 'packages/util/src/helper.mjs', 'packages/util/src/value.js',
      'registry/apps.yml', 'registry/data.json', 'registry/offline.json', 'scripts/lib/helper.mjs', 'scripts/lib/other.js',
      'scripts/templates/page.html', 'test-utils/data.js.json', 'test-utils/fixtures/nested/two.json',
      'test-utils/fixtures/one.json', 'test-utils/helpers.mjs',
    ],
    'test-utils/check.mjs': ['registry/site.json'],
    'test-utils/data.js.json': empty,
    'test-utils/dice.mjs': empty,
    'test-utils/fixtures/nested/two.json': empty,
    'test-utils/fixtures/one.json': empty,
    'test-utils/gpu.mjs': empty,
    'test-utils/helpers.mjs': empty,
    'test-utils/shared.mjs': ['packages/util'],
    'test/catalog.test.mjs': ['test-utils/shared.mjs'],
    'tsconfig.agentic.json': empty,
    'tsconfig.json': empty,
    'vite.config.mjs': empty,
  })) }));
});

test('CI entry points expand root scripts once, ignoring filtered workspace scripts', () => {
  assert.deepEqual([...graph.rootScriptsRun.keys()], [SITE, CATALOG]);
  assert.deepEqual([...graph.rootScriptsRun.get(SITE)].sort(), ['build', 'check', 'install']);
  assert.deepEqual([...graph.rootScriptsRun.get(CATALOG)].sort(), ['loop']);
});

test('reachability follows edges transitively from any node and stops at cycles', () => {
  assert.deepEqual([...reachableFrom(graph, 'apps/beta')].sort(), ['apps/beta', 'packages/core', 'packages/util']);
  assert.deepEqual([...reachableFrom(graph, CATALOG)].sort(), [CATALOG, 'packages/util', 'scripts/loop-b.mjs', 'scripts/loop.mjs', 'test-utils/gpu.mjs', 'test-utils/shared.mjs', 'test/catalog.test.mjs']);
  assert.ok(reachableFrom(graph, 'apps/alpha').has('scripts/lib/helper.mjs'));
  assert.ok(reachableFrom(graph, 'apps/alpha').has('vite.config.mjs'));
  assert.deepEqual([...reachableFrom(graph, 'unknown')], ['unknown']);
  const cyclic = { edges: new Map([['a', new Set(['b'])], ['b', new Set(['a', 'c'])], ['c', new Set(['b'])]]) };
  assert.deepEqual([...reachableFrom(cyclic, 'a')].sort(), ['a', 'b', 'c']);
});

test('a missing or step-less CI job is a configuration error naming the job', async () => {
  const root = await fixture({ 'package.json': ROOT_PACKAGE });
  const variants = [['missing', undefined], ['empty', { steps: [] }], ['not a list', { steps: { run: 'x' } }], ['reusable', { uses: './reusable.yml' }]];
  for (const name of ['composite-site', ...CATALOG_JOBS]) {
    for (const [variant, job] of variants) {
      const ci = structuredClone(CI);
      if (job === undefined) delete ci.jobs[name];
      else ci.jobs[name] = job;
      await writeFile(join(root, '.github/workflows/ci.yml'), stringify(ci));
      await assert.rejects(loadConservativeWorkspaceGraph(root), (error) => {
        assert.ok(error instanceof WorkspaceGraphConfigurationError, `${name} ${variant}`);
        assert.equal(error.message, `ci.yml job ${name} has no step list; update the workspace graph's CI entry points`);
        return true;
      });
    }
  }
  for (const text of ['name: no jobs\n', '']) {
    await writeFile(join(root, '.github/workflows/ci.yml'), text);
    await assert.rejects(loadConservativeWorkspaceGraph(root), WorkspaceGraphConfigurationError, JSON.stringify(text));
  }
});

test('lint and mutation-testing configs are independent of the site build', () => {
  for (const name of ['eslint.config.js', 'eslint.config.mjs', 'knip.config.js', 'knip.config.mjs', 'stryker.config.js', 'stryker.config.mjs']) {
    assert.ok(INDEPENDENT_CONFIG.test(name), name);
  }
  for (const name of ['vite.config.mjs', 'eslint.config.cjs', 'eslint.config.ts', 'my-eslint.config.mjs', 'eslint.config.mjs.bak', 'eslint-config.mjs']) {
    assert.ok(!INDEPENDENT_CONFIG.test(name), name);
  }
});
