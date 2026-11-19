import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { parse } from 'yaml';
import { eventPolicy } from '../scripts/lib/app-plan.mjs';
import { QUEUE_COMMIT_LIMIT, queueCoverage, queueRunProves, resolveCiBase, testedBase } from '../scripts/lib/tested-base.mjs';

const REPOSITORY = 'neurodesk/webapps';
const ENV = { GITHUB_REPOSITORY: REPOSITORY, GITHUB_TOKEN: 'token', GITHUB_API_URL: 'https://api.example', GITHUB_SERVER_URL: 'https://github.example' };

// A linear history of `count` commits after a root, oldest first.
async function history(t, count) {
  const root = await mkdtemp(join(tmpdir(), 'merge-queue-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=queue', '-c', 'user.email=queue@example.org', ...args], { cwd: root, encoding: 'utf8' }).trim();
  git('init', '--quiet');
  const commits = [];
  for (let index = 0; index <= count; index++) {
    await mkdir(join(root, 'apps', `app${index}`), { recursive: true });
    await writeFile(join(root, 'apps', `app${index}`, 'main.js'), String(index));
    git('add', '-A');
    git('commit', '--quiet', '-m', `commit ${index}`);
    commits.push(git('rev-parse', 'HEAD'));
  }
  return { root, commits };
}

// A merge queue run record as the Actions API lists it, with overrides.
const queueRun = (sha, overrides = {}) => ({
  id: 9000 + Number.parseInt(sha.slice(0, 4), 16),
  event: 'merge_group',
  status: 'completed',
  conclusion: 'success',
  head_sha: sha,
  head_branch: `gh-readonly-queue/main/pr-1-${sha}`,
  path: '.github/workflows/ci.yml',
  repository: { full_name: REPOSITORY },
  head_repository: { full_name: REPOSITORY },
  ...overrides,
});
const pushRun = (id, sha, conclusion = 'success') => ({ id, event: 'push', head_branch: 'main', head_sha: sha, conclusion, run_attempt: 1 });

// A fetch that answers the run listings from `runs`: main's finished runs, and
// the merge queue runs for a commit, as the Actions API filters them.
function actionsApi({ main = [], queue = [], answer } = {}) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push(url);
    if (answer) return answer(url, options);
    const query = new URL(url).searchParams;
    if (query.get('event') === 'merge_group') {
      const listed = queue.filter((run) => run.head_sha === query.get('head_sha') && run.conclusion === query.get('status'));
      return Response.json({ total_count: listed.length, workflow_runs: listed });
    }
    return Response.json({ workflow_runs: main });
  };
  return { fetchImpl, requests };
}

test('a run proves the merge queue tested a commit only with every field of the proof', () => {
  const sha = 'a'.repeat(40);
  const proof = { sha, repository: REPOSITORY };
  assert.equal(queueRunProves(queueRun(sha), proof), true);
  assert.equal(queueRunProves(queueRun(sha, { path: '.github/workflows/ci.yml@refs/heads/gh-readonly-queue/main/pr-1' }), proof), true, 'a ref-qualified path names the same workflow');
  const refused = {
    'a failed run': { conclusion: 'failure' },
    'a cancelled run': { conclusion: 'cancelled' },
    'a run still going': { status: 'in_progress', conclusion: null },
    'a pull request run': { event: 'pull_request' },
    'a push run': { event: 'push' },
    'a dispatch': { event: 'workflow_dispatch' },
    'another commit': { head_sha: 'b'.repeat(40) },
    'an abbreviated commit': { head_sha: sha.slice(0, 7) },
    'another workflow': { path: '.github/workflows/native.yml' },
    'a workflow of the same name elsewhere': { path: 'other/.github/workflows/ci.yml' },
    'no path': { path: undefined },
    'another repository': { repository: { full_name: 'someone/webapps' } },
    'a fork': { head_repository: { full_name: 'someone/webapps' } },
    'no repository': { repository: null },
    'no id': { id: undefined },
    'an id that is text': { id: '9000' },
  };
  for (const [label, overrides] of Object.entries(refused)) assert.equal(queueRunProves(queueRun(sha, overrides), proof), false, label);
  for (const value of [null, undefined, 'success', [], [queueRun(sha)]]) assert.equal(queueRunProves(value, proof), false, JSON.stringify(value));
  assert.equal(queueRunProves(queueRun(sha), { sha, repository: '' }), false, 'no repository to compare with');
  assert.equal(queueRunProves(queueRun(sha), { sha: undefined, repository: REPOSITORY }), false, 'no commit to compare with');
});

