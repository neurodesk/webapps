import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test, { before } from 'node:test';
import { ESLint } from 'eslint';
import { canaryDirectory as createCanaryDirectory, cleanupCanaries } from '../test-utils/lint-canaries.mjs';
import config from '../eslint.config.js';
import { assertCoverage, sourceInventory } from '../scripts/quality/lint-inventory.mjs';
import { fingerprint, inspect, root } from '../scripts/lint.mjs';
import { typedProjectFor, typedPromiseProjects } from '../scripts/quality/typed-projects.mjs';

// Canaries create new files in a project's first source directory.
const sourceDirectory = ({ name, sources }) => {
  const directory = sources.find((source) => source.endsWith('/'));
  assert.ok(directory, `${name} needs a source directory for its canaries`);
  return directory;
};
import { preservedLintFilters } from '../scripts/lint-workspaces.mjs';

const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.js') });

const canaryDirectory = (prefix) => createCanaryDirectory(root, prefix);
const canaryParents = [
  ...typedPromiseProjects.map(sourceDirectory),
  'packages/components/src/',
  'apps/brain2print/src/',
  'apps/brain2print/dist/',
  '.audit/',
];
before(() => cleanupCanaries(root, canaryParents));

test('every owned tracked source receives nonempty correctness rules', async () => {
  const files = sourceInventory(root);
  for (const path of [
    'packages/components/src/index.js',
    'packages/runtime-support/src/gpu-unet/index.js',
    'scripts/new-app.mjs',
    'templates/app-template/src/main.js',
    'apps/zarro/src/cursor_zoom.ts',
    'apps/deface/src/main.ts',
    'apps/browserqc/src/main.ts',
    'test/agentic/catalog.e2e.ts',
    'test-utils/agentic-browser.ts',
    'e2e.config.ts',
    'apps/dicompare/src/App.tsx',
  ]) {
    assert.ok(files.includes(path), `${path} must be inventoried`);
  }
  assert.ok(files.length > 1500);
  // Rolled-out projects stay typed; see the inventory in docs/development/correctness-lint.md.
  for (const name of ['zarro', 'deface', 'dwi2trx', 'browserqc', 'agentic', 'dicompare']) assert.ok(typedPromiseProjects.some((project) => project.name === name), name);
  await assertCoverage(eslint, files);
});

test('an ignore or empty configuration cannot silently remove owned source', async () => {
  const ignored = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [
    { ignores: ['packages/components/**'] },
    ...config,
  ] });
  await assert.rejects(assertCoverage(ignored, ['packages/components/src/index.js']), /No effective correctness rules/);
  const empty = new ESLint({ cwd: root, overrideConfigFile: true, overrideConfig: [{ files: ['**/*.js'], rules: {} }] });
  await assert.rejects(assertCoverage(empty, ['packages/components/src/index.js']), /No effective correctness rules/);
  const coreOnly = { async calculateConfigForFile() {
    return { rules: { 'no-unreachable': [2], 'no-dupe-keys': [2], 'no-constant-condition': [2] } };
  } };
  for (const project of typedPromiseProjects) {
    const { tsconfig } = project;
    const file = `${sourceDirectory(project)}new-file.ts`;
    const otherProject = typedPromiseProjects.find((other) => other !== project).tsconfig;
    await assert.rejects(assertCoverage(coreOnly, [file]), /No effective correctness rules/);
    const typedConfig = (floating, project) => ({ async calculateConfigForFile() {
      const rules = { 'no-unreachable': [2], 'no-dupe-keys': [2], 'no-constant-condition': [2], '@typescript-eslint/no-misused-promises': [2] };
      return { rules: { ...rules, '@typescript-eslint/no-floating-promises': [2, floating] }, languageOptions: { parserOptions: { project } } };
    } });
    await assertCoverage(typedConfig({ ignoreVoid: false }, [`./${tsconfig}`]), [file]);
    await assert.rejects(assertCoverage(typedConfig({ ignoreVoid: true }, [`./${tsconfig}`]), [file]), /void promise/);
    await assert.rejects(assertCoverage(typedConfig({ ignoreVoid: false }, undefined), [file]), /must be typed by/);
    await assert.rejects(assertCoverage(typedConfig({ ignoreVoid: false }, [`./${otherProject}`]), [file]), /must be typed by/);
  }
});

