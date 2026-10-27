import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { approvalReport, publishApprovalReport } from '../scripts/lib/ci-approvals.mjs';

const run = (id, conclusion, head_sha = 'abc123') => ({ id, conclusion, head_sha, status: 'completed', run_attempt: 1 });

test('approval reporting groups commits and distinguishes failures, cancellations and approvals', async () => {
  const client = {
    async list(path) {
      assert.match(path, /^\/actions\/runs\?status=(?:failure|action_required)&created=%3E%3D2026-10-20T00%3A00%3A00Z$/);
      return [run(1, 'action_required'), run(2, 'action_required'), run(3, 'failure'), run(4, 'failure'), run(5, 'cancelled'), run(6, 'success')];
    },
    async request(path) {
      assert.match(path, /^\/actions\/runs\/[34]\/attempts\/1\/jobs\?per_page=1$/);
      return { total_count: path.includes('/4/') ? 300 : 0 };
    },
  };
  const report = await approvalReport(client, 'owner/repo', { now: new Date('2026-10-27T00:00:00Z') });
  assert.deepEqual(report.counts, { failedWithJobs: 1, failedWithoutJobs: 1, pendingApproval: 2, jobsUnknown: 0 });
  assert.match(report.body, /awaiting approval, 2 workflows/);
  assert.match(report.body, /failed without jobs, 1 workflows/);
  assert.doesNotMatch(report.body, /expired approval, 1 workflows/);
});

test('an unavailable job probe does not hide other runs or claim they had no jobs', async () => {
  const client = {
    list: async () => [run(1, 'failure'), run(2, 'action_required')],
    request: async () => { throw new Error('GitHub returned 502'); },
  };
  const report = await approvalReport(client, 'owner/repo');
  assert.deepEqual(report.counts, { failedWithJobs: 0, failedWithoutJobs: 0, pendingApproval: 1, jobsUnknown: 1 });
  assert.equal(report.actionable, true);
  assert.match(report.body, /job data unavailable, 1 workflows/);
  assert.match(report.body, /awaiting approval, 1 workflows/);
});

test('the privileged reporter executes default-branch code without installing dependencies', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/ci-approvals.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', issues: 'write' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  const steps = workflow.jobs.report.steps;
  assert.equal(steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(steps[0].with['persist-credentials'], false);
  assert.deepEqual(steps.filter(step => step.run).map(step => step.run), ['node scripts/report-ci-approvals.mjs']);
});

test('publishing is idempotent, ignores human issues, and closes a resolved report', async () => {
  const writes = [];
  const report = { body: '<!-- ci-approval-report -->\nreport', actionable: true };
  let issues = [{ number: 1, user: { login: 'human' }, body: report.body }];
  const client = { list: async () => issues, request: async (...args) => writes.push(args) };
  await publishApprovalReport(client, report);
  assert.equal(writes[0][0], '/issues');
  issues = [{ number: 2, user: { login: 'github-actions[bot]' }, state: 'open', body: report.body }];
  await publishApprovalReport(client, report);
  assert.equal(writes.length, 1);
  await publishApprovalReport(client, { ...report, actionable: false });
  assert.equal(writes[1][1].body.state, 'closed');
  assert.ok(writes.every(([path]) => path.startsWith('/issues')));
  issues[0].state = 'closed';
  await publishApprovalReport(client, report);
  assert.equal(writes[2][1].body.state, 'open');
});

test('a newly pending commit notifies issue subscribers once', async () => {
  const sha = 'a'.repeat(40);
  const issue = { number: 7, user: { login: 'github-actions[bot]' }, state: 'open', body: '<!-- ci-approval-report -->' };
  const comments = [];
  const client = {
    list: async () => [issue],
    async request(path, { body }) {
      if (path.endsWith('/comments')) comments.push(body.body);
      else Object.assign(issue, body);
    },
  };
  const report = { body: `<!-- ci-approval-report -->\n<!-- ci-commit:${sha}:approval -->`, actionable: true };
  await publishApprovalReport(client, report);
  await publishApprovalReport(client, report);
  assert.equal(comments.length, 1);
  assert.match(comments[0], /aaaaaaaaaaaa/);
});
