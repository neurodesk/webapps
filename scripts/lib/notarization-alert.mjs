import { sanitize } from './nightly-failures.mjs';

// Workflows that sign and notarize macOS packages with the Apple Developer account. node-cli-portable.yml is
// reusable: its jobs run inside these callers. test/notarization-alert.test.mjs keeps the list complete.
export const NOTARIZING_WORKFLOWS = [
  'ants-native',
  'bison-native',
  'brain-extraction-native',
  'brain2print-native',
  'browserqc-native',
  'calmar-native',
  'carotid-flow-native',
  'deface-native',
  'degibbs-native',
  'dicompare-native',
  'disconnectome-native',
  'dwi2trx-native',
  'dwidenoise-native',
  'easy-mp2rage-native',
  'edgereg-native',
  'elastix-native',
  'fireants-native',
  'greedy-native',
  'hmc-native',
  'lcmodel-native',
  'mri2vid-native',
  'musclemap-native',
  'n4-native',
  'niimath-native',
  'noddi-native',
  'node-cli',
  'qsmbly-native',
  'samsrf-native',
  'sdc-native',
  'seedseg-native',
  'spinalcordtoolbox-native',
  'standalone',
  'syncro-native',
  'synthseg-native',
  'synthseg-portable',
  'synthsr-native',
  'topofit-native',
  'vesselboost-native',
  'white-matter-lesions-native',
];

// Who is assigned, and so notified, when Apple refuses a notarization.
export const NOTARIZATION_OWNER = 'stebo85';
export const ALERT_MARKER = '<!-- apple-notarization-alert -->';

// What notarytool and @electron/notarize print when Apple refuses: an expired agreement or bad credentials
// (HTTP 401/403 from the notary service) or a rejected submission.
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

export async function alertNotarization({ run, repository, client, owner = NOTARIZATION_OWNER }) {
  if (run.status !== 'completed' || run.conclusion !== 'failure') return { skipped: 'Run did not fail' };
  if (run.event === 'pull_request' || !NOTARIZING_WORKFLOWS.includes(run.name)) return { skipped: 'Run does not notarize' };
  const runId = numeric(run.id);
  const attempt = numeric(run.run_attempt ?? 1);
  const jobs = await client.list(`/actions/runs/${runId}/attempts/${attempt}/jobs`, 'jobs');
  const candidates = jobs.filter(job => job.conclusion === 'failure' && (job.labels ?? []).some(label => /macos/i.test(label)));
  const failures = [];
  for (const job of candidates) {
    const logs = await client.request(`/actions/jobs/${numeric(job.id)}/logs`, { logs: true });
    const detail = notaryFailure(logs.text);
    if (detail) failures.push({ job, detail });
  }
  if (!failures.length) return { skipped: 'No notarization failure in the failed macOS jobs' };
  const attemptMarker = `<!-- notarization-run:${runId}:attempt:${attempt} -->`;
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const report = [attemptMarker,
    `Apple refused a notarization in [${text(run.name, 100)} run ${runId}, attempt ${attempt}](${runUrl}) (${text(run.event, 40)} on ${text(run.head_branch, 100)}).`, '',
    ...failures.map(({ job, detail }) => `- [${text(job.name, 200)}](https://github.com/${repository}/actions/runs/${runId}/job/${numeric(job.id)}): ${text(detail)}`), '',
    'An expired agreement (HTTP 403) is renewed by the Account Holder at https://developer.apple.com/account; check the Apple ID and app-specific password secrets for HTTP 401.',
    `After fixing it, rerun the failed jobs: \`gh run rerun ${runId} --failed --repo ${repository}\`. Release dispatches publish when their release job passes.`,
  ].join('\n');
  const issues = await client.list('/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc');
  const issue = issues.find(issue => !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.startsWith(ALERT_MARKER));
  if (!issue) {
    const created = await client.request('/issues', { method: 'POST', body: {
      title: 'Apple notarization is failing', body: `${ALERT_MARKER}\n${report}`, assignees: [owner],
    } });
    return { issue: created.number, created: true };
  }
  const number = numeric(issue.number);
  const comments = issue.body.includes(attemptMarker) ? [] : await client.list(`/issues/${number}/comments`);
  if (issue.body.includes(attemptMarker) || comments.some(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(attemptMarker))) {
    return { issue: issue.number, duplicate: true };
  }
  if (issue.state === 'closed') await client.request(`/issues/${number}`, { method: 'PATCH', body: { state: 'open', assignees: [owner] } });
  await client.request(`/issues/${number}/comments`, { method: 'POST', body: { body: report } });
  return { issue: issue.number, updated: true };
}
