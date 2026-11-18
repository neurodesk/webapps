// Whether the CI got cheaper and faster: the measures of one day of workflow
// runs, from the run and job records the daily usage report already lists
// (scripts/ci-usage-report.mjs). Every function here is pure; the definitions
// are in docs/quality/ci-development-tiers.md, "Daily measures".
//
// Jobs are classified by one table, WORKFLOWS. A workflow or a `ci` job the
// table does not name is `unclassified`, and the report lists it, so a rename
// shows up instead of counting as zero. test/ci-measures.test.mjs requires an
// entry for every workflow file and every job of ci.yml.
import { percentile } from './ci-minutes.mjs';
import { LARGE_RUN_JOBS, ofPullRequest } from './ci-usage.mjs';

// What a job spends its runner on.
//   plan: decides what to run (planner, gate, plan marker); tests nothing
//   fixed: tests every ci run, whatever the change
//   app: tests the apps the plan selected
//   site: builds and checks the composite site
//   test: a test job of another workflow
//   deliver: deploys, publishes, releases or syncs
//   report: reports on other runs
const ROLES = Object.freeze(['plan', 'fixed', 'app', 'site', 'test', 'deliver', 'report', 'unclassified']);
const TESTED_NOTHING = new Set(['plan', 'report']);

// The jobs of ci.yml, by job id. A job of the `ci` workflow not listed here is unclassified.
const CI_JOBS = Object.freeze({
  'app-plan': 'plan',
  'full-plan': 'plan',
  'full-plan-withheld': 'plan',
  'workspace-contracts': 'fixed',
  'homepage-easter-egg': 'fixed',
  'app-tests': 'app',
  'browser-e2e': 'app',
  'browser-e2e-gpu': 'app',
  'composite-site': 'site',
  'example-cache-retention': 'site',
  'agent-interactions': 'site',
});

// The ci jobs a pull request run starts only once the pull request is ready
// for review. A run that started none of them is a draft run; a ready run that
// selected neither the site nor more than its draft plan also counts as one.
export const READY_ONLY_CI_JOBS = Object.freeze(['full-plan', 'full-plan-withheld', 'composite-site']);

// The workflow that puts the catalogue sites live, by name and file.
export const DEPLOY_WORKFLOW = Object.freeze({ name: 'deploy-github-pages', file: 'deploy-pages.yml' });

// Every workflow by its `name:`. In a `test` workflow the reusable gate's jobs
// (`gate / decide`) plan and every other job tests.
const TEST = 'test';
export const WORKFLOWS = Object.freeze({
  ci: CI_JOBS,
  'ants-native': TEST,
  'bison-native': TEST,
  'brain-extraction-native': TEST,
  'brain2print-native': TEST,
  'browserqc-native': TEST,
  'calmar-native': TEST,
  'carotid-flow-native': TEST,
  'code-quality': TEST,
  'compute-server-native': TEST,
  'deconvolution-native': TEST,
  'deface-native': TEST,
  'degibbs-native': TEST,
  'dependency-quality': TEST,
  'desktop-source-approval': TEST,
  'dicompare-native': TEST,
  'disconnectome-native': TEST,
  'dwi-native': TEST,
  'dwi2trx-native': TEST,
  'dwidenoise-native': TEST,
  'easy-mp2rage-native': TEST,
  'edgereg-native': TEST,
  'elastix-native': TEST,
  'fireants-native': TEST,
  'greedy-native': TEST,
  'hmc-native': TEST,
  'hmc-registration': TEST,
  'lcmodel-native': TEST,
  'mri2vid-native': TEST,
  'musclemap-native': TEST,
  'musclemap-parity': TEST,
  'mutation-quality': TEST,
  'n4-native': TEST,
  'n4-wasm-source': TEST,
  'native-nifti': TEST,
  'native-publish': TEST,
  'nesvor-real-validation': TEST,
  neuroflow: TEST,
  'niimath-native': TEST,
  'noddi-native': TEST,
  'node-cli': TEST,
  'node-drivers': TEST,
  'qsmbly-native': TEST,
  'samsrf-native': TEST,
  'sct-full-tests': TEST,
  'sdc-native': TEST,
  'sdc-registration-gate': TEST,
  'seedseg-native': TEST,
  'spinalcordtoolbox-native': TEST,
  standalone: TEST,
  'standalone-links': TEST,
  'syncro-native': TEST,
  'synthseg-native': TEST,
  'synthseg-portable': TEST,
  'synthsr-native': TEST,
  'topofit-native': TEST,
  'unused-code': TEST,
  'vesselboost-native': TEST,
  'white-matter-lesions-native': TEST,
  'windows-signing-policy': TEST,
  'deploy-github-pages': 'deliver',
  'deploy-vessel-surfer-leaderboard': 'deliver',
  'release-apps': 'deliver',
  'standalone-catalog': 'deliver',
  'upstream sync': 'deliver',
  'CALMaR knowledge-base sync': 'deliver',
  'Apple notarization alert': 'report',
  'CI approval report': 'report',
  'ci-usage': 'report',
  'scheduled workflow failure reports': 'report',
});

