import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isProductionSource,
  runMaintainabilityReport,
  upstreamApps,
  workspaceReach,
} from '../scripts/report-maintainability.mjs';

function fixture(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'maintainability-report-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  execFileSync('git', ['init'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test'], { cwd, stdio: 'ignore' });

  mkdirSync(join(cwd, 'packages/core/src'), { recursive: true });
  mkdirSync(join(cwd, 'packages/core/test'), { recursive: true });
  mkdirSync(join(cwd, 'apps/firstparty/src'), { recursive: true });
  mkdirSync(join(cwd, 'apps/upstreamapp/src'), { recursive: true });

  writeFileSync(join(cwd, 'packages/core/package.json'), JSON.stringify({ name: '@test/core', type: 'module' }));
  writeFileSync(join(cwd, 'apps/firstparty/package.json'), JSON.stringify({ name: 'firstparty', dependencies: { '@test/core': 'workspace:*' } }));
  writeFileSync(join(cwd, 'apps/upstreamapp/package.json'), JSON.stringify({ name: 'upstreamapp', dependencies: { '@test/core': 'workspace:*' } }));
  writeFileSync(join(cwd, 'apps/upstreamapp/upstream.json'), JSON.stringify({ repository: 'https://example.test/upstream' }));

  const complexFn = [
    'export function branchy(a, b, c, d) {',
    '  let total = 0;',
    '  if (a === 1) total += 1;',
    '  if (a === 2) total += 2;',
    '  if (b === 1) total += 3;',
    '  if (b === 2) total += 4;',
    '  if (c === 1) total += 5;',
    '  if (d === 1) total += 6;',
    '  return total;',
    '}',
  ].join('\n');

  writeFileSync(join(cwd, 'packages/core/src/complex.js'), `${complexFn}\n`);
  writeFileSync(join(cwd, 'packages/core/test/complex.test.js'), `${complexFn}\n`);
  writeFileSync(join(cwd, 'apps/firstparty/src/clean.ts'), 'export function clean(x: number): number { return x + 1; }\n');
  writeFileSync(join(cwd, 'apps/upstreamapp/src/ported.js'), `${complexFn}\n`);

  execFileSync('git', ['add', '.'], { cwd, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd, stdio: 'ignore' });
  return cwd;
}

test('maintainability report separates first-party and upstream apps with separate triage columns', async (t) => {
  const cwd = fixture(t);
  assert.deepEqual([...upstreamApps(cwd)], ['apps/upstreamapp/']);
  const reach = workspaceReach(cwd);
  assert.equal(reach.get('packages/core'), 2);
  assert.equal(reach.get('apps/firstparty'), 0);

  const { report, markdown, outDir } = await runMaintainabilityReport({
    cwd,
    threshold: 5,
    days: 90,
    output: 'out',
  });

  assert.equal(report.filesChecked, 3);
  assert.equal(report.filesAnalyzed, 3);
  assert.deepEqual(report.parseErrors, []);
  assert.deepEqual(report.firstParty.map((e) => e.file), ['packages/core/src/complex.js']);
  assert.equal(report.firstParty[0].maxComplexity, 7);
  assert.equal(report.firstParty[0].commits, 1);
  assert.equal(report.firstParty[0].manifestReach, 2);
  assert.deepEqual(report.upstreamTracked.map((e) => e.file), ['apps/upstreamapp/src/ported.js']);
  assert.match(markdown, /\| File \| Max complexity \| Functions > 5 \| Commits \(90d\) \| Manifest reach \|/);
  assert.doesNotMatch(markdown, /complex\.test\.js/);
  assert.doesNotMatch(markdown, /clean\.ts/);

  const saved = JSON.parse(readFileSync(join(outDir, 'report.json'), 'utf8'));
  assert.equal(saved.firstParty[0].file, 'packages/core/src/complex.js');
});

test('production filter excludes test, e2e, validation and template sources', () => {
  assert.equal(isProductionSource('packages/components/src/automation/abort.js'), true);
  assert.equal(isProductionSource('packages/components/test/automation-abort.test.js'), false);
  assert.equal(isProductionSource('apps/zarro/e2e/smoke.spec.js'), false);
  assert.equal(isProductionSource('templates/app-template/src/main.js'), false);
});

test('optional rule audit counts eqeqeq and no-shadow without failing', async (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'apps/firstparty/src/audit.ts'), 'export function f(x: number) { if (x == 1) { const x = 2; return x; } return x == null ? 0 : x; }\n');
  const { ruleAudit, markdown } = await runMaintainabilityReport({
    cwd,
    threshold: 15,
    output: 'out-audit',
    auditRules: true,
    files: ['apps/firstparty/src/audit.ts'],
  });
  assert.equal(ruleAudit.counts.eqeqeq, 1);
  assert.equal(ruleAudit.counts['no-shadow'], 1);
  assert.equal(ruleAudit.filesAnalyzed, 1);
  assert.deepEqual(ruleAudit.parseErrors, []);
  assert.match(markdown, /Optional ESLint rule audit/);
});

test('fatal parse errors are reported explicitly instead of counted as analyzed', async (t) => {
  const cwd = fixture(t);
  writeFileSync(join(cwd, 'apps/firstparty/src/broken.js'), 'export function broken( {\n');
  const { report, ruleAudit, markdown } = await runMaintainabilityReport({
    cwd,
    threshold: 5,
    output: 'out-broken',
    auditRules: true,
    files: ['apps/firstparty/src/clean.ts', 'apps/firstparty/src/broken.js'],
  });
  assert.equal(report.filesChecked, 2);
  assert.equal(report.filesAnalyzed, 1);
  assert.equal(report.parseErrors.length, 1);
  assert.equal(report.parseErrors[0].file, 'apps/firstparty/src/broken.js');
  assert.equal(ruleAudit.filesAnalyzed, 1);
  assert.equal(ruleAudit.parseErrors.length, 1);
  assert.match(markdown, /Parse errors \(1 files could not be analyzed\)/);
  assert.match(markdown, /apps\/firstparty\/src\/broken\.js/);
});
