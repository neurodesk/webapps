const BAD_CONCLUSIONS = new Set(['failure', 'timed_out', 'action_required', 'startup_failure', 'stale']);
const LOG_LIMIT = 2 * 1024 * 1024;
const BODY_LIMIT = 60000;
// A dropped, reset or unresolvable connection and a gateway error say nothing
// about the repository, so a read retries them. Writes and other errors do not.
const TRANSIENT_CODES = new Set(['UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND']);
const TRANSIENT_STATUSES = new Set([502, 503, 504]);
const READ_RETRY_DELAYS = [1000, 4000];

const time = value => Date.parse(value);

function numeric(value) {
  if (!/^\d+$/.test(String(value))) throw new Error('Expected a numeric GitHub identifier');
  return String(value);
}

export function sanitize(value, limit = 1000) {
  return String(value ?? '')
    .split('\u001b').map((part, index) => index ? part.replace(/^\[[0-?]*[ -/]*[@-~]/, '') : part).join('')
    .replace(/\p{Cc}|[\u202a-\u202e\u2066-\u2069]/gu, character => ['\t', '\n', '\r'].includes(character) ? character : '')
    .replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})/g, '[redacted]')
    .replace(/\b(?:hf_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{10,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g, '[redacted]')
    .replace(/\b(Bearer|Basic)\s+[^\s]+/gi, '$1 [redacted]')
    .replace(/\b(token|password|secret|api[_-]?key)(\s*[:=]\s*)[^\s]+/gi, '$1$2[redacted]')
    .replace(/https?:\/\/[^\s<>]+/g, (value) => {
      try {
        const url = new URL(value);
        url.username = '';
        url.password = '';
        if (url.search) url.search = '?redacted';
        return url.href;
      } catch { return '[invalid URL]'; }
    })
    .slice(0, limit)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/@/g, '@\u200b');
}

