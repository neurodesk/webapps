import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalReport, publishApprovalReport } from '../scripts/lib/ci-approvals.mjs';

const now = new Date('2026-10-27T12:00:00Z');
const sha = 'a'.repeat(40);
const source = { id: 123, full_name: 'contributor/repo' };
const pull = (overrides = {}) => ({
  number: 42,
  title: 'Improve the pipeline',
  state: 'open',
  user: { login: 'contributor' },
  head: { sha, ref: 'feature', repo: source },
  ...overrides,
});
const run = (id, conclusion, overrides = {}) => ({
  id,
  conclusion,
  head_sha: sha,
  head_branch: 'feature',
  head_repository: source,
  event: 'pull_request',
  pull_requests: [],
  status: 'completed',
  run_attempt: 1,
  workflow_id: id,
  name: `Workflow ${id}`,
  check_suite_id: id,
  created_at: '2026-10-27T10:00:00Z',
  ...overrides,
});

function fixture({ pulls = [pull()], runs = [], latest = runs, jobs = {}, checks = {}, annotations = {}, unavailable = [] } = {}) {
  const calls = [];
  function record(path) {
    calls.push(path);
    if (unavailable.some(value => path.includes(value))) throw new Error('GitHub returned 502');
  }
  return {
    calls,
    async list(path) {
      record(path);
      if (path === '/pulls?state=open') return pulls;
      const url = new URL(path, 'https://api.github.com');
      if (url.pathname === '/actions/runs') {
        const status = url.searchParams.get('status');
        if (status) {
          const since = url.searchParams.get('created')?.replace('>=', '');
          return runs.filter(item => (item.conclusion === status || item.status === status) && (!since || item.created_at >= since));
        }
        return latest.filter(item => item.head_sha === url.searchParams.get('head_sha'));
      }
      const suite = path.match(/^\/check-suites\/(\d+)\/check-runs\?/);
      if (suite) return checks[suite[1]] ?? [];
      const check = path.match(/^\/check-runs\/(\d+)\/annotations$/);
      if (check) return annotations[check[1]] ?? [];
      throw new Error(`Unexpected list: ${path}`);
    },
    async request(path) {
      record(path);
      if (path.startsWith('/actions/workflows/')) {
        const url = new URL(path, 'https://api.github.com');
        const id = Number(url.pathname.split('/')[3]);
        const matches = latest.filter(item => item.workflow_id === id && item.head_branch === url.searchParams.get('branch') && item.event === url.searchParams.get('event'));
        return { workflow_runs: matches.sort((a, b) => b.id - a.id).slice(0, 1) };
      }
      const match = path.match(/^\/actions\/runs\/(\d+)\/attempts\/(\d+)\/jobs\?per_page=1$/);
      assert.ok(match, `Unexpected request: ${path}`);
      return { total_count: jobs[`${match[1]}:${match[2]}`] ?? 0 };
    },
  };
}

test('approval reporting groups current PR workflows with review links and waiting time', async () => {
  const client = fixture({
    runs: [run(1, 'action_required'), run(2, 'action_required'), run(3, 'failure'), run(4, 'failure'), run(5, 'cancelled'), run(6, 'success')],
    jobs: { '4:1': 300 },
  });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.deepEqual(report.counts, { failedWithJobs: 1, failedWithoutJobs: 1, pendingApproval: 2, jobsUnknown: 0, obsolete: 0, superseded: 0 });
  assert.equal(report.body.split('### [#42').length, 2);
  assert.ok(report.body.includes('[#42: Improve the pipeline](https://github.com/owner/repo/pull/42)'));
  assert.match(report.body, /contributor/);
  assert.match(report.body, /Current commit: aaaaaaaaaaaa/);
  assert.ok(report.body.includes(`<!-- ci-pr:42:approval:${sha} -->`));
  assert.ok(report.body.includes(`<!-- ci-pr:42:no-jobs:${sha} -->`));
  assert.match(report.body, /2h/);
  assert.ok(report.body.includes('[Workflow 1](https://github.com/owner/repo/actions/runs/1/attempts/1)'));
  assert.ok(report.body.includes('[Workflow 2](https://github.com/owner/repo/actions/runs/2/attempts/1)'));
  assert.match(report.body, /failed without jobs, cause unknown/);
  assert.doesNotMatch(report.body, /expired approval/);
});

