#!/usr/bin/env node
import { appendFile, readFile } from 'node:fs/promises';
import { createAppPlan, changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { FULL_CI_LABEL, fullPlanDecision, largeRunCandidates } from './lib/ci-usage.mjs';
import { jobCount, listPullRequestRuns, mapLimited, pullRequestLabels } from './lib/github-actions.mjs';
import { resolveTestedBase, TESTED_BASE } from './lib/tested-base.mjs';
import { loadConservativeWorkspaceGraph, WorkspaceGraphConfigurationError } from './lib/workspace-graph.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const registry = await loadAppsRegistry();
const head = option('--head') || 'HEAD';
let base = option('--base');
// `--base last-success`: diff from the last commit ci finished green on the
// branch, so merges whose own push run was cancelled are still tested.
let baseFallback = '';
if (base === TESTED_BASE) {
  const tested = await resolveTestedBase({ head, branch: option('--branch') || 'main', cwd: repoRoot });
  console.error(`App planner: ${tested.reason}`);
  base = tested.base;
  if (!base) baseFallback = tested.reason;
}
let changedPaths = process.argv.includes('--all') || baseFallback
  ? []
  : changedPathsFromGit({ base, head, cwd: repoRoot });
const only = option('--only');
if (only && only !== 'affected') {
  const ids = new Set(only.split(',').map((id) => id.trim()).filter(Boolean));
  const unknown = [...ids].filter((id) => !registry.apps.some((app) => app.id === id));
  if (unknown.length) throw new Error(`Unknown app ids: ${unknown.join(', ')}`);
  changedPaths = [...ids].map((id) => `apps/${id}/package.json`);
}
const manifests = only && only !== 'affected'
  ? new Map()
  : changedManifests({ base, head, cwd: repoRoot, changedPaths });
let graph;
let fallbackReason = baseFallback;
try {
  graph = await loadConservativeWorkspaceGraph(repoRoot);
} catch (error) {
  if (!(error instanceof WorkspaceGraphConfigurationError)) throw error;
  fallbackReason = error.message;
  console.error(`App planner: selecting the full catalog and site because ${fallbackReason}`);
}
const draft = process.env.GITHUB_EVENT_NAME === 'pull_request' && process.env.CI_DRAFT === 'true';
let plan = createAppPlan(registry, fallbackReason ? [] : changedPaths, graph, manifests, { draft });

// A ready pull request that has used its whole-catalogue runs gets the draft
// plan, and the `full-plan-withheld` job fails so the run is never green.
async function budgetDecision(pullRequest) {
  const now = new Date().toISOString();
  const labels = await pullRequestLabels(pullRequest.number);
  if (labels.includes(FULL_CI_LABEL)) return fullPlanDecision({ runs: [], jobCounts: new Map(), pullRequest, labels, now });
  const runs = await listPullRequestRuns({ branch: pullRequest.branch, since: new Date(Date.parse(now) - 24 * 3600e3) });
  const candidates = largeRunCandidates(runs, now);
  const counts = await mapLimited(candidates, 6, (run) => jobCount(run.id));
  return fullPlanDecision({
    runs,
    jobCounts: new Map(candidates.map((run, index) => [run.id, counts[index]])),
    pullRequest,
    runId: Number(process.env.GITHUB_RUN_ID),
    labels,
    now,
  });
}

let withheld = '';
if (process.env.GITHUB_EVENT_NAME === 'pull_request' && !draft && plan.allApps && process.env.GITHUB_EVENT_PATH) {
  const draftPlan = createAppPlan(registry, fallbackReason ? [] : changedPaths, graph, manifests, { draft: true });
  if (draftPlan.selected.length < plan.selected.length) {
    try {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')).pull_request;
      const decision = await budgetDecision({ number: event.number, repository: event.head.repo?.full_name, branch: event.head.ref });
      console.error(`App planner budget: ${decision.reason}`);
      if (decision.withheld) {
        withheld = decision.reason;
        plan = draftPlan;
      }
    } catch (error) {
      // The budget saves runner time; it never withholds coverage it cannot justify.
      console.error(`App planner budget: keeping the full plan because the budget check failed: ${error.message}`);
    }
  }
}
const emptyMatrix = { include: [{ app: '__none__', path: '', runtime: '', rust_wasm: false, python_reference: false, shared_runtime: false, browser_test: false, hardware_gpu: false, app_scoped_runtime: false, release_test: 'test' }] };
const fallback = (fallbackReason || (plan.reasons.fallback ?? '')).replace(/\s+/g, ' ');
// A wide change gives every app the same long list; keep the outputs small.
const REASONS_SHOWN = 10;
const shorten = (reasons) => reasons.length > REASONS_SHOWN
  ? [...reasons.slice(0, REASONS_SHOWN), `and ${reasons.length - REASONS_SHOWN} more`]
  : reasons;
const reasons = {
  fallback: fallback || null,
  apps: Object.fromEntries(Object.entries(plan.reasons.apps)
    .filter(([app]) => plan.selected.some((entry) => entry.id === app))
    .map(([app, list]) => [app, shorten(list)])),
  site: shorten(plan.reasons.site),
};
const outputs = {
  apps: JSON.stringify(plan.apps.include.length ? plan.apps : emptyMatrix),
  browser_apps: JSON.stringify(plan.browserApps.include.length ? plan.browserApps : emptyMatrix),
  gpu_apps: JSON.stringify(plan.gpuApps.include.length ? plan.gpuApps : emptyMatrix),
  release_apps: JSON.stringify(plan.releaseApps.include.length ? plan.releaseApps : emptyMatrix),
  selected_ids: JSON.stringify(plan.selected.map((app) => app.id)),
  has_apps: String(plan.apps.include.length > 0),
  has_browser_apps: String(plan.browserApps.include.length > 0),
  has_gpu_apps: String(plan.gpuApps.include.length > 0),
  has_release_apps: String(plan.releaseApps.include.length > 0),
  all_apps: String(plan.allApps),
  has_site: String(plan.site && !withheld),
  withheld: String(Boolean(withheld)),
  fallback_reason: fallback,
  selection_reasons: JSON.stringify(reasons),
};

// The same reasons for a person: the job summary on GitHub, stderr locally.
const summary = fallback && !draft
  ? [`Full catalog and site selected: ${fallback}`]
  : [
    `Selected ${plan.selected.length} of ${registry.apps.length} apps; site build ${draft || withheld ? 'deferred until ready' : plan.site ? 'runs' : 'skipped'}.`,
    ...Object.entries(reasons.apps).map(([app, list]) => `- ${app}: ${list.join('; ')}`),
    ...reasons.site.map((reason) => `- site: ${reason}`),
  ];
if (draft) summary.unshift('Draft feedback only: shared dependency coverage runs on ready_for_review and every subsequent ready PR push.');
const withheldAdvice = `Full plan withheld: ${withheld}. This run tests only the apps the pull request edits. Convert the pull request to draft while iterating; to test every app at this head, add the ${FULL_CI_LABEL} label and use "Re-run all jobs" on this run.`;
if (withheld) {
  summary.unshift(withheldAdvice);
  if (process.env.GITHUB_ACTIONS) console.log(`::warning title=Full plan withheld::${withheldAdvice}`);
}
console.error(summary.join('\n'));
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `## App plan\n\n${summary.join('\n')}\n`);

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
  );
} else {
  console.log(JSON.stringify({ changedPaths, ...outputs }, null, 2));
}
