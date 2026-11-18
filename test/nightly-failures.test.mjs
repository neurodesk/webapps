import assert from 'node:assert/strict';
import test from 'node:test';
import { createGitHubClient, logExcerpt, reportNightlyFailure, sanitize } from '../scripts/lib/nightly-failures.mjs';

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

test('ignores successful, manual, pull request, running, branch and fork runs', async () => {
  for (const overrides of [{ conclusion: 'success' }, { event: 'workflow_dispatch' }, { event: 'pull_request' }, { status: 'in_progress' }, { head_branch: 'feature' }, { head_repository: { full_name: 'fork/repo' } }]) {
    const client = fakeClient({ jobs: [] });
    assert.ok((await report(client, overrides)).skipped);
    assert.deepEqual(writes(client), []);
  }
});

test('agent interaction shards retain the combined failure counts and all shard artifacts', async () => {
  const conclusions = ['success', 'failure', 'timed_out', 'success', 'failure', 'cancelled'];
  const jobs = ['desktop', 'phone'].flatMap((target, targetIndex) => [1, 2, 3].map(shard => ({
    id: 500 + targetIndex * 3 + shard,
    name: `agent-interactions (${target}, ${shard})`,
    conclusion: conclusions[targetIndex * 3 + shard - 1],
    steps: [],
  })));
  const artifacts = ['desktop', 'phone'].flatMap((target, targetIndex) => [1, 2, 3].map(shard => ({
    id: 600 + targetIndex * 3 + shard,
    name: `catalog-agent-${target}-${shard}`,
    expired: false,
  })));
  const client = fakeClient({ jobs, artifacts });
  await report(client);
  const body = writes(client)[0].body.body;
  assert.match(body, /3 failed or timed out; 1 cancelled/);
  assert.match(body, /Coverage is incomplete/);
  for (const job of jobs.filter(job => job.conclusion !== 'success')) assert.ok(body.replaceAll('\\', '').includes(`### ${job.name} (${job.conclusion})`));
  for (const artifact of artifacts) assert.ok(body.includes(`[${artifact.name}]`));
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

test('API client paginates jobs in pages of 30, and issues, comments and artifacts in pages of 100', async () => {
  for (const [path, key, size] of [['/actions/runs/1/attempts/1/jobs', 'jobs', 30], ['/issues?state=all', undefined, 100], ['/issues/1/comments', undefined, 100], ['/actions/runs/1/artifacts', 'artifacts', 100]]) {
    const urls = [];
    const client = createGitHubClient({ token: 'token', repository: 'owner/repo', fetchImpl: async (url) => {
      urls.push(url);
      const items = new URL(url).searchParams.get('page') === '1' ? Array(size).fill({ id: 1 }) : [{ id: 2 }];
      return Response.json(key ? { [key]: items } : items);
    } });
    assert.equal((await client.list(path, key)).length, size + 1);
    assert.equal(urls.length, 2);
    assert.ok(urls[1].includes(`per_page=${size}&page=2`), urls[1]);
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

// Undici's error when GitHub closes a reused keep-alive connection (#632).
const socketClosed = (message = 'fetch failed') => new TypeError(message, { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });

function scriptedClient(responses) {
  const calls = [];
  const delays = [];
  const client = createGitHubClient({
    token: 'private', repository: 'owner/repo',
    sleep: async delay => { delays.push(delay); },
    fetchImpl: async (url, options) => {
      calls.push({ url, authorization: options.headers?.Authorization });
      const next = responses.shift();
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    },
  });
  return { client, calls, delays };
}

test('API reads retry dropped connections and gateway errors with bounded backoff', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const { client, calls, delays } = scriptedClient([socketClosed(), new Response('unavailable', { status: 503 }), Response.json({ id: 1 })]);
  assert.deepEqual(await client.request('/actions/runs?head_sha=abc'), { id: 1 });
  assert.deepEqual(calls.map(call => call.authorization), ['Bearer private', 'Bearer private', 'Bearer private']);
  assert.deepEqual(delays, [1000, 4000]);
  assert.deepEqual(warn.mock.calls.map(call => call.arguments[0]), [
    'GitHub API GET /actions/runs failed (UND_ERR_SOCKET); retry 1 of 2 in 1 s',
    'GitHub API GET /actions/runs failed (HTTP 503); retry 2 of 2 in 4 s',
  ]);
});

test('API reads cut off mid-response retry the whole request, log redirect included', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const truncated = () => new Response(new ReadableStream({ pull(controller) { controller.error(socketClosed('terminated')); } }));
  const json = scriptedClient([truncated, Response.json({ id: 1 })]);
  assert.deepEqual(await json.client.request('/actions/runs/1'), { id: 1 });
  assert.equal(json.calls.length, 2);
  const redirect = () => new Response(null, { status: 302, headers: { location: 'https://logs.blob.core.windows.net/log?signed=private' } });
  const logs = scriptedClient([redirect, truncated, redirect, () => new Response('error: failed')]);
  assert.deepEqual(await logs.client.request('/actions/jobs/1/logs', { logs: true }), { text: 'error: failed', truncated: false });
  assert.deepEqual(logs.calls.map(call => [new URL(call.url).hostname, call.authorization]), [
    ['api.github.com', 'Bearer private'], ['logs.blob.core.windows.net', undefined],
    ['api.github.com', 'Bearer private'], ['logs.blob.core.windows.net', undefined],
  ]);
});

test('a read that keeps failing surfaces its error after the retry budget', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  const dropped = scriptedClient([socketClosed(), socketClosed(), socketClosed(), Response.json({ id: 1 })]);
  await assert.rejects(dropped.client.list('/pulls?state=open'), error => error.message === 'fetch failed' && error.cause.code === 'UND_ERR_SOCKET');
  assert.equal(dropped.calls.length, 3);
  assert.deepEqual(dropped.delays, [1000, 4000]);
  const gateway = scriptedClient(Array.from({ length: 4 }, () => new Response('bad gateway', { status: 502 })));
  await assert.rejects(gateway.client.request('/pulls'), /GitHub API GET \/pulls returned 502/);
  assert.equal(gateway.calls.length, 3);
  assert.equal(warn.mock.callCount(), 4);
});

test('writes, credential, permission, rate-limit and other errors are never retried', async (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  for (const method of ['POST', 'PATCH']) {
    const write = scriptedClient([socketClosed(), Response.json({ number: 7 })]);
    await assert.rejects(write.client.request('/issues/7/comments', { method, body: { body: 'report' } }), /fetch failed/);
    assert.equal(write.calls.length, 1, method);
  }
  for (const status of [401, 403, 404, 422, 429, 500]) {
    const read = scriptedClient([new Response('{}', { status }), Response.json({ id: 1 })]);
    await assert.rejects(read.client.request('/pulls'), new RegExp(`returned ${status}`));
    assert.equal(read.calls.length, 1, String(status));
  }
  const certificate = new TypeError('fetch failed', { cause: Object.assign(new Error('certificate mismatch'), { code: 'ERR_TLS_CERT_ALTNAME_INVALID' }) });
  const tls = scriptedClient([certificate, Response.json({ id: 1 })]);
  await assert.rejects(tls.client.request('/pulls'), /fetch failed/);
  assert.equal(tls.calls.length, 1);
  const unsafe = scriptedClient([new Response(null, { status: 302, headers: { location: 'https://evil.test/log' } }), Response.json({ id: 1 })]);
  await assert.rejects(unsafe.client.request('/actions/jobs/1/logs', { logs: true }), /Rejected unexpected/);
  assert.equal(unsafe.calls.length, 1);
  assert.equal(warn.mock.callCount(), 0);
});

test('dry-run renders the report without any issue or comment writes', async () => {
  const client = fakeClient();
  const result = await reportNightlyFailure({ run, repository: 'owner/repo', defaultBranch: 'main', client, dryRun: true });
  assert.equal(result.dryRun, true);
  assert.match(result.body, /nightly-workflow:45/);
  assert.match(result.body, /scientific parity failed/);
  assert.match(result.title, /ci requires attention/);
  assert.equal(result.create, true);
  assert.deepEqual(writes(client), []);
  // It reads the issues, so it says which issue it would comment on and which attempts were reported.
  const existing = fakeClient({ issues: [{ number: 8, state: 'closed', body: '<!-- nightly-workflow:45 -->' }] });
  const comment = await reportNightlyFailure({ run, repository: 'owner/repo', defaultBranch: 'main', client: existing, dryRun: true });
  assert.equal(comment.comment, 8);
  assert.match(comment.body, /^<!-- nightly-run:123:attempt:2 -->/);
  const reported = fakeClient({ issues: [{ number: 8, state: 'closed', body: '<!-- nightly-workflow:45 -->' }], comments: [{ body: '<!-- nightly-run:123:attempt:2 -->', created_at: '2026-10-15T00:11:00Z' }] });
  assert.deepEqual(await reportNightlyFailure({ run, repository: 'owner/repo', defaultBranch: 'main', client: reported, dryRun: true }), { dryRun: true, duplicate: true, issue: 8, reopened: true });
  assert.deepEqual(writes(existing), []);
  assert.deepEqual(writes(reported), []);
});

test('retries finish reopening a closed issue after an earlier comment succeeded', async () => {
  const client = fakeClient({
    issues: [{ number: 8, state: 'closed', body: '<!-- nightly-workflow:45 -->' }],
    comments: [{ body: '<!-- nightly-run:123:attempt:2 -->\nexisting report' }],
  });
  assert.deepEqual(await report(client), { duplicate: true, issue: 8, reopened: true });
  assert.deepEqual(writes(client), [{ path: '/issues/8', method: 'PATCH', body: { state: 'open' } }]);
});

test('a reported attempt seen again never reopens an issue closed after its report, nor reports twice', async () => {
  const marker = '<!-- nightly-run:123:attempt:2 -->';
  // Closed after the report comment: someone resolved it.
  const commented = fakeClient({
    issues: [{ number: 8, state: 'closed', closed_at: '2026-10-15T09:00:00Z', body: '<!-- nightly-workflow:45 -->' }],
    comments: [{ body: `${marker}\nexisting report`, created_at: '2026-10-15T06:00:00Z' }],
  });
  assert.deepEqual(await report(commented), { duplicate: true, issue: 8 });
  assert.deepEqual(writes(commented), []);
  // Closed before the report comment: the tick that commented stopped before reopening.
  const interrupted = fakeClient({
    issues: [{ number: 8, state: 'closed', closed_at: '2026-10-14T09:00:00Z', body: '<!-- nightly-workflow:45 -->' }],
    comments: [{ body: `${marker}\nexisting report`, created_at: '2026-10-15T06:00:00Z' }],
  });
  assert.deepEqual(await report(interrupted), { duplicate: true, issue: 8, reopened: true });
  assert.deepEqual(writes(interrupted), [{ path: '/issues/8', method: 'PATCH', body: { state: 'open' } }]);
  // The issue this report opened, closed since.
  const opened = fakeClient({ issues: [{ number: 8, state: 'closed', closed_at: '2026-10-16T00:00:00Z', body: `<!-- nightly-workflow:45 -->\n${marker}` }] });
  assert.deepEqual(await report(opened), { duplicate: true, issue: 8 });
  assert.deepEqual(writes(opened), []);
  // The marker sits in an older closed issue of the same workflow while a newer one is open.
  const older = fakeClient({ issues: [
    { number: 9, state: 'open', body: '<!-- nightly-workflow:45 -->\nnewer' },
    { number: 8, state: 'closed', closed_at: '2026-10-16T00:00:00Z', body: `<!-- nightly-workflow:45 -->\n${marker}` },
  ], comments: [] });
  assert.deepEqual(await report(older), { duplicate: true, issue: 8 });
  assert.deepEqual(writes(older), []);
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

test('exit-code and cancellation annotations do not hide the substantive diagnostic', () => {
  const padding = Array.from({ length: 40 }, (_, i) => `ordinary output ${i}`).join('\n');
  for (const marker of ['##[error]', '::error::', '::error title=Test failed::']) {
    const excerpt = logExcerpt({ text: `${marker}Expected scientific parity, received Dice 0.91\n${padding}\n##[error]Process completed with exit code 1.\n##[error]The operation was canceled.`, truncated: false });
    assert.match(excerpt, /Expected scientific parity, received Dice 0.91/);
    assert.match(excerpt, /Process completed with exit code 1/);
  }
  const genericError = logExcerpt({ text: `Error: expected atlas grid 182x218x182\n${padding}\n##[error]Process completed with exit code 1.`, truncated: false });
  assert.match(genericError, /expected atlas grid 182x218x182/);
});

test('overlapping diagnostic context and log tail render each line once', () => {
  const excerpt = logExcerpt({ text: 'setup line\n##[error]unique diagnostic\ncleanup line\nProcess completed with exit code 1.', truncated: false });
  assert.equal(excerpt.match(/unique diagnostic/g).length, 1);
  assert.equal(excerpt.match(/cleanup line/g).length, 1);
  assert.equal(excerpt.match(/setup line/g).length, 1);
});

test('large mixed job matrices retain failed diagnostics before cancelled siblings', async () => {
  const cancelled = Array.from({ length: 40 }, (_, i) => ({ id: 1000 + i, name: `cancelled sibling ${i}`, conclusion: 'cancelled', steps: [{ number: 1, name: 'Interrupted test', conclusion: 'cancelled' }] }));
  const client = fakeClient({ jobs: [...cancelled, failedJob], logs: { text: '##[error]scientific parity regression', truncated: false } });
  await report(client);
  const body = writes(client)[0].body.body;
  assert.ok(body.indexOf('browser') < body.indexOf('cancelled sibling'));
  assert.match(body, /scientific parity regression/);
  assert.match(body, /additional affected jobs omitted/);
  assert.equal(client.calls.filter(call => call.logs)[0].path, '/actions/jobs/456/logs');
  assert.ok(body.length < 60000);
});

test('explicit assertion diagnostics outrank later failed-test duration summaries', () => {
  const padding = Array.from({ length: 40 }, (_, i) => `ordinary cleanup ${i}`).join('\n');
  const excerpt = logExcerpt({
    text: `2026-10-15T00:00:00Z Error: expect(locator).toHaveAttribute(expected) failed\nLocator: getByRole('button', { name: 'Run' })\nExpected: enabled\nReceived: disabled\n${padding}\n6.8s failed labels are preserved in the viewer\n${padding}\n##[error]Process completed with exit code 1.`,
    truncated: false,
  });
  assert.match(excerpt, /Error: expect\(locator\)\.toHaveAttribute\(expected\) failed/);
  assert.match(excerpt, /Expected: enabled/);
  assert.match(excerpt, /Received: disabled/);
  assert.doesNotMatch(excerpt, /6.8s failed labels/);
});
