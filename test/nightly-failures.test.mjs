import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import YAML from 'yaml';
import { createGitHubClient, logExcerpt, reportNightlyFailure, sanitize, SCHEDULED_WORKFLOWS } from '../scripts/lib/nightly-failures.mjs';

const run = {
  id: 123, workflow_id: 45, run_attempt: 2, event: 'schedule', status: 'completed', conclusion: 'failure',
  name: 'ci', head_sha: 'a'.repeat(40), head_branch: 'main', created_at: '2026-10-15T00:00:00Z', updated_at: '2026-10-15T00:10:00Z',
  head_repository: { full_name: 'owner/repo' },
};
const failedJob = {
  id: 456, name: 'browser (app)', conclusion: 'failure',
  steps: [{ number: 3, name: 'Test app', conclusion: 'failure' }],
};

function fakeClient({ jobs = [failedJob], issues = [], comments = [], artifacts = [], logs = { text: 'first\nerror: scientific parity failed\nlast', truncated: false }, logError, artifactError } = {}) {
  const calls = [];
  return {
    calls,
    async list(path) {
      calls.push({ path, list: true });
      if (path.includes('/jobs')) return jobs;
      if (path.startsWith('/issues?')) return issues.map(issue => ({ user: { login: 'github-actions[bot]' }, ...issue }));
      if (path.endsWith('/comments')) return comments.map(comment => ({ user: { login: 'github-actions[bot]' }, ...comment }));
      if (path.endsWith('/artifacts')) {
        if (artifactError) throw artifactError;
        return artifacts;
      }
      throw new Error(`Unexpected list ${path}`);
    },
    async request(path, options = {}) {
      calls.push({ path, ...options });
      if (options.logs) {
        if (logError) throw logError;
        return logs;
      }
      assert.ok(['POST', 'PATCH'].includes(options.method));
      return { number: 7 };
    },
  };
}

const report = (client, overrides = {}) => reportNightlyFailure({ run: { ...run, ...overrides }, repository: 'owner/repo', defaultBranch: 'main', client });
const writes = client => client.calls.filter(call => call.method);

test('reporter covers every scheduled workflow and uses a privileged, trusted checkout', async () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  const workflows = [];
  for (const file of await readdir(directory)) {
    if (!file.endsWith('.yml')) continue;
    const workflow = YAML.parse(await readFile(new URL(file, directory), 'utf8'));
    if (workflow.on?.schedule) workflows.push(workflow.name);
  }
  const source = await readFile(new URL('nightly-failures.yml', directory), 'utf8');
  const workflow = YAML.parse(source);
  assert.deepEqual([...workflows].sort(), [...SCHEDULED_WORKFLOWS].sort());
  assert.deepEqual([...workflow.on.workflow_run.workflows].sort(), [...workflows].sort());
  assert.deepEqual(workflow.on.workflow_run.types, ['completed']);
  assert.deepEqual(workflow.permissions, { contents: 'read', actions: 'read', issues: 'write' });
  assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.equal(workflow.jobs.report.steps[0].with.ref, '${{ github.event.repository.default_branch }}');
  assert.equal(workflow.jobs.report.steps[0].with['persist-credentials'], false);
  assert.doesNotMatch(source, /download-artifact|head_sha|continue-on-error/);
  assert.equal(workflow.jobs.report.if, "github.event.workflow_run.event == 'schedule' && github.event.workflow_run.head_branch == github.event.repository.default_branch && github.event.workflow_run.head_repository.full_name == github.repository");
});

test('creates an actionable report with failed and timed out jobs, steps, artifacts and exact attempt', async () => {
  const client = fakeClient({
    jobs: [failedJob, { id: 457, name: 'native', conclusion: 'timed_out', steps: [{ number: 2, name: 'Compile', conclusion: 'timed_out' }] }],
    artifacts: [{ id: 9, name: 'screenshots', expired: false }],
  });
  assert.deepEqual(await report(client), { issue: 7, created: true });
  const body = writes(client)[0].body.body;
  assert.ok(body.startsWith('<!-- nightly-workflow:45 -->\n<!-- nightly-run:123:attempt:2 -->'));
  for (const expected of ['attempts/2', 'job/456#step:3:1', 'job/457#step:2:1', 'error: scientific parity failed', 'artifacts/9', 'gh run rerun 123 --failed --repo owner/repo', run.head_sha, '2 failed or timed out']) assert.ok(body.includes(expected), expected);
  assert.ok(client.calls.some(call => call.path === '/actions/runs/123/attempts/2/jobs'));
});

