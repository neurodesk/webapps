// Runner time and queue latency of GitHub Actions runs, from the REST API's
// run and job objects. Queue latency (job created -> started) is kept apart
// from execution (started -> completed). GitHub bills each job rounded up to
// whole minutes; public repositories are not charged, but the rounded minutes
// are what a runner pool spends, and macOS runners are the scarce ones.

const seconds = (from, to) => (from && to ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 1000) : 0);

export function osOf(job) {
  const labels = (job.labels ?? []).join(' ').toLowerCase();
  if (labels.includes('macos')) return 'macOS';
  if (labels.includes('windows')) return 'Windows';
  return 'Linux';
}

// The ci.yml job a matrix job belongs to: `app-tests (niimath, ...)` -> `app-tests`.
export function jobGroup(name) {
  return name.replace(/ \(.*$/, '');
}

// Timing of one job, or null for a job that never needed a runner (skipped
// by its `if`, or a matrix placeholder).
export function jobTiming(job) {
  if (job.conclusion === 'skipped' || !job.started_at) return null;
  const run = seconds(job.started_at, job.completed_at);
  return {
    name: job.name,
    group: jobGroup(job.name),
    os: osOf(job),
    conclusion: job.conclusion,
    queueSeconds: seconds(job.created_at, job.started_at),
    runSeconds: run,
    billableMinutes: run > 0 ? Math.ceil(run / 60) : 0,
  };
}

// The planner's own summary line from the app-plan job log.
export function selectionFromLog(log) {
  const full = log.match(/Full catalog and site selected: (.*)/);
  if (full) return { kind: 'full', reason: full[1].trim() };
  const narrowed = log.match(/Selected (\d+) of (\d+) apps; site build (runs|skipped)/);
  if (!narrowed) return null;
  const [selected, total] = [Number(narrowed[1]), Number(narrowed[2])];
  return { kind: selected === total ? 'full' : selected === 0 ? 'no apps' : 'narrowed', selected, total, site: narrowed[3] === 'runs' };
}

// What the planner selected for a run: its logged summary, or, for runs from
// before it logged one, the number of app-tests jobs it created. Only a planner
// job that succeeded selected anything; otherwise the run stays unknown.
export function classifyRun({ planJob, log, jobs, catalogSize }) {
  if (planJob?.conclusion !== 'success') return null;
  const logged = selectionFromLog(log);
  if (logged) return logged;
  const created = jobs.filter((job) => /^app-tests \(/.test(job.name)).length;
  // A pull request that adds an app tests one more than main's catalog.
  const kind = created >= catalogSize ? 'full' : created === 0 ? 'no apps' : 'narrowed';
  return { kind: `${kind} (inferred)`, selected: created };
}

export function summarizeRun(run, jobs, selection) {
  const timings = jobs.map(jobTiming).filter(Boolean);
  const minutes = {};
  const queue = {};
  for (const timing of timings) {
    minutes[timing.os] = (minutes[timing.os] ?? 0) + timing.billableMinutes;
    (queue[timing.os] ??= []).push(timing.queueSeconds);
  }
  const ends = jobs.map((job) => job.completed_at).filter(Boolean).sort();
  return {
    id: run.id,
    event: run.event,
    conclusion: run.conclusion,
    createdAt: run.created_at,
    kind: selection?.kind ?? 'unknown',
    selected: selection?.selected ?? null,
    jobs: timings.length,
    perApp: {
      app: timings.filter((timing) => timing.group === 'app-tests').length,
      browser: timings.filter((timing) => timing.group === 'browser-e2e').length,
      gpu: timings.filter((timing) => timing.group === 'browser-e2e-gpu').length,
    },
    runQueueSeconds: seconds(run.created_at, run.run_started_at),
    wallSeconds: ends.length ? seconds(run.created_at, ends.at(-1)) : 0,
    minutes,
    queue,
    timings: timings.map(({ group, os, queueSeconds, runSeconds }) => ({ group, os, queueSeconds, runSeconds })),
  };
}

// Execution and queue latency per ci.yml job and runner OS, over every job
// that got a runner.
export function aggregateJobs(runs) {
  const groups = new Map();
  for (const timing of runs.flatMap((run) => run.timings)) {
    const key = `${timing.group} (${timing.os})`;
    const group = groups.get(key) ?? { job: key, run: [], queue: [] };
    group.run.push(timing.runSeconds);
    group.queue.push(timing.queueSeconds);
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => a.job.localeCompare(b.job)).map((group) => ({
    job: group.job,
    jobs: group.run.length,
    runMinutes: { median: minutesOf(percentile(group.run, 0.5)), p90: minutesOf(percentile(group.run, 0.9)), total: minutesOf(group.run.reduce((sum, value) => sum + value, 0)) },
    queueSeconds: { median: percentile(group.queue, 0.5), p90: percentile(group.queue, 0.9), max: percentile(group.queue, 1) },
  }));
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
}

const OSES = ['Linux', 'macOS', 'Windows'];

// Per selection kind: how many runs, their wall time, runner minutes by OS and
// job queue latency by OS. Only runs that finished (success or failure) count
// toward wall time and minutes; cancelled runs are counted separately because
// a superseding push stops them part-way.
export function aggregate(runs) {
  const groups = new Map();
  for (const run of runs) {
    const finished = ['success', 'failure'].includes(run.conclusion);
    const key = run.kind;
    const group = groups.get(key) ?? { kind: key, runs: 0, finished: 0, cancelled: 0, wall: [], minutes: Object.fromEntries(OSES.map((os) => [os, []])), queue: Object.fromEntries(OSES.map((os) => [os, []])), totalMinutes: Object.fromEntries(OSES.map((os) => [os, 0])) };
    group.runs += 1;
    if (run.conclusion === 'cancelled') group.cancelled += 1;
    for (const os of OSES) {
      group.totalMinutes[os] += run.minutes[os] ?? 0;
      group.queue[os].push(...(run.queue[os] ?? []));
    }
    if (finished) {
      group.finished += 1;
      group.wall.push(run.wallSeconds);
      for (const os of OSES) group.minutes[os].push(run.minutes[os] ?? 0);
    }
    groups.set(key, group);
  }
  return [...groups.values()].map((group) => ({
    kind: group.kind,
    runs: group.runs,
    finished: group.finished,
    cancelled: group.cancelled,
    wallMinutes: { median: minutesOf(percentile(group.wall, 0.5)), p90: minutesOf(percentile(group.wall, 0.9)) },
    runnerMinutesPerFinishedRun: Object.fromEntries(OSES.map((os) => [os, { median: percentile(group.minutes[os], 0.5), p90: percentile(group.minutes[os], 0.9) }])),
    runnerMinutesTotal: group.totalMinutes,
    jobQueueSeconds: Object.fromEntries(OSES.map((os) => [os, { jobs: group.queue[os].length, median: percentile(group.queue[os], 0.5), p90: percentile(group.queue[os], 0.9), max: percentile(group.queue[os], 1) }])),
  }));
}

function minutesOf(value) {
  return value === null ? null : Math.round(value / 6) / 10;
}