test('JS, TypeScript and worker correctness canaries report real errors', async () => {
  for (const [filePath, code, rule] of [
    ['packages/components/src/canary.js', 'missingBinding();', 'no-undef'],
    ['packages/components/src/canary.ts', 'const x: number = 1; if (true) { console.log(x); }', 'no-constant-condition'],
    ['apps/brain2print/src/canary-worker.js', 'document.querySelector("canvas");', 'no-restricted-globals'],
    ['packages/components/src/canary-worker.mts', 'document.querySelector("canvas");', 'no-restricted-globals'],
    ['packages/components/src/canaryWorker.cts', 'window.location.reload();', 'no-restricted-globals'],
    ['packages/components/src/canary.js', '/* eslint-disable */\nmissingBinding();', 'no-undef'],
  ]) {
    const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
    assert.ok(result.messages.some((message) => message.ruleId === rule && message.severity === 2), filePath);
  }
});

test('existing findings do not hide changed defective source', () => {
  const message = { line: 1, ruleId: 'no-undef', message: "'missing' is not defined." };
  assert.notEqual(fingerprint('a.js', message, 'missing(a);'), fingerprint('a.js', message, 'missing(b);'));
  assert.notEqual(fingerprint('a.js', message, 'missing(a);'), fingerprint('b.js', message, 'missing(a);'));
});