test('ignores successful, manual, pull request and unsupported workflow events', async () => {
  for (const overrides of [{ conclusion: 'success' }, { event: 'workflow_dispatch' }, { event: 'pull_request' }, { name: 'untrusted' }, { status: 'in_progress' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }]) {
    const client = fakeClient({ jobs: [] });
    assert.ok((await report(client, overrides)).skipped);
    assert.deepEqual(writes(client), []);
  }
});

test('cancelled tests report incomplete coverage while expected deploy cancellation stays quiet', async () => {
  const client = fakeClient({ jobs: [{ id: 456, name: 'browser', conclusion: 'cancelled' }] });
  await report(client, { conclusion: 'cancelled' });
  assert.match(writes(client)[0].body.body, /Coverage is incomplete/);
  assert.equal(client.calls.filter(call => call.logs).length, 0);
  const deploy = fakeClient({ jobs: [] });
  assert.deepEqual(await report(deploy, { conclusion: 'cancelled', name: 'deploy-github-pages' }), { skipped: 'Superseded deployment' });
  const brokenDeploy = fakeClient();
  await report(brokenDeploy, { conclusion: 'cancelled', name: 'deploy-github-pages' });
  assert.equal(writes(brokenDeploy).length, 1);
});

test('startup failures remain actionable with no job-level failure', async () => {
  const client = fakeClient({ jobs: [] });
  await report(client);
  assert.match(writes(client)[0].body.body, /startup or workflow-level errors/);
});

test('updates and reopens the workflow issue across workflow renames', async () => {
  const client = fakeClient({ issues: [{ number: 8, state: 'closed', body: '<!-- nightly-workflow:45 -->\nold name' }] });
  assert.deepEqual(await report(client), { issue: 8, updated: true });
  assert.equal(writes(client)[0].path, '/issues/8/comments');
  assert.deepEqual(writes(client)[1], { path: '/issues/8', method: 'PATCH', body: { state: 'open' } });
});

test('same run and attempt is idempotent in the issue body or a comment; a new attempt is reported', async () => {
  for (const inComment of [false, true]) {
    const marker = '<!-- nightly-run:123:attempt:2 -->';
    const client = fakeClient({
      issues: [{ number: 8, state: 'open', body: `<!-- nightly-workflow:45 -->\n${inComment ? '' : marker}` }],
      comments: inComment ? [{ body: `${marker}\nexisting report` }] : [],
    });
    assert.deepEqual(await report(client), { duplicate: true, issue: 8 });
    assert.deepEqual(writes(client), []);
    await report(client, { run_attempt: 3 });
    assert.equal(writes(client).length, 1);
  }
});

test('log and artifact errors are explicit without hiding the failure or failing issue writes silently', async () => {
  const client = fakeClient({ logError: new Error('logs expired'), artifactError: new Error('permission denied') });
  await report(client);
  assert.match(writes(client)[0].body.body, /Log excerpt unavailable: logs expired/);
  assert.match(writes(client)[0].body.body, /Artifact listing unavailable: permission denied/);
  client.request = async () => { throw new Error('issue creation denied'); };
  await assert.rejects(report(client), /issue creation denied/);
});

test('untrusted names and logs cannot inject markdown, HTML, mentions or common credentials', async () => {
  const text = 'error: </pre>\n<!-- nightly-run:9:attempt:1 -->\n@everyone ``` ghp_abc123 TOKEN=secretvalue Bearer private https://user:pass@example.org/x?token=private';
  const client = fakeClient({ jobs: [{ ...failedJob, name: '[click](https://evil.test) @owner\n# heading' }], logs: { text, truncated: false } });
  await report(client);
  const body = writes(client)[0].body.body;
  assert.doesNotMatch(body, /@everyone|@owner|ghp_abc123|secretvalue|Bearer private|user:pass|token=private|<!-- nightly-run:9/);
  assert.match(body, /&lt;\/pre&gt;/);
  assert.ok(body.includes('\\[click\\]\\(https://evil.test\\)'));
  assert.match(logExcerpt({ text: 'error: example\n' + 'x'.repeat(10000), truncated: true }), /error: example/);
});

