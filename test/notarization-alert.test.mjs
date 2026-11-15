import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import YAML from 'yaml';
import { ALERT_MARKER, NOTARIZATION_OWNER, NOTARIZING_WORKFLOWS, alertNotarization, notaryFailure } from '../scripts/lib/notarization-alert.mjs';

const AGREEMENT = '2026-11-13T15:51:01.7807410Z Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement that has not been signed or has expired.';
const ELECTRON = [
  '2026-11-14T05:16:37.2383030Z Error: Failed to notarize via notarytool.  Failed with unexpected result: ',
  '2026-11-14T05:16:37.2384000Z ',
  AGREEMENT,
].join('\n');

const run = {
  id: 43435308021, run_attempt: 1, name: 'syncro-native', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure',
  head_branch: 'syncro-v0.8.20261113',
};
const macJob = { id: 11, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] };
const linuxJob = { id: 12, name: 'portable / linux-x64', conclusion: 'failure', labels: ['ubuntu-latest'] };

function fakeClient({ jobs = [macJob, linuxJob], logs = { 11: AGREEMENT, 12: AGREEMENT }, issues = [], comments = [] } = {}) {
  const calls = [];
  return {
    calls,
    async list(path) {
      calls.push({ path });
      if (path.includes('/jobs')) return jobs;
      if (path.startsWith('/issues?')) return issues.map(issue => ({ user: { login: 'github-actions[bot]' }, ...issue }));
      if (path.endsWith('/comments')) return comments.map(comment => ({ user: { login: 'github-actions[bot]' }, ...comment }));
      throw new Error(`Unexpected list ${path}`);
    },
    async request(path, options = {}) {
      calls.push({ path, ...options });
      if (options.logs) return { text: logs[path.match(/jobs\/(\d+)/)[1]], truncated: false };
      return { number: 9 };
    },
  };
}
const alert = (client, overrides = {}) => alertNotarization({ run: { ...run, ...overrides }, repository: 'owner/repo', client });
const writes = client => client.calls.filter(call => call.method);

test('the alert watches every workflow that notarizes, from a trusted checkout', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const notarizing = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.yml') || file === 'notarization-alert.yml') continue;
    const source = await readFile(new URL(file, directory), 'utf8');
    const workflow = YAML.parse(source);
    if (workflow.on?.workflow_call) continue;
    if (/notar|APPLE_ID|uses: \.\/\.github\/workflows\/node-cli-portable\.yml/i.test(source)) notarizing.push(workflow.name);
  }
  const workflow = YAML.parse(await readFile(new URL('notarization-alert.yml', directory), 'utf8'));
  assert.deepEqual([...NOTARIZING_WORKFLOWS].sort(), notarizing.sort());
  assert.deepEqual(workflow.on.workflow_run.workflows, NOTARIZING_WORKFLOWS);
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.equal(workflow.on.workflow_run.branches, undefined, 'release dispatches run on tags');
  assert.match(workflow.jobs.alert.if, /conclusion == 'failure'/);
  assert.match(workflow.jobs.alert.if, /event != 'pull_request'/);
  assert.equal(workflow.jobs.alert.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(workflow.jobs.alert.steps[0].with['persist-credentials'], false);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', issues: 'write' });
});

test('notaryFailure finds what notarytool and @electron/notarize print when Apple refuses', () => {
  assert.match(notaryFailure(`setup\n${AGREEMENT}\n##[error]Process completed with exit code 1.`), /^Error: HTTP status code: 403\. A required agreement/);
  assert.match(notaryFailure(ELECTRON), /^Error: HTTP status code: 403/);
  assert.match(notaryFailure('2026-11-14T05:00:00.0Z Error: HTTP status code: 401. Invalid credentials. Username or password is incorrect.'), /401/);
  assert.equal(notaryFailure('Processing complete\n2026-11-14T05:00:00.0Z   status: Invalid\n'), 'status: Invalid');
  assert.equal(notaryFailure('Processing complete\n  status: Accepted\n'), undefined);
  assert.equal(notaryFailure('curl: (22) The requested URL returned error: 403\nError: HTTP 403 from huggingface.co'), undefined);
  assert.equal(notaryFailure('Error: HTTP status code: 500. Internal error'), undefined);
});

test('a refused notarization opens an issue assigned to the owner, reading only failed macOS logs', async () => {
  const client = fakeClient();
  assert.deepEqual(await alert(client), { issue: 9, created: true });
  assert.deepEqual(client.calls.filter(call => call.logs).map(call => call.path), ['/actions/jobs/11/logs']);
  const [created] = writes(client);
  assert.equal(created.path, '/issues');
  assert.equal(created.body.title, 'Apple notarization is failing');
  assert.deepEqual(created.body.assignees, [NOTARIZATION_OWNER]);
  assert.ok(created.body.body.startsWith(`${ALERT_MARKER}\n<!-- notarization-run:43435308021:attempt:1 -->`));
  assert.match(created.body.body, /portable \/ release\]\(https:\/\/github\.com\/owner\/repo\/actions\/runs\/43435308021\/job\/11\): Error: HTTP status code: 403/);
  assert.match(created.body.body, /gh run rerun 43435308021 --failed --repo owner\/repo/);
});

test('later failures comment on the open issue, reopen a closed one and never repeat an attempt', async () => {
  const open = fakeClient({ issues: [{ number: 5, state: 'open', body: `${ALERT_MARKER}\nold` }] });
  assert.deepEqual(await alert(open, { run_attempt: 2 }), { issue: 5, updated: true });
  assert.deepEqual(writes(open).map(call => [call.path, call.method]), [['/issues/5/comments', 'POST']]);
  assert.ok(writes(open)[0].body.body.startsWith('<!-- notarization-run:43435308021:attempt:2 -->'));

  const closed = fakeClient({ issues: [{ number: 5, state: 'closed', body: `${ALERT_MARKER}\nold` }] });
  await alert(closed);
  assert.deepEqual(writes(closed).map(call => [call.path, call.method, call.body.state, call.body.assignees]), [
    ['/issues/5', 'PATCH', 'open', [NOTARIZATION_OWNER]],
    ['/issues/5/comments', 'POST', undefined, undefined],
  ]);

  const repeated = fakeClient({ issues: [{ number: 5, state: 'open', body: `${ALERT_MARKER}\nold` }], comments: [{ body: '<!-- notarization-run:43435308021:attempt:1 -->\nseen' }] });
  assert.deepEqual(await alert(repeated), { issue: 5, duplicate: true });
  assert.deepEqual(writes(repeated), []);

  const other = fakeClient({ issues: [{ number: 6, state: 'open', body: '<!-- nightly-workflow:1 -->\nother' }] });
  assert.deepEqual(await alert(other), { issue: 9, created: true });
});

test('other failures, pull requests and unrelated workflows raise nothing', async () => {
  const unrelated = fakeClient({ logs: { 11: 'error: parity failed', 12: AGREEMENT } });
  assert.deepEqual(await alert(unrelated), { skipped: 'No notarization failure in the failed macOS jobs' });
  for (const overrides of [{ conclusion: 'success' }, { conclusion: 'cancelled' }, { event: 'pull_request' }, { name: 'ci' }]) {
    const client = fakeClient();
    assert.ok((await alert(client, overrides)).skipped);
    assert.deepEqual(client.calls, []);
  }
});
