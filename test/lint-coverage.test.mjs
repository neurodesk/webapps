import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { ESLint } from 'eslint';
import config from '../eslint.config.js';
import { assertCoverage, sourceInventory } from '../scripts/quality/lint-inventory.mjs';
import { fingerprint, root } from '../scripts/lint.mjs';

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
    ['apps/zarro/src/canary.ts', 'const x: number = 1; if (true) { console.log(x); }', 'no-constant-condition'],
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
  try {
    const canary = join(directory, 'canary.js');
    await writeFile(canary, 'missingLintCanary();\n');
    const { scripts } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
    assert.equal(scripts['lint:correctness'], 'node scripts/lint.mjs');
    assert.match(scripts.lint, /^pnpm lint:correctness &&/);
    const result = spawnSync('pnpm', ['lint'], { cwd: root, encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /canary\.js:1:1 no-undef/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