test('report bounds large job matrices and excerpts within GitHub issue size', async () => {
  const client = fakeClient({
    jobs: Array.from({ length: 50 }, (_, i) => ({ ...failedJob, id: 1000 + i })),
    logs: { text: 'error: ' + 'x'.repeat(20000), truncated: true },
  });
  await report(client);
  assert.ok(writes(client)[0].body.body.length < 60000);
  assert.match(writes(client)[0].body.body, /additional affected jobs omitted/);
});

test('API client paginates jobs, issues, comments and artifacts', async () => {
  for (const [path, key] of [['/actions/runs/1/attempts/1/jobs', 'jobs'], ['/issues?state=all'], ['/issues/1/comments'], ['/actions/runs/1/artifacts', 'artifacts']]) {
    const urls = [];
    const client = createGitHubClient({ token: 'token', repository: 'owner/repo', fetchImpl: async (url) => {
      urls.push(url);
      const items = new URL(url).searchParams.get('page') === '1' ? Array(100).fill({ id: 1 }) : [{ id: 2 }];
      return Response.json(key ? { [key]: items } : items);
    } });
    assert.equal((await client.list(path, key)).length, 101);
    assert.equal(urls.length, 2);
    assert.ok(urls[1].includes('per_page=100&page=2'));
  }
});

test('log redirects allow only known HTTPS storage and never forward credentials', async () => {
  const calls = [];
  const client = createGitHubClient({ token: 'private', repository: 'owner/repo', fetchImpl: async (url, options) => {
    calls.push({ url, options });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://logs.blob.core.windows.net/log?signed=private' } }) : new Response('error: failed');
  } });
  assert.deepEqual(await client.request('/actions/jobs/1/logs', { logs: true }), { text: 'error: failed', truncated: false });
  assert.equal(calls[1].options.headers, undefined);
  assert.equal(calls[1].options.redirect, 'error');
  for (const location of ['https://evil.test/log', 'http://logs.blob.core.windows.net/log', 'https://evil.blob.core.windows.net.evil.test/log']) {
    const unsafe = createGitHubClient({ token: 'private', repository: 'owner/repo', fetchImpl: async () => new Response(null, { status: 302, headers: { location } }) });
    await assert.rejects(unsafe.request('/actions/jobs/1/logs', { logs: true }), /Rejected unexpected/);
  }
});

test('oversized log downloads stop at the byte budget and identify partial logs', async () => {
  let cancelled = false;
  const client = createGitHubClient({ token: 'private', repository: 'owner/repo', fetchImpl: async () => new Response(new ReadableStream({
    pull(controller) { controller.enqueue(new Uint8Array(1024 * 1024).fill(65)); },
    cancel() { cancelled = true; },
  })) });
  const logs = await client.request('/actions/jobs/1/logs', { logs: true });
  assert.equal(logs.text.length, 2 * 1024 * 1024);
  assert.equal(logs.truncated, true);
  assert.equal(cancelled, true);
});