test('a push is covered only when a green merge queue run tested every commit it adds', async (t) => {
  const { root, commits } = await history(t, 3);
  const [c0, c1, c2, c3] = commits;
  const tested = { base: c0, carried: new Map() };
  const cover = (api, overrides = {}) => queueCoverage({ tested, head: c3, cwd: root, env: ENV, fetchImpl: api.fetchImpl, ...overrides });

  const all = actionsApi({ queue: [queueRun(c1), queueRun(c2), queueRun(c3)] });
  const covered = await cover(all);
  assert.equal(covered.covered, true, covered.reason);
  assert.deepEqual(covered.runs.map((run) => run.sha), [c3, c2, c1]);
  assert.equal(covered.runs[0].url, `https://github.example/${REPOSITORY}/actions/runs/${queueRun(c3).id}`);
  assert.equal(all.requests.length, 3);
  assert.ok(all.requests.every((url) => url.startsWith(`https://api.example/repos/${REPOSITORY}/actions/workflows/ci.yml/runs?event=merge_group&head_sha=`)));

  const cases = {
    'no queue run for one commit': actionsApi({ queue: [queueRun(c1), queueRun(c3)] }),
    'a failed queue run': actionsApi({ answer: (url) => Response.json({ workflow_runs: [queueRun(new URL(url).searchParams.get('head_sha'), { conclusion: 'failure' })] }) }),
    'a queue run of another commit': actionsApi({ answer: () => Response.json({ workflow_runs: [queueRun(c0)] }) }),
    'a pull request run of the commit': actionsApi({ answer: (url) => Response.json({ workflow_runs: [queueRun(new URL(url).searchParams.get('head_sha'), { event: 'pull_request' })] }) }),
    'a run of another repository': actionsApi({ answer: (url) => Response.json({ workflow_runs: [queueRun(new URL(url).searchParams.get('head_sha'), { repository: { full_name: 'someone/webapps' } })] }) }),
    'a run of another workflow': actionsApi({ answer: (url) => Response.json({ workflow_runs: [queueRun(new URL(url).searchParams.get('head_sha'), { path: '.github/workflows/quality.yml' })] }) }),
    'an API error': actionsApi({ answer: () => new Response('bad gateway', { status: 502 }) }),
    'a rate limit': actionsApi({ answer: () => Response.json({ message: 'API rate limit exceeded' }, { status: 403 }) }),
    'a redirect': actionsApi({ answer: () => { throw new TypeError('fetch failed: unexpected redirect'); } }),
    'a network failure': actionsApi({ answer: () => { throw new TypeError('fetch failed'); } }),
    'an empty answer': actionsApi({ answer: () => new Response('', { status: 200 }) }),
    'malformed JSON': actionsApi({ answer: () => new Response('{"workflow_runs": [', { status: 200 }) }),
    'no run list': actionsApi({ answer: () => Response.json({ total_count: 1 }) }),
    'a run list that is not a list': actionsApi({ answer: () => Response.json({ workflow_runs: { 0: queueRun(c3) } }) }),
    'a null answer': actionsApi({ answer: () => Response.json(null) }),
  };
  for (const [label, api] of Object.entries(cases)) {
    const answer = await cover(api);
    assert.equal(answer.covered, false, label);
    assert.deepEqual(answer.runs, [], label);
    assert.ok(answer.reason, label);
  }
});

test('a push waits no longer than the deadline for the merge queue runs, and then runs', async (t) => {
  const { root, commits } = await history(t, 1);
  const tested = { base: commits[0], carried: new Map() };
  // An answer that never comes, and one whose body never ends.
  const hanging = (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)));
  const stalled = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"workflow_runs": [')); } }), { status: 200 });
  for (const [label, answer] of [['no answer', hanging], ['a stalled body', stalled]]) {
    const started = Date.now();
    const result = await queueCoverage({ tested, head: commits[1], cwd: root, env: ENV, fetchImpl: actionsApi({ answer }).fetchImpl, deadlineMs: 200 });
    assert.equal(result.covered, false, label);
    assert.match(result.reason, /could not be read/, label);
    assert.ok(Date.now() - started < 5000, `${label}: the deadline ended the wait`);
  }
});

