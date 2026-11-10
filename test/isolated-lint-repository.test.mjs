import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import test from 'node:test';
import { isolatedLintRepository } from '../test-utils/isolated-lint-repository.mjs';
import { canaryDirectory } from '../test-utils/lint-canaries.mjs';
import { sourceInventory } from '../scripts/quality/lint-inventory.mjs';

test('active and abandoned canaries cannot contaminate the source repository', async () => {
  const source = await mkdtemp(join(tmpdir(), 'lint-isolation-test-'));
  let fixture;
  try {
    execFileSync('git', ['init', '--quiet'], { cwd: source });
    await mkdir(join(source, 'src'));
    await writeFile(join(source, 'src/main.js'), 'export const value = 1;');
    execFileSync('git', ['add', '.'], { cwd: source });
    await writeFile(join(source, 'src/main.js'), 'export const value = 2;');
    await writeFile(join(source, 'src/new.js'), 'export {};');
    fixture = await isolatedLintRepository(source);
    assert.equal(await readFile(join(fixture.root, 'src/main.js'), 'utf8'), 'export const value = 2;');
    assert.ok(sourceInventory(fixture.root).includes('src/new.js'));
    await writeFile(join(fixture.root, 'src/main.js'), 'missingBinding();');
    assert.equal(await readFile(join(source, 'src/main.js'), 'utf8'), 'export const value = 2;');
    const directory = await canaryDirectory(fixture.root, 'src/lint-canary-');
    await writeFile(join(directory, 'canary.js'), 'missingLintCanary();');
    assert.ok(sourceInventory(fixture.root).includes(relative(fixture.root, join(directory, 'canary.js'))));
    assert.deepEqual(sourceInventory(source), ['src/main.js', 'src/new.js']);
    await fixture.cleanup();
    await assert.rejects(access(fixture.root), { code: 'ENOENT' });
    assert.deepEqual(sourceInventory(source), ['src/main.js', 'src/new.js']);
  } finally {
    await fixture?.cleanup();
    await rm(source, { recursive: true, force: true });
  }
});
