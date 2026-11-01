import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { publishApprovalReport } from '../scripts/lib/ci-approvals.mjs';

test('the privileged reporter executes default-branch code without installing dependencies', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/ci-approvals.yml', import.meta.url), 'utf8'));
  assert.deepEqual(Object.keys(workflow.on).sort(), ['schedule', 'workflow_dispatch']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', checks: 'read', 'pull-requests': 'read', issues: 'write' });
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
  issues = [];
  assert.deepEqual(await publishApprovalReport(client, { ...report, actionable: false }), { skipped: true });
});

test('notifications track new PR blockers and remain quiet across pushes and age updates', async () => {
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
  const report = { body: `<!-- ci-approval-report -->\n<!-- ci-pr:42:approval:${sha} -->`, actionable: true };
  await publishApprovalReport(client, report);
  await publishApprovalReport(client, report);
  await publishApprovalReport(client, { ...report, body: report.body.replace(sha, 'b'.repeat(40)) + '\nCreated 3h ago.' });
  assert.equal(comments.length, 1);
  assert.match(comments[0], /#42.*awaiting approval/);
  const failed = { ...report, body: report.body.replace(':approval:', ':no-jobs:') };
  await publishApprovalReport(client, failed);
  await publishApprovalReport(client, failed);
  assert.equal(comments.length, 2);
  assert.match(comments[1], /#42.*failed without jobs/);
  await publishApprovalReport(client, { ...failed, body: failed.body + `\n<!-- ci-pr:43:approval:${sha} -->` });
  assert.equal(comments.length, 3);
  assert.match(comments[2], /#43.*awaiting approval/);
  assert.doesNotMatch(comments[2], /#42/);
});

test('upgrading a legacy report does not renotify an unchanged pending commit', async () => {
  const sha = 'a'.repeat(40);
  const issue = { number: 7, user: { login: 'github-actions[bot]' }, state: 'open', body: `<!-- ci-approval-report -->\n<!-- ci-commit:${sha}:approval -->` };
  const comments = [];
  const client = {
    list: async () => [issue],
    async request(path, { body }) {
      if (path.endsWith('/comments')) comments.push(body.body);
      else Object.assign(issue, body);
    },
  };
  const report = { body: `<!-- ci-approval-report -->\n<!-- ci-pr:42:approval:${sha} -->`, actionable: true };
  await publishApprovalReport(client, report);
  assert.equal(comments.length, 0);
  assert.equal(issue.body, report.body);
});