test('closed PRs, merged PRs and older commits are excluded without probing their jobs', async () => {
  const client = fixture({ runs: [
    run(1, 'action_required', { head_sha: 'b'.repeat(40) }),
    run(2, 'failure', { pull_requests: [{ number: 99 }], head_branch: 'closed-associated-feature' }),
    run(3, 'failure', { head_branch: 'closed-feature' }),
    run(4, 'failure', { head_branch: 'merged-feature' }),
  ] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.actionable, false);
  assert.equal(report.counts.obsolete, 4);
  assert.equal(report.counts.pendingApproval, 0);
  assert.equal(report.counts.failedWithoutJobs, 0);
  assert.doesNotMatch(report.body, /### /);
  assert.match(report.body, /Exclusion does not establish that checks passed/);
  assert.ok(client.calls.every(path => !path.includes('/jobs?')));
});

test('fork runs require matching source repository, branch and commit', async () => {
  const client = fixture({ runs: [
    run(1, 'action_required'),
    run(2, 'action_required', { head_repository: { id: 999, full_name: 'someone-else/repo' } }),
    run(3, 'action_required', { head_branch: 'unrelated' }),
  ] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.pendingApproval, 1);
  assert.equal(report.counts.obsolete, 2);
  assert.match(report.body, /Workflow 1/);
  assert.doesNotMatch(report.body, /Workflow [23]/);
});

test('a current PR merge commit is associated with its head PR', async () => {
  const merge = 'c'.repeat(40);
  const client = fixture({ pulls: [pull({ merge_commit_sha: merge })], runs: [run(1, 'action_required', { head_sha: merge })] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.pendingApproval, 1);
  assert.match(report.body, /Current commit: aaaaaaaaaaaa/);
});

test('successful, cancelled and running reruns supersede an earlier failed attempt', async (t) => {
  for (const conclusion of ['success', 'cancelled', null]) {
    await t.test(String(conclusion), async () => {
      const old = run(1, 'failure');
      const client = fixture({ runs: [old], latest: [{ ...old, run_attempt: 2, conclusion, status: conclusion ? 'completed' : 'in_progress' }] });
      const report = await approvalReport(client, 'owner/repo', { now });
      assert.equal(report.actionable, false);
      assert.equal(report.counts.superseded, 1);
      assert.ok(client.calls.every(path => !path.includes('/jobs?')));
      assert.match(report.body, /Exclusion does not establish that checks passed/);
    });
  }
});

test('a newer run of the same workflow supersedes an old approval request', async () => {
  const old = run(1, 'action_required');
  const client = fixture({ runs: [old], latest: [old, run(2, 'success', { workflow_id: 1 })] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.actionable, false);
  assert.equal(report.counts.superseded, 1);
});

test('a newer failing workflow run remains visible and is counted once', async () => {
  const old = run(1, 'failure');
  const latest = run(2, 'failure', { workflow_id: 1 });
  const client = fixture({ runs: [old, latest], latest: [old, latest] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.failedWithoutJobs, 1);
  assert.equal(report.counts.superseded, 1);
  assert.equal(report.body.split('/actions/runs/2/attempts/1').length, 2);
  assert.doesNotMatch(report.body, /\/actions\/runs\/1\//);
});

test('a newly failing run discovered during refresh remains actionable', async () => {
  const old = run(1, 'action_required');
  const client = fixture({ runs: [old], latest: [old, run(2, 'failure', { workflow_id: 1 })] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.failedWithoutJobs, 1);
  assert.equal(report.counts.pendingApproval, 0);
  assert.ok(report.body.includes('/actions/runs/2/attempts/1'));
});

test('another event cannot hide a blocked PR workflow', async () => {
  const old = run(1, 'action_required');
  const client = fixture({ runs: [old], latest: [old, run(2, 'success', { workflow_id: 1, event: 'push' })] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.pendingApproval, 1);
});

test('a failing rerun probes and links its latest attempt exactly once', async () => {
  const old = run(1, 'failure');
  const client = fixture({ runs: [old], latest: [{ ...old, run_attempt: 2 }] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.failedWithoutJobs, 1);
  assert.ok(report.body.includes('/actions/runs/1/attempts/2'));
  assert.deepEqual(client.calls.filter(path => path.includes('/jobs?')), ['/actions/runs/1/attempts/2/jobs?per_page=1']);
});

test('non-PR startup failures remain visible', async () => {
  const client = fixture({ pulls: [], runs: [run(1, 'failure', { event: 'schedule', head_branch: 'main' })] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.actionable, true);
  assert.match(report.body, /Other runs/);
  assert.match(report.body, /main/);
});

test('an unavailable job probe preserves the run without claiming it had no jobs', async () => {
  const client = fixture({ runs: [run(1, 'failure'), run(2, 'action_required')], unavailable: ['/runs/1/attempts/1/jobs'] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.jobsUnknown, 1);
  assert.equal(report.counts.failedWithoutJobs, 0);
  assert.equal(report.counts.pendingApproval, 1);
  assert.equal(report.actionable, true);
  assert.match(report.body, /job data unavailable/);
});

test('no-job diagnostics use GitHub failure annotations and escape contributor text', async () => {
  const client = fixture({
    pulls: [pull({ title: 'Bad [link](https://example.org) @everyone <script>' })],
    runs: [run(1, 'failure', { name: 'Check *one*' })],
    checks: { 1: [{ id: 100, conclusion: 'failure', output: { annotations_count: 1 } }] },
    annotations: { 100: [{ annotation_level: 'failure', message: 'Invalid workflow file: unknown key. token=ghp_private123 @everyone' }] },
  });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.match(report.body, /Invalid workflow file: unknown key/);
  assert.ok(report.body.includes('Check \\*one\\*'));
  assert.doesNotMatch(report.body, /<script>|@everyone|ghp_private123|\[link\]\(https/);
  assert.doesNotMatch(report.body, /cause unknown/);
});

test('check output is useful when GitHub has no failure annotations', async () => {
  const client = fixture({
    runs: [run(1, 'failure')],
    checks: { 1: [{ id: 100, conclusion: 'failure', output: { summary: 'Workflow validation failed', annotations_count: 0 } }] },
  });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.match(report.body, /Workflow validation failed/);
});

test('unavailable annotation lookup retains the available check diagnostic', async () => {
  const client = fixture({
    runs: [run(1, 'failure')],
    checks: { 1: [{ id: 100, conclusion: 'failure', output: { summary: 'Workflow validation failed', annotations_count: 1 } }] },
    unavailable: ['/annotations'],
  });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.match(report.body, /Workflow validation failed/);
  assert.doesNotMatch(report.body, /cause unknown/);
});

test('unavailable diagnostics remain unknown without hiding the run', async () => {
  const client = fixture({ runs: [run(1, 'failure')], unavailable: ['/check-suites/'] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.actionable, true);
  assert.match(report.body, /failed without jobs, cause unknown/);
  assert.match(report.body, /run annotation/);
  assert.doesNotMatch(report.body, /expired approval/);
});

test('a failed PR or current-run lookup aborts instead of silently resolving the report', async (t) => {
  for (const path of ['/pulls?', 'head_sha=']) {
    await t.test(path, async () => {
      const client = fixture({ runs: [run(1, 'action_required')], unavailable: [path] });
      await assert.rejects(approvalReport(client, 'owner/repo', { now }), /GitHub returned 502/);
    });
  }
});

test('large reports stay within the issue size limit and identify omitted details', async () => {
  const client = fixture({ runs: Array.from({ length: 500 }, (_, index) => run(index + 1, 'action_required', { name: 'Long workflow name '.repeat(20) })) });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.counts.pendingApproval, 500);
  assert.equal(report.actionable, true);
  assert.ok(report.body.length <= 60000);
  assert.ok(report.body.endsWith('Counts include all current blockers.'));
  assert.ok(report.body.includes('[Inspect all workflow runs](https://github.com/owner/repo/actions)'));
});

function issueFixture() {
  const issue = { number: 7, user: { login: 'github-actions[bot]' }, state: 'closed', body: '<!-- ci-approval-report -->' };
  const comments = [];
  return {
    issue,
    comments,
    list: async () => [issue],
    async request(path, { body }) {
      if (path.endsWith('/comments')) comments.push(body.body);
      else Object.assign(issue, body);
    },
  };
}

test('current PR blockers remain actionable after the seven-day history window', async () => {
  const client = fixture({ runs: [
    run(1, 'action_required', { created_at: '2026-10-01T00:00:00Z' }),
    run(2, 'failure', { created_at: '2026-10-01T00:00:00Z' }),
  ] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.actionable, true);
  assert.equal(report.counts.pendingApproval, 1);
  assert.equal(report.counts.failedWithoutJobs, 1);
  assert.match(report.body, /26d 12h/);
});

test('temporary job-probe errors neither announce unknown blockers nor renotify known ones', async () => {
  const publisher = issueFixture();
  for (const unavailable of [[], ['/jobs?'], [], []]) {
    const report = await approvalReport(fixture({ runs: [run(1, 'failure')], unavailable }), 'owner/repo', { now });
    await publishApprovalReport(publisher, report);
  }
  assert.equal(publisher.comments.length, 1);
  assert.match(publisher.comments[0], /#42.*failed without jobs/);
  const ordinary = issueFixture();
  const report = await approvalReport(fixture({ runs: [run(1, 'failure')], unavailable: ['/jobs?'] }), 'owner/repo', { now });
  await publishApprovalReport(ordinary, report);
  assert.equal(ordinary.comments.length, 0);
  assert.equal(ordinary.issue.state, 'open');
});

test('truncation preserves every PR notification marker as detail sections move', async () => {
  const publisher = issueFixture();
  for (const extra of [false, true, false]) {
    const pulls = Array.from({ length: extra ? 6 : 5 }, (_, index) => pull({ number: index + 1, head: { sha, ref: `feature-${index + 1}`, repo: source } }));
    const runs = pulls.flatMap(item => Array.from({ length: 50 }, (_, index) => run(item.number * 100 + index, 'action_required', { head_branch: item.head.ref, name: 'Large workflow '.repeat(30) })));
    const report = await approvalReport(fixture({ pulls, runs }), 'owner/repo', { now });
    assert.ok(report.body.length <= 60000);
    for (const item of pulls) assert.ok(report.body.includes(`<!-- ci-pr:${item.number}:approval:${sha} -->`));
    await publishApprovalReport(publisher, report);
  }
  assert.equal(publisher.comments.length, 2);
  assert.match(publisher.comments[1], /#6/);
  assert.doesNotMatch(publisher.comments[1], /#[1-5]/);
});

test('a newer successful non-PR commit resolves an older startup failure', async () => {
  const old = run(1, 'failure', { event: 'push', head_branch: 'main' });
  const client = fixture({ pulls: [], runs: [old], latest: [old, run(2, 'success', { workflow_id: 1, event: 'push', head_branch: 'main', head_sha: 'b'.repeat(40) })] });
  const report = await approvalReport(client, 'owner/repo', { now });
  assert.equal(report.actionable, false);
  assert.equal(report.counts.superseded, 1);
});

test('non-PR failures outside the history window remain excluded', async () => {
  const report = await approvalReport(fixture({ pulls: [], runs: [run(1, 'failure', { event: 'schedule', head_branch: 'main', created_at: '2026-10-01T00:00:00Z' })] }), 'owner/repo', { now });
  assert.equal(report.actionable, false);
});

test('a failed non-PR workflow lookup aborts instead of resolving a blocker', async () => {
  const client = fixture({ pulls: [], runs: [run(1, 'failure', { event: 'schedule', head_branch: 'main' })], unavailable: ['/actions/workflows/'] });
  await assert.rejects(approvalReport(client, 'owner/repo', { now }), /GitHub returned 502/);
});

test('an unrelated PR association cannot hide an exact source and head match', async () => {
  const report = await approvalReport(fixture({ runs: [run(1, 'action_required', { pull_requests: [{ number: 99 }] })] }), 'owner/repo', { now });
  assert.equal(report.counts.pendingApproval, 1);
  assert.match(report.body, /#42: Improve the pipeline/);
});

test('startup_failure conclusions remain actionable on current PRs', async () => {
  const report = await approvalReport(fixture({ runs: [run(1, 'startup_failure')] }), 'owner/repo', { now });
  assert.equal(report.actionable, true);
  assert.equal(report.counts.failedWithoutJobs, 1);
});

test('a recent rerun of an older run supersedes a newer failed run at the same commit', async () => {
  const old = run(1, 'failure', { created_at: '2026-10-27T08:00:00Z' });
  const newer = run(2, 'failure', { workflow_id: 1, created_at: '2026-10-27T09:00:00Z' });
  const rerun = { ...old, conclusion: 'success', run_attempt: 2, run_started_at: '2026-10-27T10:00:00Z' };
  const report = await approvalReport(fixture({ runs: [old, newer], latest: [rerun, newer] }), 'owner/repo', { now });
  assert.equal(report.actionable, false);
});
