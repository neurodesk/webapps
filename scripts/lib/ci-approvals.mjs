import { sanitize } from './nightly-failures.mjs';
import { randomUUID } from 'node:crypto';

const marker = '<!-- ci-approval-report -->';
const BODY_LIMIT = 60000;
const labels = { approval: 'awaiting approval', 'no-jobs': 'failed without jobs', unknown: 'job data unavailable' };

function plain(value, limit = 250) {
  return sanitize(value, limit).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()!|#]/g, '\\$&');
}

function sameSource(left, right) {
  if (!left || !right) return false;
  if (left.id && right.id) return left.id === right.id;
  return Boolean(left.full_name && right.full_name && left.full_name.toLowerCase() === right.full_name.toLowerCase());
}

function currentPull(run, pulls) {
  const matches = pulls.filter(pull =>
    sameSource(run.head_repository, pull.head.repo) && run.head_branch === pull.head.ref &&
    (run.head_sha === pull.head.sha || run.head_sha === pull.merge_commit_sha));
  return matches.find(pull => run.pull_requests?.some(item => item.number === pull.number)) ?? matches[0];
}

function workflowKey(run) {
  return [run.workflow_id, run.event, run.head_repository?.id ?? run.head_repository?.full_name, run.head_branch].join(':');
}

function needsAttention(run) {
  return (run.status === 'completed' || run.status === 'action_required') &&
    (['failure', 'startup_failure', 'action_required'].includes(run.conclusion) || run.status === 'action_required');
}

function laterRun(left, right) {
  const difference = Date.parse(left.run_started_at ?? left.created_at) - Date.parse(right.run_started_at ?? right.created_at);
  return Number.isFinite(difference) && difference !== 0 ? difference > 0 : left.id > right.id;
}

function limitBody(body) {
  if (body.length <= BODY_LIMIT) return body;
  const notice = '\n\nReport truncated. Counts include all current blockers.';
  if (body.indexOf('\n# CI approvals') >= BODY_LIMIT - notice.length) {
    throw new Error('Too many PR notification markers to fit the report');
  }
  body = body.slice(0, BODY_LIMIT - notice.length);
  return body.slice(0, body.lastIndexOf('\n')) + notice;
}

function entries(body) {
  return [...body.matchAll(/<!-- ci-pr:(\d+):(approval|no-jobs|unknown):([0-9a-f]{40}) -->/g)];
}

function notifications(body) {
  return [...body.matchAll(/<!-- ci-notify:([0-9a-f-]{36}):(\d+:(?:approval|no-jobs)) -->/g)]
    .map(([, id, key]) => ({ id, key }));
}

function withNotifications(body, pending) {
  const markers = pending.map(({ id, key }) => `<!-- ci-notify:${id}:${key} -->`);
  return limitBody(body.replace(marker, [marker, ...markers].join('\n')));
}

async function diagnostics(client, run) {
  const details = [];
  if (!run.check_suite_id) return details;
  try {
    const checks = await client.list(`/check-suites/${run.check_suite_id}/check-runs?filter=latest`, 'check_runs');
    for (const check of checks.filter(item => item.conclusion === 'failure').slice(0, 3)) {
      let detail = check.output?.summary || check.output?.title;
      if (check.output?.annotations_count > 0) {
        try {
          const annotations = await client.list(`/check-runs/${check.id}/annotations`);
          detail = annotations.find(item => item.annotation_level === 'failure')?.message || detail;
        } catch {
          // Check output can still explain a failure when annotation lookup fails.
        }
      }
      if (detail) details.push(plain(detail, 500));
    }
  } catch {
    // GitHub does not expose every workflow-level annotation through the Checks API.
  }
  return details;
}

