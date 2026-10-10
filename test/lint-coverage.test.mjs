import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ESLint } from 'eslint';
import config from '../eslint.config.js';
import { assertCoverage, sourceInventory } from '../scripts/quality/lint-inventory.mjs';
import { fingerprint, root } from '../scripts/lint.mjs';
import { preservedLintFilters } from '../scripts/lint-workspaces.mjs';

const eslint = new ESLint({ cwd: root, overrideConfigFile: join(root, 'eslint.config.js') });

test('every owned tracked source receives nonempty correctness rules', async () => {
  const files = sourceInventory(root);
  for (const path of [
    'packages/components/src/index.js',
    'packages/runtime-support/src/gpu-unet/index.js',
    'scripts/new-app.mjs',
    'templates/app-template/src/main.js',
    'apps/zarro/src/cursor_zoom.ts',
  ]) {
    assert.ok(files.includes(path), `${path} must be inventoried`);
  }
  assert.ok(files.length > 1500);
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
});

test('JS, TypeScript and worker correctness canaries report real errors', async () => {
  for (const [filePath, code, rule] of [
    ['packages/components/src/canary.js', 'missingBinding();', 'no-undef'],
    ['apps/deface/src/canary.ts', 'const x: number = 1; if (true) { console.log(x); }', 'no-constant-condition'],
    ['apps/brain2print/src/canary-worker.js', 'document.querySelector("canvas");', 'no-restricted-globals'],
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
  const directory = await mkdtemp(join(root, 'packages/components/src/lint-canary-'));
  await mkdir(join(root, '.audit'), { recursive: true });
  const aliasDirectory = await mkdtemp(join(root, '.audit/lint-alias-'));
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
  const source = await mkdtemp(join(root, 'apps/brain2print/src/lint-canary-'));
  const generated = await mkdtemp(join(root, 'apps/brain2print/dist/lint-canary-'));
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
  const [result] = await eslint.lintText(source, { filePath: join(root, 'apps/deface/src/overload-canary.ts') });
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

test('the typed project checks new source, async callbacks and ignored promises', async () => {
  const directory = await mkdtemp(join(root, 'apps/zarro/src/promise-canary-'));
  const floating = '@typescript-eslint/no-floating-promises';
  const misused = '@typescript-eslint/no-misused-promises';
  try {
    const cases = [
      ['floating.ts', 'export {}; Promise.resolve(1);', floating],
      ['void.ts', 'export {}; void Promise.resolve(1);', floating],
      ['callback.ts', 'export {}; document.addEventListener("click", async () => { await Promise.resolve(1); });', misused],
      ['condition.ts', 'export {}; if (Promise.resolve(true)) { console.log("unreachable decision"); }', misused],
      ['awaited.ts', 'export async function run() { await Promise.resolve(1); }', null],
      ['handled.ts', 'export {}; Promise.reject(new Error("reported")).catch((error: unknown) => { console.error(error); });', null],
    ];
    for (const [name, source] of cases) await writeFile(join(directory, name), source);
    const files = cases.map(([name]) => join(directory, name));
    const results = await eslint.lintFiles(files);
    for (const [index, [, , expected]] of cases.entries()) {
      const result = results.find((entry) => entry.filePath === join(directory, cases[index][0]));
      assert.ok(result, cases[index][0]);
      const errors = result.messages.filter((message) => message.severity === 2);
      assert.equal(errors.some((message) => message.fatal), false, `${cases[index][0]} must parse with type information`);
      if (expected) assert.ok(errors.some((message) => message.ruleId === expected), cases[index][0]);
      else assert.deepEqual(errors, [], cases[index][0]);
    }
    const newFile = join(directory, 'floating.ts').slice(root.length);
    assert.ok(sourceInventory(root).includes(newFile));
    await assertCoverage(eslint, [newFile]);
    const result = spawnSync('pnpm', ['lint:correctness'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /floating\.ts:1:12 @typescript-eslint\/no-floating-promises/);
    assert.match(result.stderr, /callback\.ts:1:\d+ @typescript-eslint\/no-misused-promises/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