function plain(value, limit = 250) {
  return sanitize(value, limit).replace(/[\r\n]/g, ' ').replace(/[\\`*_{}[\]()!|#]/g, '\\$&');
}

function transientFailure(error) {
  if (TRANSIENT_STATUSES.has(error.status)) return `HTTP ${error.status}`;
  const code = error.cause?.code ?? error.code;
  return TRANSIENT_CODES.has(code) ? code : undefined;
}

export function createGitHubClient({ token, repository, fetchImpl = fetch, sleep = delay => new Promise(resolve => setTimeout(resolve, delay)) }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error('Invalid repository');
  const base = `https://api.github.com/repos/${repository}`;
  async function request(path, options = {}) {
    if (path !== '' && (!path.startsWith('/') || path.startsWith('//'))) throw new Error('Expected a repository API path');
    for (let retry = 0; ; retry++) {
      try {
        return await send(path, options);
      } catch (error) {
        const failure = transientFailure(error);
        if ((options.method ?? 'GET') !== 'GET' || !failure || retry >= READ_RETRY_DELAYS.length) throw error;
        const delay = READ_RETRY_DELAYS[retry];
        console.warn(`GitHub API GET ${path.split('?')[0]} failed (${failure}); retry ${retry + 1} of ${READ_RETRY_DELAYS.length} in ${delay / 1000} s`);
        await sleep(delay);
      }
    }
  }
  async function send(path, { method = 'GET', body, logs = false, logLimit = LOG_LIMIT }) {
    let response = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(30000),
    });
    if (logs && response.status === 302) {
      const location = new URL(response.headers.get('location'));
      if (location.protocol !== 'https:' || location.username || location.password || location.port ||
        !(location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.actions.githubusercontent.com'))) {
        throw new Error('Rejected unexpected log download host');
      }
      // The timeout also covers reading the body: allow a large log a second per MiB beyond the first 30 s.
      response = await fetchImpl(location.href, { redirect: 'error', signal: AbortSignal.timeout(30000 + logLimit / 1024) });
    }
    if (!response.ok) throw Object.assign(new Error(`GitHub API ${method} ${path.split('?')[0]} returned ${response.status}`), { status: response.status });
    if (!logs) return response.status === 204 ? null : response.json();
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let size = 0;
    let truncated = false;
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        const remaining = logLimit - size;
        text += decoder.decode(chunk.value.subarray(0, remaining), { stream: true });
        size += chunk.value.length;
        if (size >= logLimit) {
          truncated = true;
          await reader.cancel();
          break;
        }
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    return { text, truncated };
  }
  // Job listings use pages of 30: pages of 100 jobs fail with a steady HTTP 502 for some large runs.
  async function list(path, key) {
    const size = key === 'jobs' ? 30 : 100;
    const result = [];
    for (let page = 1; ; page++) {
      const data = await request(`${path}${path.includes('?') ? '&' : '?'}per_page=${size}&page=${page}`);
      const entries = key ? data[key] : data;
      if (!Array.isArray(entries)) throw new Error('Unexpected paginated GitHub response');
      result.push(...entries);
      if (entries.length < size) return result;
    }
  }
  return { request, list };
}

export function logExcerpt({ text, truncated }) {
  const lines = text.split('\n');
  const annotation = /(?:##\[error\]|::error(?:\s[^\r\n]*?)?::)/i;
  const generic = /(?:Process completed with exit code \d+\.?|(?:The )?operation was cancel(?:led|ed)\.?|(?:The )?job was cancel(?:led|ed)\.?)\s*$/i;
  const annotationIndex = lines.findLastIndex(line => annotation.test(line) && !generic.test(line));
  const diagnosticIndex = lines.findLastIndex(line => !generic.test(line) && /(?:\berror:|\bexception\b|\btime(?:d)?[ -]?out\b)/i.test(line));
  const failureIndex = lines.findLastIndex(line => !generic.test(line) && /\bfailed\b/i.test(line));
  const usefulIndex = diagnosticIndex >= 0 ? diagnosticIndex : failureIndex;
  const errorIndex = annotationIndex >= 0 ? annotationIndex : usefulIndex;
  const start = errorIndex < 0 ? 0 : Math.max(0, errorIndex - 8);
  const end = errorIndex < 0 ? 0 : Math.min(lines.length, errorIndex + 12);
  const tailStart = Math.max(0, lines.length - 22);
  const selected = lines.slice(errorIndex >= 0 && tailStart <= end ? Math.min(start, tailStart) : start, end);
  const tail = lines.slice(Math.max(tailStart, end));
  const excerpt = sanitize([
    ...selected,
    ...(selected.length && tailStart > end ? ['... last available log lines ...'] : []),
    ...tail,
  ].join('\n'), 4500);
  return excerpt + (truncated ? '\n[Log download stopped at 2 MiB; open the job for the complete log.]' : '');
}

// Each job's group, the part of its name before the first " / ": a workflow
// native.yml called (bison-native / portable / macos-arm64) or a reusable
// workflow's caller job. Listed in full before the per-job details, whose
// limits must never hide which suite failed.
function affectedGroups(jobs) {
  const counts = new Map();
  for (const job of jobs) {
    const group = String(job.name ?? '').split(' / ')[0];
    counts.set(group, (counts.get(group) ?? 0) + 1);
  }
  if (!jobs.some(job => String(job.name ?? '').includes(' / '))) return [];
  return [`- Affected: ${[...counts].map(([group, count]) => `${plain(group, 100)} (${count})`).join(', ')}.`];
}

export async function reportNightlyFailure({ run, repository, defaultBranch, client, dryRun = false }) {
  if (run.event !== 'schedule' || run.status !== 'completed') return { skipped: 'Not a completed scheduled workflow' };
  if (!defaultBranch || run.head_branch !== defaultBranch || run.head_repository?.full_name !== repository) return { skipped: 'Not a default-branch run from this repository' };
  const runId = numeric(run.id);
  const attempt = numeric(run.run_attempt ?? 1);
  const workflowId = numeric(run.workflow_id);
  const runPath = `/actions/runs/${runId}`;
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const jobs = await client.list(`${runPath}/attempts/${attempt}/jobs`, 'jobs');
  const failed = jobs.filter(job => BAD_CONCLUSIONS.has(job.conclusion));
  const cancelled = jobs.filter(job => job.conclusion === 'cancelled');
  const incomplete = run.conclusion === 'cancelled' || cancelled.length > 0;
  // A new push routinely supersedes a Pages deployment. Real failed jobs still get reported.
  if (!failed.length && run.conclusion === 'cancelled' && run.name === 'deploy-github-pages') return { skipped: 'Superseded deployment' };
  if (!failed.length && !incomplete && !BAD_CONCLUSIONS.has(run.conclusion)) return { skipped: 'No failures or incomplete coverage' };
  const workflowMarker = `<!-- nightly-workflow:${workflowId} -->`;
  const attemptMarker = `<!-- nightly-run:${runId}:attempt:${attempt} -->`;
  const issues = await client.list('/issues?state=all&creator=github-actions%5Bbot%5D&sort=created&direction=desc');
  const matching = issues.filter(issue => !issue.pull_request && issue.user?.login === 'github-actions[bot]' && issue.body?.startsWith(workflowMarker));
  const issue = matching.find(issue => issue.state === 'open') ?? matching[0];
  // An attempt is reported once, in whichever issue of the workflow holds its marker.
  for (const reported of matching) {
    // The report opened this issue: it is closed only because someone closed it after the report.
    if (reported.body?.includes(attemptMarker)) return { ...(dryRun && { dryRun: true }), duplicate: true, issue: reported.number };
    const comments = await client.list(`/issues/${numeric(reported.number)}/comments`);
    const comment = comments.find(comment => comment.user?.login === 'github-actions[bot]' && comment.body?.startsWith(attemptMarker));
    if (!comment) continue;
    // A report reopens a closed issue after commenting. Finish that if an earlier tick stopped in between,
    // but leave an issue closed after the report alone.
    const unfinished = reported === issue && reported.state === 'closed' && !(time(reported.closed_at) >= time(comment.created_at));
    if (unfinished && !dryRun) await client.request(`/issues/${numeric(reported.number)}`, { method: 'PATCH', body: { state: 'open' } });
    return { ...(dryRun && { dryRun: true }), duplicate: true, issue: reported.number, ...(unfinished && { reopened: true }) };
  }
  const hasFailure = failed.length > 0 || BAD_CONCLUSIONS.has(run.conclusion);
  const lines = [attemptMarker, `## Scheduled ${hasFailure ? 'failure' : 'incomplete coverage'}: ${plain(run.name)}`,
    '', `[Run ${runId}, attempt ${attempt}](${runUrl})`,
    `- Conclusion: ${plain(run.conclusion)}. Event: schedule.`,
    `- Commit: ${plain(run.head_sha)}. Branch: ${plain(run.head_branch)}.`,
    `- Started: ${plain(run.run_started_at ?? run.created_at)}. Updated: ${plain(run.updated_at)}.`,
    `- Jobs: ${failed.length} failed or timed out; ${cancelled.length} cancelled; ${jobs.filter(job => job.conclusion === 'skipped').length} skipped.`,
    ...affectedGroups([...failed, ...cancelled]),
    '', incomplete ? 'Coverage is incomplete. Cancellation does not establish that the cancelled checks passed.' : 'Investigate the failed jobs below.', ''];
  let omitted = 0;
  let detailed = 0;
  for (const job of [...failed, ...cancelled]) {
    if (detailed >= 20 || lines.join('\n').length > BODY_LIMIT - 12000) { omitted++; continue; }
    detailed++;
    const jobId = numeric(job.id);
    const jobUrl = `https://github.com/${repository}/actions/runs/${runId}/job/${jobId}`;
    const section = [`### ${plain(job.name)} (${plain(job.conclusion)})`, `[Job and full logs](${jobUrl})`];
    const steps = (job.steps ?? []).filter(step => BAD_CONCLUSIONS.has(step.conclusion) || step.conclusion === 'cancelled');
    for (const step of steps.slice(0, 25)) section.push(`- [Step ${numeric(step.number)}: ${plain(step.name)}](${jobUrl}#step:${numeric(step.number)}:1) (${plain(step.conclusion)})`);
    if (steps.length > 25) section.push(`- ${steps.length - 25} additional steps are listed in the job.`);
    const interruptedStep = job.conclusion === 'cancelled' && (job.steps ?? []).some(step => step.conclusion === 'cancelled' || step.status === 'in_progress');
    if (BAD_CONCLUSIONS.has(job.conclusion) || interruptedStep) {
      try {
        const logs = await client.request(`/actions/jobs/${jobId}/logs`, { logs: true });
        section.push('', '<pre>', logExcerpt(logs), '</pre>');
      } catch (error) {
        section.push('', `Log excerpt unavailable: ${plain(error.message)}. Use the job link.`);
      }
    }
    const block = section.join('\n');
    if (lines.join('\n').length + block.length > BODY_LIMIT - 7000) { omitted++; continue; }
    lines.push(block, '');
  }
  if (!failed.length && BAD_CONCLUSIONS.has(run.conclusion)) lines.push('GitHub returned no failed jobs. Inspect the run for startup or workflow-level errors.', '');
  if (omitted) lines.push(`${omitted} additional affected jobs omitted by the report limits; open the run for all jobs.`, '');
  try {
    const artifacts = await client.list(`${runPath}/artifacts`, 'artifacts');
    lines.push('### Artifacts', 'Artifacts may contain diagnostics. Download and inspect them manually; the reporter does not execute or open them.');
    let listed = 0;
    for (const artifact of artifacts.slice(0, 20)) {
      const link = `- [${plain(artifact.name)}](https://github.com/${repository}/actions/runs/${runId}/artifacts/${numeric(artifact.id)})${artifact.expired ? ' (expired)' : ''}`;
      if (lines.join('\n').length + link.length > BODY_LIMIT - 2200) break;
      lines.push(link);
      listed++;
    }
    if (!artifacts.length) lines.push('No artifacts uploaded.');
    if (artifacts.length > listed) lines.push(`${artifacts.length - listed} more artifacts are available on the run page.`);
  } catch (error) { lines.push(`Artifact listing unavailable: ${plain(error.message)}.`); }
  lines.push('', '### Reproduce and rerun', `Check out commit ${plain(run.head_sha)} and use the commands and environment from the failed workflow steps. Some scheduled checks require credentials, reference data, or hardware.`,
    `Open the [run](${runUrl}) and choose **Re-run failed jobs** after fixing the cause, or use:`, '', '```sh', `gh run rerun ${runId} --failed --repo ${repository}`, '```', '', 'Artifacts that jobs hand to later jobs expire after one day; after that, re-run all jobs instead. Reruns create a new attempt and a separate report. A manual workflow dispatch is not a scheduled run and is not reported here.', '', 'Log excerpts are bounded and redact common credentials. GitHub masking remains the primary secret protection.');
  const body = lines.join('\n');
  if (body.length > BODY_LIMIT) throw new Error('Failure report exceeded the issue body budget');
  const title = `Scheduled workflow: ${run.name} requires attention`;
  if (dryRun) return issue ? { dryRun: true, comment: issue.number, title, body } : { dryRun: true, create: true, title, body: `${workflowMarker}\n${body}` };
  if (issue) {
    await client.request(`/issues/${numeric(issue.number)}/comments`, { method: 'POST', body: { body } });
    if (issue.state === 'closed') await client.request(`/issues/${numeric(issue.number)}`, { method: 'PATCH', body: { state: 'open' } });
    return { issue: issue.number, updated: true };
  }
  const created = await client.request('/issues', { method: 'POST', body: {
    title, body: `${workflowMarker}\n${body}`,
  } });
  return { issue: created.number, created: true };
}

function reportedFailureInfo(body, fallback) {
  const header = body?.slice(0, 1000) ?? '';
  const marker = header.match(/<!-- nightly-run:(\d+):attempt:(\d+) -->/);
  const meta = header.match(/^- (?:Started: ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)\. )?Updated: ([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.+-]+Z?)\.$/m);
  const startedAt = meta?.[1] ? time(meta[1]) : Number.NaN;
  const updatedAt = meta?.[2] ? time(meta[2]) : time(fallback);
  return {
    runId: marker?.[1] ?? null,
    attempt: marker?.[2] ? Number(marker[2]) : null,
    startedAt,
    updatedAt,
  };
}

function runSupersedesReport({ runId, attempt, runCreatedAt, runCompletedAt }, report) {
  if (!Number.isNaN(report.updatedAt) && !(runCompletedAt > report.updatedAt)) return false;
  if (report.runId === runId) {
    return report.attempt === null || Number(attempt) > report.attempt;
  }
  if (report.runId !== null && BigInt(runId) < BigInt(report.runId)) return false;
  if (!Number.isNaN(report.startedAt) && !Number.isNaN(runCreatedAt) && runCreatedAt < report.startedAt) return false;
  return true;
}

export async function closeRecoveredNightlyIssue({ run, repository, defaultBranch, client, dryRun = false, openIssue = null }) {
  if (run.event !== 'schedule' || run.status !== 'completed' || run.conclusion !== 'success') {
    return { skipped: 'Not a passing completed scheduled workflow' };
  }
  if (!defaultBranch || run.head_branch !== defaultBranch || run.head_repository?.full_name !== repository) {
    return { skipped: 'Not a default-branch run from this repository' };
  }
  const runId = numeric(run.id);
  const attempt = numeric(run.run_attempt ?? 1);
  const workflowId = numeric(run.workflow_id);
  const workflowMarker = `<!-- nightly-workflow:${workflowId} -->`;
  const recoveryMarker = `<!-- nightly-recovery:${runId}:attempt:${attempt} -->`;
  let issue = openIssue;
  if (!issue) {
    const issues = await client.list('/issues?state=open&creator=github-actions%5Bbot%5D&sort=created&direction=desc');
    issue = issues.find(entry => entry.state === 'open' && !entry.pull_request && entry.user?.login === 'github-actions[bot]' && entry.body?.startsWith(workflowMarker));
  }
  if (!issue || issue.state !== 'open' || issue.pull_request || issue.user?.login !== 'github-actions[bot]' || !issue.body?.startsWith(workflowMarker)) {
    return { skipped: 'No open issue for workflow' };
  }
  const comments = await client.list(`/issues/${numeric(issue.number)}/comments`);
  const botComments = comments.filter(comment => comment.user?.login === 'github-actions[bot]');
  const existingRecovery = botComments.find(comment => comment.body?.startsWith(recoveryMarker));
  if (existingRecovery) {
    const events = await client.list(`/issues/${numeric(issue.number)}/events`);
    const recoveryAt = time(existingRecovery.created_at);
    const closedOrReopenedAfter = events.some(event => (event.event === 'closed' || event.event === 'reopened')
      && (Number.isNaN(recoveryAt) || time(event.created_at) >= recoveryAt));
    if (closedOrReopenedAfter) {
      return { ...(dryRun && { dryRun: true }), duplicate: true, issue: issue.number };
    }
  }
  const reports = [
    reportedFailureInfo(issue.body, issue.created_at),
    ...botComments
      .filter(comment => comment.body?.startsWith('<!-- nightly-run:'))
      .map(comment => reportedFailureInfo(comment.body, comment.created_at)),
  ];
  const candidate = { runId, attempt, runCreatedAt: time(run.created_at), runCompletedAt: time(run.updated_at) };
  if (!reports.every(report => runSupersedesReport(candidate, report))) {
    return { skipped: 'Passing run is not newer than the latest reported failure' };
  }
  if (existingRecovery) {
    if (dryRun) return { dryRun: true, issue: issue.number, closed: true };
    await client.request(`/issues/${numeric(issue.number)}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
    return { issue: issue.number, closed: true };
  }
  const runPath = `/actions/runs/${runId}`;
  const jobs = await client.list(`${runPath}/attempts/${attempt}/jobs`, 'jobs');
  const failed = jobs.filter(job => BAD_CONCLUSIONS.has(job.conclusion));
  const cancelled = jobs.filter(job => job.conclusion === 'cancelled');
  const succeeded = jobs.filter(job => job.conclusion === 'success');
  if (failed.length || cancelled.length) return { skipped: 'Run has failed or cancelled jobs' };
  if (!succeeded.length) return { skipped: 'Run had no passing jobs' };
  const runUrl = `https://github.com/${repository}/actions/runs/${runId}/attempts/${attempt}`;
  const body = [
    recoveryMarker,
    `## Scheduled workflow recovered: ${plain(run.name)}`,
    '',
    `[Run ${runId}, attempt ${attempt}](${runUrl}) passed cleanly on \`${plain(run.head_branch)}\` at commit \`${plain(run.head_sha)}\` (${succeeded.length} ${succeeded.length === 1 ? 'job' : 'jobs'} passed).`,
    `- Started: ${plain(run.run_started_at ?? run.created_at)}. Updated: ${plain(run.updated_at)}.`,
    '',
    'Closing this issue automatically. A future scheduled failure will reopen it.',
  ].join('\n');
  if (dryRun) return { dryRun: true, issue: issue.number, closed: true, body };
  await client.request(`/issues/${numeric(issue.number)}/comments`, { method: 'POST', body: { body } });
  await client.request(`/issues/${numeric(issue.number)}`, { method: 'PATCH', body: { state: 'closed', state_reason: 'completed' } });
  return { issue: issue.number, closed: true };
}

