import { sanitize } from './nightly-failures.mjs';

// Who is assigned, and so notified, when Apple refuses a notarization.
export const NOTARIZATION_OWNER = 'stebo85';
export const ALERT_MARKER = '<!-- apple-notarization-alert -->';

// What notarytool and @electron/notarize print when Apple refuses: an expired agreement or bad credentials
// (HTTP 401/403 from the notary service) or a rejected submission. A Developer ID certificate or keychain
// failure before notarization is not one of these.
const SIGNATURES = [
  /required agreement is missing or has expired/i,
  /Failed to notarize via notarytool/,
  /\bError: HTTP status code: 40[13]\b/,
  /^(?:\S+\s+)?\s*status: (?:Invalid|Rejected)\s*$/,
];

export function notaryFailure(text) {
  const lines = text.split('\n');
  const index = lines.findIndex(line => SIGNATURES.some(signature => signature.test(line)));
  if (index < 0) return undefined;
  const detail = lines.slice(index).find(line => /HTTP status code|agreement|status: (?:Invalid|Rejected)/i.test(line)) ?? lines[index];
  return detail.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s*/, '').trim();
}

function numeric(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Expected a numeric GitHub identifier');
  return String(value);
}

function text(value, limit = 500) {
  return sanitize(value, limit).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()!|#]/g, '\\$&');
}

// A notarization error is printed near the end of a job's log, after the
// whole build: read far enough for the largest macOS release logs.
const LOG_LIMIT = 64 * 1024 * 1024;
const FAILED = new Set(['failure', 'timed_out']);

// `notarizing` holds the paths of the workflows that notarize (workflowFacts in workflow-reports.mjs).
export async function alertNotarization({ run, repository, client, notarizing, owner = NOTARIZATION_OWNER, dryRun = false }) {
  if (run.status !== 'completed' || !FAILED.has(run.conclusion)) return { skipped: 'Run did not fail' };
  if (run.event === 'pull_request' || !notarizing.includes(run.path)) return { skipped: 'Run does not notarize' };
  if (run.head_repository?.full_name !== repository) return { skipped: 'Run is not from this repository' };
  const runId = numeric(run.id);
  const attempt = numeric(run.run_attempt ?? 1);
  const jobs = await client.list(`/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs');
  const candidates = jobs.filter(job => FAILED.has(job.conclusion) && (job.labels ?? []).some(label => /macos/i.test(label)));
  const failures = [];
  const incomplete = [];
  for (const job of candidates) {
    const logs = await client.request(`/actions/jobs/${numeric(job.id)}/logs`, { logs: true, logLimit: LOG_LIMIT });
    const detail = notaryFailure(logs.text);
    if (detail) failures.push({ job, detail });
    else if (logs.truncated) incomplete.push(job.name);
  }
  if (!failures.length) {
    return incomplete.length
      ? { skipped: 'No notarization failure in the part of the logs read', incomplete }
      : { skipped: 'No notarization failure in the failed macOS jobs' };
  }
  const attemptMarker = `<!-- notarization-run:${runId}:attempt:${attempt} -->`;
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const report = [attemptMarker,
    `Apple refused a notarization in [${text(run.name, 100)} run ${runId}, attempt ${attempt}](${runUrl}) (${text(run.event, 40)} on ${text(run.head_branch, 100)}).`, '',
    ...failures.map(({ job, detail }) => `- [${text(job.name, 200)}](https://github.com/${repository}/actions/runs/${runId}/job/${numeric(job.id)}): ${text(detail)}`), '',
    'An expired agreement (HTTP 403) is renewed by the Account Holder at https://developer.apple.com/account; check the Apple ID and app-specific password secrets for HTTP 401.',
    `After fixing it, rerun the failed jobs: \`gh run rerun ${runId} --failed --repo ${repository}\`. Release dispatches publish when their release job passes.`,
  ].join('\n');
  const alerts = async () => (await client.list('/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc'))
    .filter(issue => !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.startsWith(ALERT_MARKER));
  // The canonical issue: the oldest open one, else the newest closed one that is not a merged duplicate.
  const all = await alerts();
  const issue = all.filter(each => each.state === 'open').sort((a, b) => a.number - b.number)[0]
    ?? all.find(each => each.state_reason !== 'duplicate');
  // An attempt is reported once, in whichever alert issue holds its marker.
  for (const alerted of all) {
    const comments = alerted.body.includes(attemptMarker) ? [] : await client.list(`/issues/${numeric(alerted.number)}/comments`);
    if (alerted.body.includes(attemptMarker) || comments.some(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(attemptMarker))) {
      return { ...(dryRun && { dryRun: true }), issue: alerted.number, duplicate: true };
    }
  }
  if (dryRun) return issue ? { dryRun: true, comment: issue.number, report } : { dryRun: true, create: true, report };
  if (!issue) {
    const created = await client.request('/issues', { method: 'POST', body: {
      title: 'Apple notarization is failing', body: `${ALERT_MARKER}\n${report}`, assignees: [owner],
    } });
    // Failures that finish together each find no issue; the oldest open one keeps the reports.
    const older = (await alerts()).filter(other => other.state === 'open' && other.number < created.number).sort((a, b) => a.number - b.number)[0];
    if (!older) return { issue: created.number, created: true };
    await client.request(`/issues/${numeric(older.number)}/comments`, { method: 'POST', body: { body: report } });
    await client.request(`/issues/${numeric(created.number)}/comments`, { method: 'POST', body: { body: `Duplicate of #${numeric(older.number)}, which has this report.` } });
    await client.request(`/issues/${numeric(created.number)}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'duplicate' } });
    return { issue: older.number, updated: true };
  }
  const number = numeric(issue.number);
  if (issue.state === 'closed') await client.request(`/issues/${number}`, { method: 'PATCH', body: { state: 'open' } });
  await client.request(`/issues/${number}/assignees`, { method: 'POST', body: { assignees: [owner] } });
  await client.request(`/issues/${number}/comments`, { method: 'POST', body: { body: report } });
  return { issue: issue.number, updated: true };
}
