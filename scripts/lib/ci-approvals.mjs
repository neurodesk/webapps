import { sanitize } from './nightly-failures.mjs';

const marker = '<!-- ci-approval-report -->';

export async function approvalReport(client, repository, { now = new Date(), days = 7 } = {}) {
  const since = new Date(now.getTime() - days * 86400000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const runsById = new Map();
  for (const status of ['failure', 'action_required']) {
    const matches = await client.list(`/actions/runs?status=${status}&created=${encodeURIComponent(`>=${since}`)}`, 'workflow_runs');
    for (const run of matches) runsById.set(run.id, run);
  }
  const runs = [...runsById.values()];
  const groups = new Map();
  const counts = { failedWithJobs: 0, failedWithoutJobs: 0, pendingApproval: 0, jobsUnknown: 0 };
  for (const run of runs) {
    const pending = run.status === 'action_required' || run.conclusion === 'action_required';
    if (!pending && run.conclusion !== 'failure') continue;
    let status = 'approval';
    if (pending) counts.pendingApproval++;
    else {
      try {
        const { total_count } = await client.request(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=1`);
        if (total_count > 0) { counts.failedWithJobs++; continue; }
        counts.failedWithoutJobs++;
        status = 'no-jobs';
      } catch {
        counts.jobsUnknown++;
        status = 'unknown';
      }
    }
    const key = `${run.head_sha}:${status}`;
    const group = groups.get(key) ?? { sha: run.head_sha, status, ids: [] };
    group.ids.push(run.id);
    groups.set(key, group);
  }
  const lines = [marker, '# CI approvals and runs without jobs', '',
    `Last ${days} days: ${counts.failedWithJobs} failed with jobs, ${counts.failedWithoutJobs} failed without jobs, ${counts.pendingApproval} awaiting approval, ${counts.jobsUnknown} with job data unavailable. Successful and cancelled runs are excluded.`, '',
    'Review contributor changes before approving runs. No approvals are granted by this reporter.',
    'A failure without jobs is not a test failure. Open the run annotation to distinguish expired approval from workflow validation or startup errors.', ''];
  for (const group of groups.values()) {
    const url = `https://github.com/${repository}/actions/runs/${group.ids[0]}`;
    const label = { approval: 'awaiting approval', 'no-jobs': 'failed without jobs', unknown: 'job data unavailable' }[group.status];
    lines.push(`<!-- ci-commit:${sanitize(group.sha, 40)}:${group.status} -->`);
    lines.push(`- ${sanitize(group.sha, 12)}: ${label}, ${group.ids.length} workflows. [Review run](${url})`);
  }
  return { counts, body: lines.join('\n'), actionable: groups.size > 0 };
}

export async function publishApprovalReport(client, report) {
  const issues = await client.list('/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc');
  const issue = issues.find(item => !item.pull_request && item.user?.login === 'github-actions[bot]' && item.body?.startsWith(marker));
  if (!report.actionable && !issue) return { skipped: true };
  if (issue) {
    const state = report.actionable ? 'open' : 'closed';
    if (issue.body === report.body && issue.state === state) return { unchanged: true };
    const pending = [...report.body.matchAll(/<!-- ci-commit:([0-9a-f]{40}):approval -->/g)]
      .filter(([entry]) => !issue.body.includes(entry));
    if (pending.length) {
      await client.request(`/issues/${issue.number}/comments`, {
        method: 'POST',
        body: { body: `New commits need workflow approval: ${pending.map(([, sha]) => sha.slice(0, 12)).join(', ')}. Review the runs linked in this issue before approving.` },
      });
    }
    return client.request(`/issues/${issue.number}`, { method: 'PATCH', body: { body: report.body, state } });
  }
  return client.request('/issues', { method: 'POST', body: { title: 'CI approvals and runs without jobs', body: report.body } });
}
