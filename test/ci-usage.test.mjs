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

test('a run still going when the report is made counts up to then', () => {
  const until = '2026-11-10T12:00:00Z';
  const running = run({ status: 'in_progress', conclusion: null, updated_at: '2026-11-10T10:00:05Z' });
  const runs = [run({ status: 'completed' }), run({ status: 'completed' }), running];
  const usage = summarizeUsage(runs, new Map(largeRunCandidates(runs, until).map((each) => [each.id, LARGE_RUN_JOBS])), until);
  assert.match(budgetFindings(usage)[0], /^feature started 3 whole-catalogue ci runs/);
  assert.deepEqual(usage.largeRuns[0].runs.at(-1), { id: running.id, sha: running.head_sha.slice(0, 9), conclusion: 'in_progress', jobs: LARGE_RUN_JOBS, wallMinutes: 120 });
  // One that only just started has done no work yet.
  assert.deepEqual(largeRunCandidates([run({ status: 'queued', conclusion: null, run_started_at: '2026-11-10T11:59:00Z' })], until), []);
});

test('pull requests are told apart by number, and forks by repository', () => {
  const fork = (owner) => run({ head_branch: 'main', head_repository: `${owner}/webapps`, pull_requests: [] });
  assert.deepEqual(budgetFindings(usageOf([fork('ada'), fork('grace'), fork('alan')])), []);
  assert.match(budgetFindings(usageOf([fork('ada'), fork('ada'), fork('ada')]))[0], /^ada\/webapps:main started 3/);
  // The same pull request after its branch was renamed.
  const renamed = ['one', 'two', 'three'].map((head_branch) => run({ head_branch, head_repository: 'neurodesk/webapps', pull_requests: [788] }));
  assert.match(budgetFindings(usageOf(renamed))[0], /^#788 started 3/);
});

test('a release that runs most native workflows is listed, not over budget', () => {
  const push = (name, fields = {}) => run({ name, event: 'push', head_branch: 'main', head_sha: 'aaaaaaaaa1234', ...fields });
  const usage = usageOf([...Array.from({ length: 40 }, (_, index) => push(`native-${index}`)), push('ci'), push('gated-out', { minutes: 1 })]);
  assert.deepEqual(budgetFindings(usage), []);
  assert.equal(usage.pushes[0].workflows.length, 40);
  assert.match(usageMarkdown(usage, [], { since: 'a', until: 'b' }), /- aaaaaaaaa: 40 \(/);
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