const GATE_JOB = /^gate( \/ |$)/;
// A job's name without its matrix values: `app-tests (calmar, calmar)` is `app-tests`.
const jobKind = (name) => name.replace(/ \(.*$/, '');

export function jobRole(workflow, jobName) {
  const entry = Object.hasOwn(WORKFLOWS, workflow) ? WORKFLOWS[workflow] : undefined;
  if (entry === undefined) return 'unclassified';
  if (typeof entry === 'object') return Object.hasOwn(entry, jobKind(jobName)) ? entry[jobKind(jobName)] : 'unclassified';
  if (entry === TEST && GATE_JOB.test(jobName)) return 'plan';
  return entry;
}

const ran = (jobs = []) => jobs.filter((job) => job.conclusion !== 'skipped' && job.started_at);
// GitHub gives a job it cancelled before a runner took it a start time too;
// only a runner shows that the job ran.
const tookRunner = (job) => job.conclusion !== 'skipped' && Boolean(job.runner_name);

// A job's runner minutes; one still running counts up to `now`.
function jobMinutes(job, now) {
  if (job.conclusion === 'skipped' || !job.started_at) return 0;
  const end = job.completed_at ? Date.parse(job.completed_at) : Date.parse(now);
  const minutes = (end - Date.parse(job.started_at)) / 60000;
  return Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
}

const sumMinutes = (jobs, now) => jobs.reduce((sum, job) => sum + jobMinutes(job, now), 0);
const minutesBetween = (from, to) => (Date.parse(to) - Date.parse(from)) / 60000;
const round = (value) => (value === null ? null : Math.round(value));
const stats = (values) => ({ count: values.length, median: round(percentile(values, 0.5)), p90: round(percentile(values, 0.9)), max: round(values.length ? Math.max(...values) : null) });

// A pull request ci run is `whole` when it ran most of the catalogue, `ready`
// when a ready-only job took a runner and `draft` otherwise. A cancelled run
// whose ready-only jobs were neither skipped nor given a runner is `unknown`:
// a run cancelled while planning cancels them whatever its plan.
export function ciPullRequestTier(jobs = [], conclusion = 'success') {
  const listed = jobs.filter((job) => job.conclusion !== 'skipped');
  if (listed.length >= LARGE_RUN_JOBS) return 'whole';
  const markers = listed.filter((job) => READY_ONLY_CI_JOBS.includes(jobKind(job.name)));
  if (markers.some(tookRunner)) return 'ready';
  return conclusion === 'cancelled' && markers.length ? 'unknown' : 'draft';
}

const ciPullRequestRuns = (runs) => runs.filter((run) => run.name === 'ci' && run.event === 'pull_request');

// Of the job minutes of pull request ci runs, the share in plan and fixed jobs, per tier.
export function fixedJobShare(runs, jobs, now) {
  const tiers = Object.fromEntries(['draft', 'ready', 'whole', 'unknown', 'all'].map((tier) => [tier, { runs: 0, minutes: 0, fixedMinutes: 0 }]));
  for (const run of ciPullRequestRuns(runs)) {
    const list = jobs.get(run.id) ?? [];
    const fixed = list.filter((job) => ['plan', 'fixed'].includes(jobRole('ci', job.name)));
    for (const tier of [ciPullRequestTier(list, run.conclusion), 'all']) {
      tiers[tier].runs += 1;
      tiers[tier].minutes += sumMinutes(list, now);
      tiers[tier].fixedMinutes += sumMinutes(fixed, now);
    }
  }
  return Object.fromEntries(Object.entries(tiers).map(([tier, row]) => [tier, { runs: row.runs, minutes: Math.round(row.minutes), fixedMinutes: Math.round(row.fixedMinutes), share: row.minutes ? row.fixedMinutes / row.minutes : null }]));
}

// Minutes from the start of the latest attempt to completion of the ready
// pull request ci runs that finished green, apart for runs that tested most
// of the catalogue. A re-run hours later counts from the re-run.
export function readyToGreen(runs, jobs) {
  const walls = { ready: [], whole: [] };
  for (const run of ciPullRequestRuns(runs)) {
    if (run.conclusion !== 'success') continue;
    const tier = ciPullRequestTier(jobs.get(run.id), run.conclusion);
    if (Object.hasOwn(walls, tier)) walls[tier].push(minutesBetween(run.run_started_at ?? run.created_at, run.updated_at));
  }
  return { ready: stats(walls.ready), whole: stats(walls.whole) };
}

// Minutes from each push to main to the completion of the first successful
// deploy on main of that commit or a later one. Pushes are the commits of the
// window's push runs on main, at their first run's creation. `deploys` may
// reach past the window. A deploy on main runs main's head when it is
// created, so a deploy of a commit the pushes do not name covers the pushes
// created before it.
export function mergeToLive(runs, deploys) {
  const pushes = new Map();
  for (const run of runs) {
    if (run.event !== 'push' || run.head_branch !== 'main') continue;
    if (!pushes.has(run.head_sha) || run.created_at < pushes.get(run.head_sha)) pushes.set(run.head_sha, run.created_at);
  }
  const order = [...pushes].sort((a, b) => a[1].localeCompare(b[1]));
  const index = new Map(order.map(([sha], position) => [sha, position]));
  const live = deploys.filter((run) => run.name === DEPLOY_WORKFLOW.name && run.head_branch === 'main' && run.conclusion === 'success');
  const covers = (deploy, position, pushedAt) => (index.has(deploy.head_sha) ? index.get(deploy.head_sha) >= position : deploy.created_at >= pushedAt);
  const minutes = [];
  const pending = [];
  order.forEach(([sha, pushedAt], position) => {
    const done = live.filter((deploy) => covers(deploy, position, pushedAt) && deploy.updated_at >= pushedAt).map((deploy) => deploy.updated_at).sort()[0];
    if (done) minutes.push(minutesBetween(pushedAt, done));
    else pending.push(sha.slice(0, 9));
  });
  return { ...stats(minutes), pushes: order.length, pending };
}

// Whether a run belongs to a merged pull request: its runs on the head branch
// from its opening to its merge, its merge queue runs and the push runs of its
// merge commit.
function ofMergedPullRequest(run, pullRequest) {
  if (run.event === 'push' && run.head_branch === 'main') return run.head_sha === pullRequest.mergeCommit;
  if (run.event === 'merge_group') return run.head_branch?.startsWith(`gh-readonly-queue/main/pr-${pullRequest.number}-`) ?? false;
  return run.created_at >= pullRequest.createdAt && run.created_at <= pullRequest.mergedAt && ofPullRequest(run, pullRequest);
}

// Job minutes of every run of each merged pull request ({ number, repository,
// branch, createdAt, mergedAt, mergeCommit }). `runs` holds the window's runs
// and the earlier runs of pull requests opened before it.
export function minutesPerMergedPullRequest(pullRequests, runs, jobs, now) {
  const rows = pullRequests.map((pullRequest) => {
    const own = runs.filter((run) => ofMergedPullRequest(run, pullRequest));
    return { number: pullRequest.number, runs: own.length, minutes: Math.round(own.reduce((sum, run) => sum + sumMinutes(jobs.get(run.id) ?? [], now), 0)) };
  }).sort((a, b) => b.minutes - a.minutes);
  return { pullRequests: rows.length, median: round(percentile(rows.map((row) => row.minutes), 0.5)), largest: rows.slice(0, 3) };
}

// Why a run tested nothing, or null when it ran a job that tests or delivers.
function idleReason(run, jobs) {
  if (run.conclusion === 'skipped') return 'skipped';
  const roles = ran(jobs).map((job) => jobRole(run.name, job.name));
  if (!roles.length) return 'no job';
  if (!roles.every((role) => TESTED_NOTHING.has(role))) return null;
  return roles.includes('report') ? 'report only' : 'plan or gate only';
}

export function idleRuns(runs, jobs) {
  const reasons = { skipped: 0, 'no job': 0, 'report only': 0, 'plan or gate only': 0 };
  for (const run of runs) {
    const reason = idleReason(run, jobs.get(run.id));
    if (reason) reasons[reason] += 1;
  }
  const idle = Object.values(reasons).reduce((sum, count) => sum + count, 0);
  return { runs: runs.length, idle, share: runs.length ? idle / runs.length : null, reasons };
}

export function cancelledMinutes(runs, jobs, now) {
  const cancelled = runs.filter((run) => run.conclusion === 'cancelled');
  const minutesOf = (list) => Math.round(list.reduce((sum, run) => sum + sumMinutes(jobs.get(run.id) ?? [], now), 0));
  return { runs: cancelled.length, minutes: minutesOf(cancelled), pullRequestCiMinutes: minutesOf(ciPullRequestRuns(cancelled)) };
}

// Job minutes by role, and every unclassified workflow or ci job with its minutes.
export function minutesByRole(runs, jobs, now) {
  const roles = Object.fromEntries(ROLES.map((role) => [role, 0]));
  const unclassified = new Map();
  for (const run of runs) {
    // A workflow the table does not name shows even when it started no job.
    if (!Object.hasOwn(WORKFLOWS, run.name)) unclassified.set(run.name, unclassified.get(run.name) ?? 0);
    for (const job of ran(jobs.get(run.id))) {
      const role = jobRole(run.name, job.name);
      roles[role] += jobMinutes(job, now);
      if (role !== 'unclassified') continue;
      const key = Object.hasOwn(WORKFLOWS, run.name) ? `${run.name}: ${jobKind(job.name)}` : run.name;
      unclassified.set(key, (unclassified.get(key) ?? 0) + jobMinutes(job, now));
    }
  }
  return {
    total: Math.round(Object.values(roles).reduce((sum, minutes) => sum + minutes, 0)),
    roles: Object.fromEntries(Object.entries(roles).map(([role, minutes]) => [role, Math.round(minutes)])),
    unclassified: [...unclassified].map(([name, minutes]) => ({ name, minutes: Math.round(minutes) })).sort((a, b) => b.minutes - a.minutes),
  };
}

// The program's goals. They are compared in the report, not enforced: a
// budget that fails the daily job opens an issue, and the changes that reach
// these have not all landed.
export const TARGETS = Object.freeze({
  readyToGreenMedianMinutes: 20,
  draftFixedShare: 0.3,
});

// The data each measure reads beyond the window's runs. The report collects
// the jobs, the merged pull requests (with their runs outside the window and
// those runs' jobs) and the deploys under a request cap.
const SOURCES = Object.freeze({
  minutes: ['jobs'],
  perMergedPullRequest: ['jobs', 'pullRequests'],
  fixedShare: ['jobs'],
  readyToGreen: ['jobs'],
  mergeToLive: ['deploys'],
  idle: ['jobs'],
  cancelled: ['jobs'],
});

// `runs` are the window's runs, `earlierRuns` the runs before it of the pull
// requests merged in it, `lateRuns` the push runs of their merge commits
// created after it, and `deploys` the deploy runs from the window's start to
// the report. `unavailable` maps a source the report could not read to why: a
// measure that reads it is `{ unavailable: reason }`, never a zero.
export function summarizeMeasures({ runs, earlierRuns = [], lateRuns = [], jobs, pullRequests, deploys, now, unavailable = {} }) {
  const compute = {
    minutes: () => minutesByRole(runs, jobs, now),
    perMergedPullRequest: () => minutesPerMergedPullRequest(pullRequests, [...earlierRuns, ...runs, ...lateRuns], jobs, now),
    fixedShare: () => fixedJobShare(runs, jobs, now),
    readyToGreen: () => readyToGreen(runs, jobs),
    mergeToLive: () => mergeToLive(runs, deploys),
    idle: () => idleRuns(runs, jobs),
    cancelled: () => cancelledMinutes(runs, jobs, now),
  };
  return Object.fromEntries(Object.entries(compute).map(([measure, measureOf]) => {
    const missing = SOURCES[measure].find((source) => unavailable[source]);
    return [measure, missing ? { unavailable: unavailable[missing] } : measureOf()];
  }));
}

const percent = (share) => (share === null ? '-' : `${Math.round(share * 100)}%`);
const value = (number) => (number === null ? '-' : String(number));
const against = (met, target) => (met === null ? `target ${target}, no runs` : `${met ? 'meets' : 'misses'} the target ${target}`);

export function measuresMarkdown(measures, targets = TARGETS) {
  const { minutes, perMergedPullRequest: merged, fixedShare, readyToGreen: green, mergeToLive: live, idle, cancelled } = measures;
  const lines = ['### Measures', '', 'Job minutes are runner minutes: the time each job held a runner. The targets are report-only.', '', '| Measure | Value | Compared with |', '| --- | --- | --- |'];
  // A row's cells, or "unavailable" with the reason when its measure could not be read.
  const row = (label, measure, cells) => lines.push(`| ${label} | ${(measure.unavailable ? [`unavailable: ${measure.unavailable}`, '-'] : cells()).join(' | ')} |`);
  row('Job minutes per merged pull request, median', merged, () => [`${value(merged.median)} over ${merged.pullRequests} pull requests; largest ${merged.largest.map((each) => `#${each.number} ${each.minutes} (${each.runs} runs)`).join(', ') || '-'}`, '-']);
  row('Fixed-job share of draft pull request ci runs', fixedShare, () => {
    const share = fixedShare.draft.share;
    return [`${percent(share)} (${fixedShare.draft.fixedMinutes} of ${fixedShare.draft.minutes} min, ${fixedShare.draft.runs} runs)`, against(share === null ? null : share < targets.draftFixedShare, `under ${percent(targets.draftFixedShare)}`)];
  });
  row('Fixed-job share of ready, whole-catalogue and all pull request ci runs', fixedShare, () => [`${percent(fixedShare.ready.share)}, ${percent(fixedShare.whole.share)}, ${percent(fixedShare.all.share)}`, '-']);
  row('Cancelled pull request ci runs of unknown tier', fixedShare, () => [`${fixedShare.unknown.runs} runs, ${fixedShare.unknown.minutes} min: cancelled before a ready-only job took a runner or was skipped`, '-']);
  row('Ready to green, median and 90th percentile', green, () => {
    const median = green.ready.median;
    return [`${value(median)} and ${value(green.ready.p90)} min over ${green.ready.count} runs`, against(median === null ? null : median < targets.readyToGreenMedianMinutes, `under ${targets.readyToGreenMedianMinutes} min`)];
  });
  row('Ready to green of whole-catalogue runs, median and 90th percentile', green, () => [`${value(green.whole.median)} and ${value(green.whole.p90)} min over ${green.whole.count} runs`, '-']);
  row('Merge to live, median and maximum', live, () => [`${value(live.median)} and ${value(live.max)} min over ${live.count} of ${live.pushes} pushes`, live.pending.length ? `not live yet: ${live.pending.join(', ')}` : '-']);
  row('Runs that tested nothing', idle, () => [`${idle.idle} of ${idle.runs} (${percent(idle.share)}): ${Object.entries(idle.reasons).map(([reason, count]) => `${count} ${reason}`).join(', ')}`, '-']);
  row('Job minutes of cancelled runs', cancelled, () => [`${cancelled.minutes} in ${cancelled.runs} runs, ${cancelled.pullRequestCiMinutes} of them in pull request ci runs`, '-']);
  if (minutes.unavailable) {
    lines.push('', `Job minutes by role unavailable: ${minutes.unavailable}.`, '');
    return `${lines.join('\n')}\n`;
  }
  lines.push('', `${minutes.total} job minutes: ${ROLES.map((role) => `${role} ${minutes.roles[role]}`).join(', ')}.`, '');
  if (minutes.unclassified.length) {
    lines.push('Unclassified jobs: no measure counts them as fixed, test or idle. Name their workflow or ci job in WORKFLOWS (scripts/lib/ci-measures.mjs).', '', ...minutes.unclassified.map((each) => `- ${each.name}: ${each.minutes} min`), '');
  }
  return `${lines.join('\n')}\n`;
}