test('dry-run renders the report without any issue or comment writes', async () => {
  const client = fakeClient();
  const result = await reportNightlyFailure({ run, repository: 'owner/repo', defaultBranch: 'main', client, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.match(result.body, /nightly-workflow:45/);
  assert.match(result.body, /scientific parity failed/);
  assert.match(result.title, /ci requires attention/);
  assert.deepEqual(writes(client), []);
  assert.equal(client.calls.filter(call => call.path.startsWith('/issues')).length, 0);
});

test('retries finish reopening a closed issue after an earlier comment succeeded', async () => {
  const client = fakeClient({
    issues: [{ number: 8, state: 'closed', body: '<!-- nightly-workflow:45 -->' }],
    comments: [{ body: '<!-- nightly-run:123:attempt:2 -->\nexisting report' }],
  });
  assert.deepEqual(await report(client), { duplicate: true, issue: 8 });
  assert.deepEqual(writes(client), [{ path: '/issues/8', method: 'PATCH', body: { state: 'open' } }]);
});

test('human-authored issue and comment markers cannot suppress reports', async () => {
  const client = fakeClient({ issues: [{ number: 8, state: 'open', user: { login: 'someone' }, body: '<!-- nightly-workflow:45 -->\n<!-- nightly-run:123:attempt:2 -->' }] });
  assert.equal((await report(client)).created, true);
  const commentClient = fakeClient({
    issues: [{ number: 8, state: 'open', body: '<!-- nightly-workflow:45 -->' }],
    comments: [{ user: { login: 'someone' }, body: '<!-- nightly-run:123:attempt:2 -->' }],
  });
  assert.equal((await report(commentClient)).updated, true);
});

test('push and manual completions cannot displace pending scheduled reports in concurrency', async () => {
  const workflow = YAML.parse(await readFile(new URL('../.github/workflows/nightly-failures.yml', import.meta.url), 'utf8'));
  const group = (event, reporterId, workflowId = 45) => workflow.concurrency.group.replace(/\$\{\{(.*?)\}\}/g, (_, expression) => runInNewContext(expression, {
    github: { run_id: reporterId, event: { workflow_run: { workflow_id: workflowId, event } } },
  }));
  assert.equal(group('schedule', 100), 'nightly-failure-report-45-schedule');
  assert.equal(group('schedule', 101), group('schedule', 100));
  assert.notEqual(group('push', 102), group('schedule', 100));
  assert.notEqual(group('workflow_dispatch', 103), group('schedule', 100));
  assert.notEqual(group('push', 102), group('push', 104));
  assert.notEqual(group('schedule', 100, 46), group('schedule', 100));
});

test('mixed failures and cancellation prioritize the failure and retain the coverage warning', async () => {
  const client = fakeClient({ jobs: [failedJob, { id: 457, name: 'cancelled suite', conclusion: 'cancelled' }] });
  await report(client);
  const body = writes(client)[0].body.body;
  assert.match(body, /## Scheduled failure: ci/);
  assert.match(body, /Coverage is incomplete/);
  const lookup = client.calls.find(call => call.list && call.path.startsWith('/issues?'));
  assert.equal(new URL('https://api.github.com' + lookup.path).searchParams.get('creator'), 'github-actions[bot]');
});

test('excerpts prioritize the latest GitHub error annotation over setup errors and cleanup messages', () => {
  const padding = Array.from({ length: 35 }, (_, i) => `ordinary log ${i}`).join('\n');
  const annotated = `error: benign setup probe\n${padding}\n##[error]first failure\n${padding}\n##[error]actionable root cause\n${padding}\nfailed cleanup retry\n${padding}`;
  const excerpt = logExcerpt({ text: annotated, truncated: false });
  assert.match(excerpt, /actionable root cause/);
  assert.doesNotMatch(excerpt, /benign setup probe|first failure|failed cleanup retry/);
  const generic = logExcerpt({ text: `error: benign setup probe\n${padding}\nException: real scientific failure\n${padding}`, truncated: false });
  assert.match(generic, /real scientific failure/);
  assert.doesNotMatch(generic, /benign setup probe/);
});

test('Hugging Face, API and JWT credentials are redacted before rendering', () => {
  const tokens = ['hf_exampleToken123456789', 'sk-proj-exampleToken123456789', 'sk-ant-exampleToken123456789', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.exampleSignature'];
  const rendered = sanitize(`Download credentials ${tokens.join(' ')} then retry`);
  for (const token of tokens) assert.ok(!rendered.includes(token));
  assert.equal(rendered, 'Download credentials [redacted] [redacted] [redacted] [redacted] then retry');
});

test('cancelled jobs with interrupted steps include bounded logs to diagnose timeouts', async () => {
  const client = fakeClient({ jobs: [{ id: 456, name: 'browser', conclusion: 'cancelled', steps: [{ number: 3, name: 'Long test', conclusion: 'cancelled' }] }], logs: { text: '##[error]The job exceeded the maximum execution time', truncated: false } });
  await report(client, { conclusion: 'cancelled' });
  assert.equal(client.calls.filter(call => call.logs).length, 1);
  assert.match(writes(client)[0].body.body, /maximum execution time/);
  assert.match(writes(client)[0].body.body, /job\/456#step:3:1/);
});
