// A `gh` stand-in for scripts/ci-usage-report.mjs (test/ci-measures.test.mjs).
// It answers as `gh api --jq` prints the report's queries, appends each call's
// arguments as one JSON line to GH_STUB_LOG, and changes its answers by the
// words in GH_STUB_MODE:
//   over          three whole-catalogue runs of one pull request: over budget
//   fail-jobs     job listings answer as a secondary rate limit does
//   hang-jobs     job listings never answer
//   retry         the first job listing of run 4 answers HTTP 502 once
//   empty-pr      the pull request search answers [{}]
//   bad-job       job records carry a start time that is not a time
//   break-summary the first deploy page turns GITHUB_STEP_SUMMARY into a directory
//   fifo-summary  the first deploy page turns GITHUB_STEP_SUMMARY into a FIFO no one reads
const { appendFileSync, existsSync, mkdirSync, rmSync, writeFileSync } = require('node:fs');
const { execFileSync } = require('node:child_process');
const { join } = require('node:path');

const args = process.argv.slice(2);
const modes = new Set((process.env.GH_STUB_MODE || '').split(',').filter(Boolean));
appendFileSync(process.env.GH_STUB_LOG, `${JSON.stringify(args)}\n`);
const path = args.find((arg) => arg.startsWith('repos/')) ?? '';
const page = Number(/[?&]page=(\d+)/.exec(path)?.[1] ?? 1);
const print = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const listing = (total, size, make) => print({ total, items: Array.from({ length: Math.max(0, Math.min(size, total - (page - 1) * size)) }, (_, index) => make((page - 1) * size + index)) });
const fail = (message) => {
  process.stderr.write(message);
  process.exit(1);
};
const hang = () => setInterval(() => {}, 1000);

const run = (fields) => ({ name: 'ci', event: 'pull_request', status: 'completed', conclusion: 'success', head_branch: 'feature', head_sha: 'a'.repeat(40), created_at: '2026-11-18T09:00:00Z', run_started_at: '2026-11-18T09:00:00Z', updated_at: '2026-11-18T09:40:00Z', pull_requests: [864], head_repository: 'neurodesk/webapps', ...fields });
const job = (index) => ({ name: `app-tests (${index})`, status: 'completed', conclusion: 'success', started_at: modes.has('bad-job') ? 'yesterday' : '2026-11-18T09:00:00Z', completed_at: '2026-11-18T09:10:00Z', runner_name: 'r' });
const MERGE_COMMIT = 'm'.repeat(40);

function breakSummary() {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary || page !== 1) return;
  rmSync(summary, { recursive: true, force: true });
  if (modes.has('break-summary')) mkdirSync(summary);
  else execFileSync('mkfifo', [summary]);
}

if (args[0] === 'api' && args[1] === 'graphql') {
  // The merged pull request search, two pages: #864 opened before the window, #865 in it.
  if (modes.has('empty-pr')) print({ next: null, items: [{}] });
  else if (!args.some((arg) => arg.startsWith('after='))) print({ next: 'c1', items: [{ number: 864, createdAt: '2026-11-17T09:00:00Z', mergedAt: '2026-11-18T10:50:00Z', mergeCommit: { oid: MERGE_COMMIT }, headRefName: 'feature', headRepository: { nameWithOwner: 'neurodesk/webapps' } }] });
  else print({ next: null, items: [{ number: 865, createdAt: '2026-11-18T09:30:00Z', mergedAt: '2026-11-18T10:30:00Z', mergeCommit: { oid: 'n'.repeat(40) }, headRefName: 'other', headRepository: { nameWithOwner: 'neurodesk/webapps' } }] });
} else if (/\/runs\/\d+\/jobs\?per_page=1&/.test(path)) {
  // A budget's job count: every ci pull request run ran 120 jobs.
  print(120);
} else if (/\/runs\/\d+\/jobs\?/.test(path)) {
  const id = Number(/\/runs\/(\d+)\//.exec(path)[1]);
  if (modes.has('fail-jobs')) fail('gh: You have exceeded a secondary rate limit (HTTP 403)');
  if (modes.has('hang-jobs')) hang();
  else {
    const marker = join(process.env.GH_STUB_STATE, `retried-${id}`);
    if (modes.has('retry') && id === 4 && !existsSync(marker)) {
      writeFileSync(marker, '');
      fail('gh: Server Error (HTTP 502)');
    }
    // Run 1 lists 45 jobs, two pages of 30; every other run one job.
    listing(id === 1 ? 45 : 1, 30, job);
  }
} else if (path.includes('/workflows/deploy-pages.yml/runs?')) {
  if (modes.has('break-summary') || modes.has('fifo-summary')) breakSummary();
  // 250 deploys, three pages of 100.
  listing(250, 100, (index) => run({ id: 1000 + index, name: 'deploy-github-pages', event: 'push', head_branch: 'main', head_sha: 'd'.repeat(40), pull_requests: [], created_at: '2026-11-18T10:59:00Z', updated_at: '2026-11-18T11:10:00Z' }));
} else if (args.includes('--paginate') && path.startsWith('repos/neurodesk/webapps/actions/runs?')) {
  // The budgets' listing of the window: the pull request's ci runs and five push runs.
  const ids = modes.has('over') ? [1, 2, 3] : [1];
  for (const id of ids) print(run({ id }));
  for (const id of [4, 5, 6, 7, 8]) print(run({ id, name: 'ants-native', event: 'push', head_branch: 'main', head_sha: 'b'.repeat(40), pull_requests: [], updated_at: '2026-11-18T09:05:00Z' }));
} else if (path.startsWith('repos/neurodesk/webapps/actions/runs?') && path.includes('branch=feature')) {
  // #864's run before the window.
  listing(1, 100, () => run({ id: 20, created_at: '2026-11-17T10:00:00Z', run_started_at: '2026-11-17T10:00:00Z', updated_at: '2026-11-17T10:20:00Z' }));
} else if (path.startsWith('repos/neurodesk/webapps/actions/runs?') && path.includes('branch=main')) {
  // The push run #864's merge commit started after the window.
  listing(1, 100, () => run({ id: 30, event: 'push', head_branch: 'main', head_sha: MERGE_COMMIT, pull_requests: [], created_at: '2026-11-18T11:01:00Z', updated_at: '2026-11-18T11:20:00Z' }));
} else {
  fail(`unexpected ${args.join(' ')}`);
}