test('a push without a tested base, with apps left untested or with too many commits is not covered', async (t) => {
  const { root, commits } = await history(t, QUEUE_COMMIT_LIMIT + 1);
  const head = commits.at(-1);
  const api = actionsApi({ queue: commits.map((sha) => queueRun(sha)) });
  const cover = (tested, overrides = {}) => queueCoverage({ tested, head, cwd: root, env: ENV, fetchImpl: api.fetchImpl, ...overrides });
  assert.equal((await cover({ base: commits.at(-QUEUE_COMMIT_LIMIT - 1), carried: new Map() })).covered, true, `${QUEUE_COMMIT_LIMIT} commits`);
  const cases = {
    'no base': [{ base: null, carried: new Map() }],
    'no answer from resolveCiBase': [undefined],
    'apps a failed base run left untested': [{ base: commits.at(-2), carried: new Map([['app1', ['browser-e2e (app1)']]]) }],
    'no carried map': [{ base: commits.at(-2) }],
    'more commits than the limit': [{ base: commits[0], carried: new Map() }],
    'a base that is not a commit': [{ base: 'f'.repeat(40), carried: new Map() }],
    'the head itself as the base': [{ base: head, carried: new Map() }],
    'no token': [{ base: commits.at(-2), carried: new Map() }, { env: { ...ENV, GITHUB_TOKEN: '' } }],
    'no repository': [{ base: commits.at(-2), carried: new Map() }, { env: { ...ENV, GITHUB_REPOSITORY: undefined } }],
  };
  const before = api.requests.length;
  for (const [label, [tested, overrides]] of Object.entries(cases)) {
    const answer = await cover(tested, overrides);
    assert.equal(answer.covered, false, label);
    assert.ok(answer.reason, label);
  }
  assert.equal(api.requests.length, before, 'no case reached the API');
});

// The sequence the brief asks for: a queue run, its push (covered), the next push.
test('a covered push counts as tested, so the next push diffs from it and not from an older base', async (t) => {
  const { root, commits } = await history(t, 2);
  const [c0, c1, c2] = commits;
  const appIds = new Set(['app0', 'app1', 'app2']);
  const base = async (main, queue) => {
    const api = actionsApi({ main, queue });
    const tested = await resolveCiBase({ head: c2, cwd: root, env: ENV, fetchImpl: api.fetchImpl, appIds });
    return { tested, coverage: await queueCoverage({ tested, head: c2, cwd: root, env: ENV, fetchImpl: api.fetchImpl }) };
  };
  // 1. The queue tests c1; its push plans from c0, the last finished run on main, and is covered.
  const first = actionsApi({ main: [pushRun(1, c0)], queue: [queueRun(c1)] });
  const firstBase = await resolveCiBase({ head: c1, cwd: root, env: ENV, fetchImpl: first.fetchImpl, appIds });
  assert.equal(firstBase.base, c0);
  assert.equal((await queueCoverage({ tested: firstBase, head: c1, cwd: root, env: ENV, fetchImpl: first.fetchImpl })).covered, true);
  // 2. That push run finished green on main, so the next push (c2) diffs from c1.
  const afterGreen = await base([pushRun(2, c1), pushRun(1, c0)], [queueRun(c1), queueRun(c2)]);
  assert.equal(afterGreen.tested.base, c1);
  assert.equal(afterGreen.coverage.covered, true);
  assert.deepEqual(afterGreen.coverage.runs.map((run) => run.sha), [c2]);
  // Without a queue run of c2 the push runs as today, from c1: c1 is not tested again.
  const unqueued = await base([pushRun(2, c1), pushRun(1, c0)], [queueRun(c1)]);
  assert.equal(unqueued.tested.base, c1);
  assert.equal(unqueued.coverage.covered, false);
  // 3. A covered push that failed only in a job every push runs again still moves the base.
  const contractsFailed = actionsApi({
    answer: (url) => (url.includes('/attempts/1/jobs') ? Response.json({ jobs: [{ name: 'workspace-contracts', conclusion: 'failure' }, { name: 'app-tests (app1)', conclusion: 'skipped' }] }) : Response.json({ workflow_runs: [pushRun(2, c1, 'failure'), pushRun(1, c0)] })),
  });
  const afterFailure = await resolveCiBase({ head: c2, cwd: root, env: ENV, fetchImpl: contractsFailed.fetchImpl, appIds });
  assert.equal(afterFailure.base, c1);
  assert.equal(afterFailure.carried.size, 0);
  // 4. The queue run alone is not a base: until c1's push run finishes, c2 diffs
  //    from c0 and is covered only when the queue tested c1 and c2.
  const pending = await base([pushRun(1, c0)], [queueRun(c1), queueRun(c2)]);
  assert.equal(pending.tested.base, c0);
  assert.equal(pending.coverage.covered, true);
  assert.deepEqual(pending.coverage.runs.map((run) => run.sha), [c2, c1]);
  const halfQueued = await base([pushRun(1, c0)], [queueRun(c2)]);
  assert.equal(halfQueued.tested.base, c0);
  assert.equal(halfQueued.coverage.covered, false, 'c1 reached main without a green queue run');
  // A green queue run of c1 is not a push or nightly run on main.
  assert.equal(testedBase({ runs: [queueRun(c1)], head: c2, branch: 'main', git: { isAncestor: () => true, distance: () => 1 } }).base, null);
});

