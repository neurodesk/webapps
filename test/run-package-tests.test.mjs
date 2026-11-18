import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { plannedSuites, unmatchedSuites } from '../scripts/run-package-tests.mjs';
import { repoRoot } from '../scripts/lib/apps-registry.mjs';

test('the package step refuses a list it cannot run as given', () => {
  const refused = {
    '{': /not JSON/,
    '': /not JSON/,
    '[]': /non-empty array/,
    '"packages/niimath"': /non-empty array/,
    '["packages/niimath","packages/niimath"]': /twice/,
    '["../apps/niimath"]': /not a packages\/<name> directory/,
    '["packages/niimath extra"]': /not a packages\/<name> directory/,
    '["packages/nonexistent"]': /packages\/nonexistent has no readable package\.json/,
  };
  // A package directory without the script its suite runs tests nothing.
  const scriptless = readdirSync(join(repoRoot, 'packages')).find((name) => {
    try {
      return name !== 'components' && !JSON.parse(readFileSync(join(repoRoot, 'packages', name, 'package.json'), 'utf8')).scripts?.test;
    } catch {
      return false;
    }
  });
  if (scriptless) refused[JSON.stringify([`packages/${scriptless}`])] = /has no test script/;
  for (const [text, reason] of Object.entries(refused)) assert.throws(() => plannedSuites(text, repoRoot), reason, text);
  assert.deepEqual(plannedSuites('["packages/components","packages/niimath"]', repoRoot).map(({ dir, script }) => `${dir} ${script}`), ['packages/components test:unit', 'packages/niimath test']);
});

test('the package step checks that pnpm matches every listed package', () => {
  const suites = plannedSuites('["packages/niimath","packages/components"]', repoRoot);
  assert.deepEqual(unmatchedSuites(suites, repoRoot), []);
  assert.deepEqual(unmatchedSuites([...suites, { dir: 'packages/not-a-workspace-package' }], repoRoot).map(({ dir }) => dir), ['packages/not-a-workspace-package']);
});

test('the package step fails, under the step shell, on a malformed or unknown list', () => {
  for (const packages of ['{', '["packages/nonexistent"]']) {
    const result = spawnSync('bash', ['-eo', 'pipefail', '-c', 'node scripts/run-package-tests.mjs'], { cwd: repoRoot, encoding: 'utf8', env: { ...process.env, ALL_PACKAGES: 'false', PACKAGES: packages } });
    assert.equal(result.status, 1, packages);
    assert.match(result.stderr, /^::error title=Package tests::/m, packages);
  }
});
