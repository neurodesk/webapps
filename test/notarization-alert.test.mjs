import assert from 'node:assert/strict';
import test from 'node:test';
import { ALERT_MARKER, NOTARIZATION_OWNER, alertNotarization, notaryFailure } from '../scripts/lib/notarization-alert.mjs';

const AGREEMENT = '2026-11-13T15:51:01.7807410Z Error: HTTP status code: 403. A required agreement is missing or has expired. This request requires an in-effect agreement that has not been signed or has expired.';
const ELECTRON = [
  '2026-11-14T05:16:37.2383030Z Error: Failed to notarize via notarytool.  Failed with unexpected result: ',
  '2026-11-14T05:16:37.2384000Z ',
  AGREEMENT,
].join('\n');

const run = {
  id: 43435308021, run_attempt: 1, name: 'syncro-native', event: 'workflow_dispatch', status: 'completed', conclusion: 'failure',
  head_branch: 'syncro-v0.8.20261113', path: '.github/workflows/syncro-native.yml', head_repository: { full_name: 'owner/repo' },
};
const notarizing = ['.github/workflows/standalone.yml', '.github/workflows/syncro-native.yml'];
const macJob = { id: 11, name: 'portable / release', conclusion: 'failure', labels: ['macos-15'] };
const linuxJob = { id: 12, name: 'portable / linux-x64', conclusion: 'failure', labels: ['ubuntu-latest'] };

function fakeClient({ jobs = [macJob, linuxJob], logs = { 11: AGREEMENT, 12: AGREEMENT }, truncated = false, issues = [], issuesAfter, comments = [] } = {}) {
  const calls = [];
  let listed = 0;
  return {
    calls,
    async list(path) {
      calls.push({ path });
      if (path.includes('/jobs')) return jobs;
      if (path.startsWith('/issues?')) return (listed++ && issuesAfter ? issuesAfter : issues).map(issue => ({ user: { login: 'github-actions[bot]' }, ...issue }));
      if (path.endsWith('/comments')) return comments.map(comment => ({ user: { login: 'github-actions[bot]' }, ...comment }));
      throw new Error(`Unexpected list ${path}`);
    },
    async request(path, options = {}) {
      calls.push({ path, ...options });
      if (options.logs) {
        assert.equal(options.logLimit, 64 * 1024 * 1024, 'reads far enough for a whole macOS release log');
        return { text: logs[path.match(/jobs\/(\d+)/)[1]], truncated };
      }
      return { number: 9 };
    },
  };
}
const alert = (client, overrides = {}, options = {}) => alertNotarization({ run: { ...run, ...overrides }, repository: 'owner/repo', client, notarizing, ...options });
const writes = client => client.calls.filter(call => call.method);

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
  assert.deepEqual(writes(open).map(call => [call.path, call.method, call.body.assignees]), [['/issues/5/assignees', 'POST', [NOTARIZATION_OWNER]], ['/issues/5/comments', 'POST', undefined]]);
  assert.ok(writes(open)[1].body.body.startsWith('<!-- notarization-run:43435308021:attempt:2 -->'));

  const closed = fakeClient({ issues: [{ number: 5, state: 'closed', body: `${ALERT_MARKER}\nold` }] });
  await alert(closed);
  assert.deepEqual(writes(closed).map(call => [call.path, call.method, call.body.state, call.body.assignees]), [
    ['/issues/5', 'PATCH', 'open', undefined],
    ['/issues/5/assignees', 'POST', undefined, [NOTARIZATION_OWNER]],
    ['/issues/5/comments', 'POST', undefined, undefined],
  ]);

  // Two failures that finish together both open an issue; the newer one merges into the older.
  const raced = fakeClient({ issuesAfter: [{ number: 9, state: 'open', body: `${ALERT_MARKER}\nmine` }, { number: 8, state: 'open', body: `${ALERT_MARKER}\ntheirs` }] });
  assert.deepEqual(await alert(raced), { issue: 8, updated: true });
  assert.deepEqual(writes(raced).map(call => [call.path, call.method, call.body.state]), [
    ['/issues', 'POST', undefined], ['/issues/8/comments', 'POST', undefined], ['/issues/9/comments', 'POST', undefined], ['/issues/9', 'PATCH', 'closed'],
  ]);
  assert.match(writes(raced)[1].body.body, /^<!-- notarization-run:43435308021:attempt:1 -->/);

  // The next failure reports to the older issue, never reopening the merged duplicate.
  const afterRace = fakeClient({ issues: [{ number: 9, state: 'closed', state_reason: 'duplicate', body: `${ALERT_MARKER}\nmine` }, { number: 8, state: 'open', body: `${ALERT_MARKER}\ntheirs` }] });
  assert.deepEqual(await alert(afterRace, { run_attempt: 3 }), { issue: 8, updated: true });
  assert.deepEqual(writes(afterRace).map(call => [call.path, call.method]), [['/issues/8/assignees', 'POST'], ['/issues/8/comments', 'POST']]);
  // Once the owner closed the issue, a later failure reopens it, not the duplicate.
  const resolved = fakeClient({ issues: [{ number: 9, state: 'closed', state_reason: 'duplicate', body: `${ALERT_MARKER}\nmine` }, { number: 8, state: 'closed', state_reason: 'completed', body: `${ALERT_MARKER}\ntheirs` }] });
  assert.deepEqual(await alert(resolved, { run_attempt: 3 }), { issue: 8, updated: true });
  assert.deepEqual(writes(resolved)[0], { path: '/issues/8', method: 'PATCH', body: { state: 'open' } });

  const repeated = fakeClient({ issues: [{ number: 5, state: 'open', body: `${ALERT_MARKER}\nold` }], comments: [{ body: '<!-- notarization-run:43435308021:attempt:1 -->\nseen' }] });
  assert.deepEqual(await alert(repeated), { issue: 5, duplicate: true });
  assert.deepEqual(writes(repeated), []);

  const other = fakeClient({ issues: [{ number: 6, state: 'open', body: '<!-- nightly-workflow:1 -->\nother' }] });
  assert.deepEqual(await alert(other), { issue: 9, created: true });
});