function waitingTime(run, now) {
  const hours = Math.floor((now.getTime() - Date.parse(run.created_at)) / 3600000);
  if (!Number.isFinite(hours)) return 'waiting time unavailable';
  if (hours < 1) return 'less than 1h';
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export async function approvalReport(client, repository, { now = new Date(), days = 7 } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const pulls = await client.list('/pulls?state=open');
  const runsById = new Map();
  for (const status of ['failure', 'startup_failure', 'action_required']) {
    const matches = await client.list(`/actions/runs?status=${status}&created=${encodeURIComponent(`>=${since}`)}`, 'workflow_runs');
    for (const run of matches) runsById.set(run.id, run);
  }
  const groups = new Map();
  const currentRuns = new Map();
  const otherRuns = new Map();
  async function runsAtHead(sha) {
    if (!currentRuns.has(sha)) {
      const matches = await client.list(`/actions/runs?head_sha=${encodeURIComponent(sha)}`, 'workflow_runs');
      const latest = new Map();
      for (const match of matches) {
        const key = workflowKey(match);
        if (!latest.has(key) || laterRun(match, latest.get(key))) latest.set(key, match);
      }
      currentRuns.set(sha, latest);
    }
    return currentRuns.get(sha);
  }
  for (const pull of pulls) {
    for (const sha of new Set([pull.head.sha, pull.merge_commit_sha].filter(Boolean))) {
      for (const run of (await runsAtHead(sha)).values()) {
        if (run.event === 'pull_request' && currentPull(run, pulls) && !runsById.has(run.id)) runsById.set(run.id, run);
      }
    }
  }
  const seen = new Set();
  const counts = { failedWithJobs: 0, failedWithoutJobs: 0, pendingApproval: 0, jobsUnknown: 0, obsolete: 0, superseded: 0 };
  for (const candidate of runsById.values()) {
    if (!needsAttention(candidate)) continue;
    const pull = candidate.event === 'pull_request' ? currentPull(candidate, pulls) : undefined;
    if (candidate.event === 'pull_request' && !pull) {
      counts.obsolete++;
      continue;
    }
    let run;
    if (pull) {
      run = (await runsAtHead(candidate.head_sha)).get(workflowKey(candidate));
    } else {
      const key = workflowKey(candidate);
      if (!otherRuns.has(key)) {
        const matches = await client.list(`/actions/workflows/${candidate.workflow_id}/runs?branch=${encodeURIComponent(candidate.head_branch)}&event=${encodeURIComponent(candidate.event)}&created=${encodeURIComponent(`>=${since}`)}`, 'workflow_runs');
        let latest;
        for (const match of matches) {
          if (workflowKey(match) === key && (!latest || laterRun(match, latest))) latest = match;
        }
        otherRuns.set(key, latest);
      }
      run = otherRuns.get(key);
    }
    if (!run || !needsAttention(run)) {
      counts.superseded++;
      continue;
    }
    if (run.id !== candidate.id) counts.superseded++;
    if (seen.has(run.id)) continue;
    seen.add(run.id);
    const pending = run.status === 'action_required' || run.conclusion === 'action_required';
    let status = 'approval';
    if (pending) counts.pendingApproval++;
    else {
      try {
        const { total_count } = await client.request(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=1`);
        if (total_count > 0) {
          counts.failedWithJobs++;
          continue;
        }
        counts.failedWithoutJobs++;
        status = 'no-jobs';
      } catch {
        counts.jobsUnknown++;
        status = 'unknown';
      }
    }
    const key = pull ? `pr:${pull.number}` : `other:${run.head_branch}:${run.head_sha}`;
    const group = groups.get(key) ?? { pull, sha: pull?.head.sha ?? run.head_sha, branch: run.head_branch, runs: [] };
    group.runs.push({ run, status, details: status === 'no-jobs' ? await diagnostics(client, run) : [] });
    groups.set(key, group);
  }
  const markers = [...groups.values()].filter(group => group.pull).flatMap(group =>
    [...new Set(group.runs.map(item => item.status))].map(status => `<!-- ci-pr:${group.pull.number}:${status}:${group.sha} -->`));
  const lines = [marker, ...markers, '# CI approvals and runs without jobs', '',
    `Current PR runs and other runs created in the last ${days} days: ${counts.pendingApproval} awaiting approval, ${counts.failedWithoutJobs} failed without jobs, ${counts.jobsUnknown} with job data unavailable.`,
    `${counts.failedWithJobs} failures with jobs are outside this report. Excluded ${counts.obsolete} runs from closed PRs or older commits and ${counts.superseded} superseded workflow runs or attempts.`,
    'Exclusion does not establish that checks passed. Successful, cancelled and running attempts are not blockers in this report.', '',
    'Review contributor changes before approving runs. No approvals are granted by this reporter.',
    'A failure without jobs is not a test failure. When no diagnostic is available, inspect the run annotation to determine the cause.',
    `[Inspect all workflow runs](https://github.com/${repository}/actions).`, ''];
  if (!groups.size) lines.push('No current approval or startup blockers found.');
  for (const group of groups.values()) {
    if (group.pull) {
      const pull = group.pull;
      lines.push(`### [#${pull.number}: ${plain(pull.title)}](https://github.com/${repository}/pull/${pull.number})`, '',
        `Author: ${plain(pull.user.login)}. Current commit: ${plain(group.sha, 12)}.`, '');
    } else {
      lines.push(`### Other runs on ${plain(group.branch)} at ${plain(group.sha, 12)}`, '');
    }
    for (const { run, status, details } of group.runs) {
      const url = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
      const label = status === 'no-jobs' && !details.length ? 'failed without jobs, cause unknown' : labels[status];
      lines.push(`- [${plain(run.name)}](${url}): ${label}; created ${waitingTime(run, now)} ago.`);
      for (const detail of details) lines.push(`  - GitHub diagnostic: ${detail}`);
    }
    lines.push('');
  }
  const body = limitBody(lines.join('\n'));
  return { counts, body, actionable: groups.size > 0 };
}

export async function publishApprovalReport(client, report) {
  const issues = await client.list('/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc');
  const issue = issues.find(item => !item.pull_request && item.user?.login === 'github-actions[bot]' && item.body?.startsWith(marker));
  if (!report.actionable && !issue) return { skipped: true };
  if (issue) {
    const state = report.actionable ? 'open' : 'closed';
    const current = entries(report.body);
    const unknown = new Set(current.filter(([, , status]) => status === 'unknown').map(([, number]) => number));
    const currentKeys = new Set(current.map(([, number, status]) => `${number}:${status}`));
    const prior = entries(issue.body);
    const retained = prior.filter(([, number, status]) => status !== 'unknown' && unknown.has(number) && !currentKeys.has(`${number}:${status}`));
    const unknownCommits = new Set(current.filter(([, , status]) => status === 'unknown').map(([, , , sha]) => sha));
    const legacy = [...issue.body.matchAll(/<!-- ci-commit:([0-9a-f]{40}):(approval|no-jobs) -->/g)]
      .filter(([, sha]) => unknownCommits.has(sha));
    const body = limitBody(report.body.replace(marker, [marker, ...retained.map(([entry]) => entry), ...legacy.map(([entry]) => entry)].join('\n')));
    const queued = notifications(issue.body)
      .filter(({ key }) => currentKeys.has(key) || unknown.has(key.split(':')[0]));
    const scheduled = new Set(queued.map(item => item.key));
    const previous = new Set(prior.map(([, number, status]) => `${number}:${status}`));
    const pending = current.filter(([, number, status, sha]) => status !== 'unknown' &&
      !previous.has(`${number}:${status}`) && !scheduled.has(`${number}:${status}`) &&
      !issue.body.includes(`<!-- ci-commit:${sha}:${status} -->`));
    queued.push(...pending.map(([, number, status]) => ({ id: randomUUID(), key: `${number}:${status}` })));
    const queuedBody = withNotifications(body, queued);
    let updated = { unchanged: true };
    if (issue.body !== queuedBody || issue.state !== state) {
      updated = await client.request(`/issues/${issue.number}`, { method: 'PATCH', body: { body: queuedBody, state } });
    }
    const ready = queued.filter(item => currentKeys.has(item.key));
    if (!ready.length) return updated;
    const comments = await client.list(`/issues/${issue.number}/comments`);
    const undelivered = ready.filter(({ id }) => !comments.some(comment =>
      comment.user?.login === 'github-actions[bot]' && comment.body?.includes(`<!-- ci-notify:${id} -->`)));
    if (undelivered.length) {
      const commentMarkers = undelivered.map(({ id }) => `<!-- ci-notify:${id} -->`).join('\n');
      await client.request(`/issues/${issue.number}/comments`, {
        method: 'POST',
        body: { body: `${commentMarkers}\nNew CI blockers need review: ${undelivered.map(({ key }) => {
          const [number, status] = key.split(':');
          return `#${number} (${labels[status]})`;
        }).join(', ')}. Review the PRs and runs linked in this issue. Workflow approval remains manual.` },
      });
    }
    const delivered = new Set(ready.map(item => item.id));
    return client.request(`/issues/${issue.number}`, {
      method: 'PATCH', body: { body: withNotifications(body, queued.filter(item => !delivered.has(item.id))), state },
    });
  }
  return client.request('/issues', { method: 'POST', body: { title: 'CI approvals and runs without jobs', body: report.body } });
}