test('the root lint command rejects new untracked source in shared packages', async () => {
  const directory = await canaryDirectory('packages/components/src/lint-canary-');
  await mkdir(join(root, '.audit'), { recursive: true });
  const aliasDirectory = await canaryDirectory('.audit/lint-alias-');
  const alias = join(aliasDirectory, 'repository');
  await symlink(root, alias, 'junction');
  try {
    const canary = join(directory, 'canary.js');
    await writeFile(canary, 'missingLintCanary();\n');
    const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(scripts['lint:correctness'], 'node scripts/lint.mjs');
    assert.match(scripts.lint, /^pnpm lint:correctness &&/);
    const result = spawnSync('pnpm', ['lint'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /canary\.js:1:1 no-undef/);
    const linked = spawnSync(process.execPath, [join(alias, 'scripts/lint.mjs')], { cwd: alias, encoding: 'utf8' });
    assert.equal(linked.status, 1);
    assert.match(linked.stderr, /canary\.js:1:1 no-undef/);
    const workspaceChecks = spawnSync(process.execPath, [join(alias, 'scripts/lint-workspaces.mjs')], { cwd: alias, encoding: 'utf8' });
    assert.equal(workspaceChecks.status, 0, workspaceChecks.stdout + workspaceChecks.stderr);
    assert.match(workspaceChecks.stdout, /successful/);
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(aliasDirectory, { recursive: true, force: true });
  }
});

test('package lint rejects new source and skips generated files in its workspace', async () => {
  await mkdir(join(root, 'apps/brain2print/dist'), { recursive: true });
  const source = await canaryDirectory('apps/brain2print/src/lint-canary-');
  const generated = await canaryDirectory('apps/brain2print/dist/lint-canary-');
  try {
    await writeFile(join(generated, 'ignored.js'), 'missingGeneratedBinding();\n');
    const clean = spawnSync('pnpm', ['--filter', 'brain2print', 'lint'], { cwd: root, encoding: 'utf8' });
    assert.equal(clean.status, 0, clean.stderr);
    await writeFile(join(source, 'canary.js'), 'missingScopedLintBinding();\n');
    const failure = spawnSync('pnpm', ['--filter', 'brain2print', 'lint'], { cwd: root, encoding: 'utf8' });
    assert.equal(failure.status, 1);
    assert.match(failure.stderr, /canary\.js:1:1 no-undef/);
    assert.doesNotMatch(failure.stderr, /missingGeneratedBinding/);
  } finally {
    await rm(source, { recursive: true, force: true });
    await rm(generated, { recursive: true, force: true });
  }
});

test('TypeScript overload declarations remain valid source', async () => {
  const source = `export function double(value: number): number;
export function double(value: string): string;
export function double(value: number | string) { return typeof value === 'number' ? value * 2 : value + value; }
export class Value {
  read(input: number): number;
  read(input: string): string;
  read(input: number | string) { return input; }
}`;
  const [result] = await eslint.lintText(source, { filePath: join(root, 'packages/components/src/overload-canary.ts') });
  assert.deepEqual(result.messages, []);
});

test('preserved workspace tasks include chained checks and no empty turbo fallback', () => {
  const task = (name, lint) => ({ packageJson: { name, scripts: { lint } } });
  assert.deepEqual(preservedLintFilters([]), []);
  assert.deepEqual(preservedLintFilters([
    task('plain-eslint', 'eslint .'),
    task('delegate', 'node ../../scripts/lint.mjs --workspace'),
    task('types', 'tsc --noEmit'),
    task('chain', 'eslint . && tsc --noEmit'),
    task('absent', undefined),
  ]), ['--filter=types', '--filter=chain']);
});

test('each typed project checks new source, async callbacks and ignored promises', async () => {
  const floating = '@typescript-eslint/no-floating-promises';
  const misused = '@typescript-eslint/no-misused-promises';
  const cases = [
    ['floating.ts', 'export {}; Promise.resolve(1);', floating],
    ['void.ts', 'export {}; void Promise.resolve(1);', floating],
    ['callback.ts', 'export {}; document.addEventListener("click", async () => { await Promise.resolve(1); });', misused],
    ['condition.ts', 'export {}; if (Promise.resolve(true)) { console.log("unreachable decision"); }', misused],
    ['awaited.ts', 'export async function run() { await Promise.resolve(1); }', null],
    ['handled.ts', 'export {}; Promise.reject(new Error("reported")).catch((error: unknown) => { console.error(error); });', null],
  ];
  const directories = [];
  try {
    for (const project of typedPromiseProjects) {
      const sources = sourceDirectory(project);
      const directory = await canaryDirectory(`${sources}promise-canary-`);
      directories.push(directory);
      for (const [name, source] of cases) await writeFile(join(directory, name), source);
      const results = await eslint.lintFiles(cases.map(([name]) => join(directory, name)));
      for (const [name, , expected] of cases) {
        const result = results.find((entry) => entry.filePath === join(directory, name));
        assert.ok(result, `${sources}${name}`);
        const errors = result.messages.filter((message) => message.severity === 2);
        assert.equal(errors.some((message) => message.fatal), false, `${sources}${name} must parse with type information`);
        if (expected) assert.ok(errors.some((message) => message.ruleId === expected), `${sources}${name}`);
        else assert.deepEqual(errors, [], `${sources}${name}`);
      }
      const newFile = join(directory, 'floating.ts').slice(root.length);
      assert.ok(sourceInventory(root).includes(newFile));
      await assertCoverage(eslint, [newFile]);
      // TypeScript itself rejects an always-true promise condition; the gate's compile step would report it first.
      await rm(join(directory, 'condition.ts'));
    }
    const result = spawnSync('pnpm', ['lint:correctness'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    for (const directory of directories) {
      const prefix = directory.slice(root.length).replaceAll('\\', '/');
      assert.match(result.stderr, new RegExp(`${prefix}/floating\\.ts:1:12 @typescript-eslint/no-floating-promises`));
      assert.match(result.stderr, new RegExp(`${prefix}/void\\.ts:1:12 @typescript-eslint/no-floating-promises`));
      assert.match(result.stderr, new RegExp(`${prefix}/callback\\.ts:1:\\d+ @typescript-eslint/no-misused-promises`));
    }
  } finally {
    for (const directory of directories) await rm(directory, { recursive: true, force: true });
  }
});

test('a typed project that does not compile fails the gate instead of typing promises as any', async () => {
  for (const project of typedPromiseProjects) {
    const { tsconfig } = project;
    const directory = await canaryDirectory(`${sourceDirectory(project)}type-canary-`);
    try {
      const file = join(directory, 'unresolved.ts');
      await writeFile(file, 'import { load } from "./missing-module.js";\nexport function run() { load(); }\n');
      // The parser would type the unresolved import as any and report nothing; the compile step must fail first.
      const relativeFile = file.slice(root.length).replaceAll('\\', '/');
      await assert.rejects(inspect(eslint, [relativeFile], {}), (error) => {
        assert.match(error.message, new RegExp(`${tsconfig.replaceAll('.', '\\.')} does not compile`));
        assert.match(error.message, /unresolved\.ts\(1,\d+\): error TS2307/);
        return true;
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test('a project file source types exactly that file', async () => {
  const agentic = typedPromiseProjects.find(({ name }) => name === 'agentic');
  for (const file of ['e2e.config.ts', 'test-utils/agentic-browser.ts']) {
    assert.equal(typedProjectFor(file), agentic, file);
    await assertCoverage(eslint, [file]);
  }
  // Neighbours of a file source are not part of the project, in the coverage check or in ESLint.
  for (const file of ['test-utils/agentic-browser.test.ts', 'test-utils/other.ts', 'e2e.config.mts']) {
    assert.equal(typedProjectFor(file), undefined, file);
    const config = await eslint.calculateConfigForFile(file);
    assert.equal(config.rules['@typescript-eslint/no-floating-promises'], undefined, file);
  }
});
