import { FULL_CI_LABEL, fullPlanDecision, largeRunCandidates } from './ci-usage.mjs';
import { jobNames, listPullRequestRuns, mapLimited, pullRequestLabels } from './github-actions.mjs';

// The pull request a `pull_request` event names, as fullPlanDecision matches runs.
export function eventPullRequest(event) {
  const pullRequest = event.pull_request;
  return { number: pullRequest.number, repository: pullRequest.head.repo?.full_name, branch: pullRequest.head.ref, head: pullRequest.head.sha };
}

// Whether a ready pull request is over its full-plan budget, read live from
// the Actions API and its labels, so a re-run sees a label added since. The
// `ci` planner passes its own `runId`; a native workflow's gate passes
// `excludeHead`, leaving out every `ci` run of the commit it tests, so it
// withholds only where that commit's `ci` run withholds too.
export async function fullPlanBudget({ pullRequest, runId, excludeHead, now = new Date().toISOString() }) {
  const labels = await pullRequestLabels(pullRequest.number);
  if (labels.includes(FULL_CI_LABEL)) return fullPlanDecision({ runs: [], jobNames: new Map(), pullRequest, labels, now });
  const runs = await listPullRequestRuns({ branch: pullRequest.branch, since: new Date(Date.parse(now) - 24 * 3600e3) });
  const candidates = largeRunCandidates(runs, now).filter((run) => run.id !== runId && run.head_sha !== excludeHead);
  const names = await mapLimited(candidates, 6, (run) => jobNames(run.id));
  return fullPlanDecision({
    runs,
    jobNames: new Map(candidates.map((run, index) => [run.id, names[index]])),
    pullRequest,
    runId,
    excludeHead,
    labels,
    now,
  });
}