test('a timed-out notarization is a failure too, and a log longer than the alert reads is reported', async () => {
  const hung = fakeClient({ jobs: [{ ...macJob, conclusion: 'timed_out' }] });
  assert.deepEqual(await alert(hung, { conclusion: 'timed_out' }), { issue: 9, created: true });
  const long = fakeClient({ logs: { 11: 'build output' }, truncated: true });
  assert.deepEqual(await alert(long), { skipped: 'No notarization failure in the part of the logs read', incomplete: ['portable / release'] });
  assert.deepEqual(writes(long), []);
});

test('other failures, pull requests and unrelated workflows raise nothing', async () => {
  const unrelated = fakeClient({ logs: { 11: 'error: parity failed', 12: AGREEMENT } });
  assert.deepEqual(await alert(unrelated), { skipped: 'No notarization failure in the failed macOS jobs' });
  for (const overrides of [{ conclusion: 'success' }, { conclusion: 'cancelled' }, { event: 'pull_request' }, { path: '.github/workflows/ci.yml' }, { head_repository: { full_name: 'fork/repo' } }]) {
    const client = fakeClient();
    assert.ok((await alert(client, overrides)).skipped);
    assert.deepEqual(client.calls, []);
  }
});

test('an attempt is alerted once whichever alert issue holds it, and a dry run only reads', async () => {
  const marker = '<!-- notarization-run:43435308021:attempt:1 -->';
  // Reported to #5, closed since; #8 opened later for another failure.
  const elsewhere = fakeClient({ issues: [{ number: 8, state: 'open', body: `${ALERT_MARKER}\nnewer` }, { number: 5, state: 'closed', state_reason: 'completed', body: `${ALERT_MARKER}\n${marker}` }] });
  assert.deepEqual(await alert(elsewhere), { issue: 5, duplicate: true });
  assert.deepEqual(writes(elsewhere), []);

  const dry = fakeClient({ issues: [{ number: 5, state: 'closed', body: `${ALERT_MARKER}\nold` }] });
  const result = await alert(dry, {}, { dryRun: true });
  assert.equal(result.comment, 5);
  assert.match(result.report, /^<!-- notarization-run:43435308021:attempt:1 -->/);
  assert.deepEqual(writes(dry), []);
  assert.deepEqual(await alert(fakeClient(), {}, { dryRun: true }).then(({ create, dryRun }) => ({ create, dryRun })), { create: true, dryRun: true });
  const seen = fakeClient({ issues: [{ number: 5, state: 'open', body: `${ALERT_MARKER}\n${marker}` }] });
  assert.deepEqual(await alert(seen, {}, { dryRun: true }), { dryRun: true, issue: 5, duplicate: true });
});