test('only a push plans with the queue proof, and only a pull request with a draft plan or a budget', () => {
  assert.deepEqual(eventPolicy('pull_request', { draft: 'true' }), { draft: true, budget: false, everyRun: false, queueProof: false });
  assert.deepEqual(eventPolicy('pull_request', { draft: 'false' }), { draft: false, budget: true, everyRun: false, queueProof: false });
  assert.deepEqual(eventPolicy('push'), { draft: false, budget: false, everyRun: true, queueProof: true });
  // A merge queue run is no pull request's retry: full plan, no budget, the easter egg every time.
  for (const event of ['merge_group', 'schedule', 'workflow_dispatch']) assert.deepEqual(eventPolicy(event, { draft: 'true' }), { draft: false, budget: false, everyRun: true, queueProof: false }, event);
  // An event the planner does not know plans everything and skips nothing; a local run (no event) plans the easter egg.
  for (const event of ['repository_dispatch', 'pull_request_target', 'workflow_run', 'Push']) assert.deepEqual(eventPolicy(event), { draft: false, budget: false, everyRun: true, queueProof: false }, event);
  assert.deepEqual(eventPolicy(undefined), { draft: false, budget: false, everyRun: false, queueProof: false });
});

test('the plan diffs a merge queue run from the queue base, and any other event without a base tests every app', async () => {
  const ci = parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));
  const plan = ci.jobs['app-plan'].steps.find((step) => step.id === 'plan');
  const evaluate = (expression, github, inputs = {}) => runInNewContext(expression.replace(/^\$\{\{\s*|\s*\}\}$/g, ''), { github, inputs });
  const base = 'b'.repeat(40);
  const head = 'c'.repeat(40);
  const queue = { event_name: 'merge_group', sha: head, event: { action: 'checks_requested', merge_group: { base_sha: base, head_sha: head } } };
  assert.equal(evaluate(plan.env.BASE_SHA, queue), base);
  assert.equal(evaluate(plan.env.HEAD_SHA, queue), head);
  assert.equal(evaluate(plan.env.CI_DRAFT, queue), false);
  assert.equal(evaluate(plan.env.BASE_SHA, { ...queue, event: { merge_group: { base_sha: '' } } }), '', 'an empty queue base tests every app');
  assert.equal(evaluate(plan.env.BASE_SHA, { event_name: 'pull_request', event: { pull_request: { base: { sha: base } } } }), base);
  assert.equal(evaluate(plan.env.BASE_SHA, { event_name: 'push', event: {} }), 'last-success');
  assert.equal(evaluate(plan.env.BASE_SHA, { event_name: 'workflow_dispatch', event: {} }, { scope: 'affected' }), 'merge-base');
  for (const event_name of ['schedule', 'repository_dispatch', 'workflow_run']) assert.equal(evaluate(plan.env.BASE_SHA, { event_name, event: {} }), '', event_name);
  assert.deepEqual(ci.on.merge_group, { types: ['checks_requested'] });
  assert.equal(ci.jobs['app-plan'].outputs.queue_tested, '${{ steps.plan.outputs.queue_tested }}');
});
