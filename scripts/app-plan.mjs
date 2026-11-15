#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFile, readFile } from 'node:fs/promises';
import { createAppPlan, changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { FULL_CI_LABEL } from './lib/ci-usage.mjs';
import { eventPullRequest, fullPlanBudget } from './lib/full-plan-budget.mjs';
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
// `--base merge-base` (a dispatched run): diff a branch from where it left
// main; a commit already on main diffs from the tested base like a push.
if (base === 'merge-base') {
  const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    const mergeBase = git('merge-base', 'origin/main', head);
    base = mergeBase === git('rev-parse', `${head}^{commit}`) ? TESTED_BASE : mergeBase;
    if (base !== TESTED_BASE) console.error(`App planner: base ${base} is where ${head} left main`);
  } catch {
    base = '';
    baseFallback = `${head} has no merge base with origin/main`;
  }
}
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
// `--release` (release.yml): the apps to publish are the ones the version
// bumps reach, so release bookkeeping counts.
const release = process.argv.includes('--release');
let plan = createAppPlan(registry, fallbackReason ? [] : changedPaths, graph, manifests, { draft, release });

// A ready pull request that has used its full-plan runs gets the draft plan,
// and the `full-plan-withheld` job fails so the run is never green. A run that
// does test the complete plan, where the draft plan would test less, starts
// the `full-plan` job, which is what the budget counts.
let withheld = '';
let fullPlan = false;
if (process.env.GITHUB_EVENT_NAME === 'pull_request' && !draft && process.env.GITHUB_EVENT_PATH) {
  const draftPlan = createAppPlan(registry, fallbackReason ? [] : changedPaths, graph, manifests, { draft: true });
  if (draftPlan.selected.length < plan.selected.length) {
    fullPlan = true;
    try {
      const event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8'));
      const decision = await fullPlanBudget({ pullRequest: eventPullRequest(event), runId: Number(process.env.GITHUB_RUN_ID) });
      console.error(`App planner budget: ${decision.reason}`);
      if (decision.withheld) {
        withheld = decision.reason;
        plan = draftPlan;
        fullPlan = false;
      }
    } catch (error) {
      // The budget saves runner time; it never withholds coverage it cannot justify.
      console.error(`App planner budget: keeping the full plan because the budget check failed: ${error.message}`);
    }
  }
}

// A dispatched run's scope: `gpu` runs only the macOS GPU suite of the
// selected apps, `site` only the composite site (and agentic checks).
const scope = option('--scope') || 'affected';
if (!['affected', 'all', 'gpu', 'site'].includes(scope)) throw new Error(`Unknown scope ${scope}`);
const none = { include: [] };
const scoped = {
  apps: ['gpu', 'site'].includes(scope) ? none : plan.apps,
  browserApps: ['gpu', 'site'].includes(scope) ? none : plan.browserApps,
  gpuApps: scope === 'site' ? none : plan.gpuApps,
  releaseApps: ['gpu', 'site'].includes(scope) ? none : plan.releaseApps,
  site: scope === 'site' || (scope !== 'gpu' && plan.site && !withheld),
};
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
  apps: JSON.stringify(scoped.apps.include.length ? scoped.apps : emptyMatrix),
  browser_apps: JSON.stringify(scoped.browserApps.include.length ? scoped.browserApps : emptyMatrix),
  gpu_apps: JSON.stringify(scoped.gpuApps.include.length ? scoped.gpuApps : emptyMatrix),
  release_apps: JSON.stringify(scoped.releaseApps.include.length ? scoped.releaseApps : emptyMatrix),
  selected_ids: JSON.stringify(plan.selected.map((app) => app.id)),
  has_apps: String(scoped.apps.include.length > 0),
  has_browser_apps: String(scoped.browserApps.include.length > 0),
  has_gpu_apps: String(scoped.gpuApps.include.length > 0),
  has_release_apps: String(scoped.releaseApps.include.length > 0),
  all_apps: String(plan.allApps),
  has_site: String(scoped.site),
  withheld: String(Boolean(withheld)),
  full_plan: String(fullPlan),
  fallback_reason: fallback,
  selection_reasons: JSON.stringify(reasons),
};

// The same reasons for a person: the job summary on GitHub, stderr locally.
const summary = fallback && !draft
  ? [`Full catalog and site selected: ${fallback}`]
  : [
    `Selected ${plan.selected.length} of ${registry.apps.length} apps; site build ${draft || withheld ? 'deferred until ready' : scoped.site ? 'runs' : 'skipped'}.`,
    ...Object.entries(reasons.apps).map(([app, list]) => `- ${app}: ${list.join('; ')}`),
    ...reasons.site.map((reason) => `- site: ${reason}`),
  ];
if (plan.bookkeeping.length) summary.push(`Release bookkeeping set aside (changelogs and version bumps, checked by workspace-contracts): ${plan.bookkeeping.length} ${plan.bookkeeping.length === 1 ? 'file' : 'files'}.`);
if (scope === 'gpu') summary.unshift('Scope gpu: only the macOS GPU suite of the selected apps runs.');
if (scope === 'site') summary.unshift('Scope site: only the composite site and its agentic checks run.');
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
