import assert from 'node:assert/strict';
import test from 'node:test';
import { BUDGETS, budgetFindings, largeRunCandidates, LARGE_RUN_JOBS, summarizeUsage, usageMarkdown } from '../scripts/lib/ci-usage.mjs';

let next = 1;
const run = (fields) => {
  const minutes = fields.minutes ?? 30;
  return {
    id: next++,
    name: 'ci',
    event: 'pull_request',
    conclusion: 'success',
    head_branch: 'feature',
    head_sha: `${String(next).padStart(9, '0')}abcdef`,
    created_at: '2026-11-10T10:00:00Z',
    run_started_at: '2026-11-10T10:00:00Z',
    updated_at: new Date(Date.parse('2026-11-10T10:00:00Z') + minutes * 60e3).toISOString(),
    ...fields,
  };
};
const usageOf = (runs, jobs = LARGE_RUN_JOBS) => summarizeUsage(runs, new Map(largeRunCandidates(runs).map((each) => [each.id, jobs])));

test('a pull request that repeats whole-catalogue runs is over budget', () => {
  const allowed = Array.from({ length: BUDGETS.largeRunsPerPullRequest }, () => run({}));
  assert.deepEqual(budgetFindings(usageOf(allowed)), []);
  // A run cancelled by the next push still used its runners until then.
  const findings = budgetFindings(usageOf([...allowed, run({ conclusion: 'cancelled' })]));
  assert.equal(findings.length, 1);
  assert.match(findings[0], /^feature started 3 whole-catalogue ci runs \(budget 2\)/);
});

test('small, draft-tier and skipped ci runs do not count as whole-catalogue runs', () => {
  const runs = Array.from({ length: 5 }, () => run({}));
  assert.deepEqual(budgetFindings(usageOf(runs, LARGE_RUN_JOBS - 1)), []);
  const quick = [run({ minutes: 1 }), run({ conclusion: 'skipped' }), run({ event: 'push', head_branch: 'main' })];
  assert.deepEqual(largeRunCandidates(quick), []);
});

test('many pull requests selecting every app are over the total budget', () => {
  const runs = Array.from({ length: BUDGETS.largeRuns + 1 }, (_, index) => run({ head_branch: `feature-${index}` }));
  const findings = budgetFindings(usageOf(runs));
  assert.equal(findings.length, 1);
  assert.match(findings[0], new RegExp(`^${BUDGETS.largeRuns + 1} whole-catalogue pull request ci runs`));
});

test('one push to main that runs most native workflows is over budget', () => {
  const push = (name, fields = {}) => run({ name, event: 'push', head_branch: 'main', head_sha: 'aaaaaaaaa1234', ...fields });
  const natives = Array.from({ length: BUDGETS.workflowsPerPush + 1 }, (_, index) => push(`native-${index}`));
  const [finding, ...rest] = budgetFindings(usageOf(natives));
  assert.match(finding, /^push aaaaaaaaa ran 11 workflows besides ci \(budget 10\)/);
  assert.deepEqual(rest, []);
  // ci and the deploy run for every push, and a gate that answered false did no work.
  const fine = [...natives.slice(1), push('ci'), push('deploy-github-pages'), push('gated-out', { minutes: 1 })];
  assert.deepEqual(budgetFindings(usageOf(fine)), []);
  // Pushes are counted one by one.
  const other = natives.map((each, index) => (index < 6 ? each : { ...each, head_sha: 'bbbbbbbbb1234' }));
  assert.deepEqual(budgetFindings(usageOf(other)), []);
});

test('the report lists the runs behind each finding', () => {
  const runs = [run({}), run({}), run({ conclusion: 'cancelled' })];
  const usage = usageOf(runs);
  const text = usageMarkdown(usage, budgetFindings(usage), { since: 'a', until: 'b' });
  assert.match(text, /### Over budget\n\n- feature started 3/);
  assert.match(text, /- feature: .*\(100 jobs, 30 min, cancelled\)/);
  assert.match(text, /\| ci \| pull_request \| 3 \| 3 \| 1 \| 90 \|/);
  assert.match(usageMarkdown(usageOf([]), [], { since: 'a', until: 'b' }), /### Inside every budget/);
});
