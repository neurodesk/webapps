#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { createAppPlan, changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
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
const plan = createAppPlan(registry, fallbackReason ? [] : changedPaths, graph, manifests);
const emptyMatrix = { include: [{ app: '__none__', path: '', runtime: '', rust_wasm: false, python_reference: false, shared_runtime: false, browser_test: false, hardware_gpu: false, app_scoped_runtime: false, release_test: 'test' }] };
const fallback = (fallbackReason || (plan.reasons.fallback ?? '')).replace(/\s+/g, ' ');
// A wide change gives every app the same long list; keep the outputs small.
const REASONS_SHOWN = 10;
const shorten = (reasons) => reasons.length > REASONS_SHOWN
  ? [...reasons.slice(0, REASONS_SHOWN), `and ${reasons.length - REASONS_SHOWN} more`]
  : reasons;
const reasons = {
  fallback: fallback || null,
  apps: Object.fromEntries(Object.entries(plan.reasons.apps).map(([app, list]) => [app, shorten(list)])),
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
  has_site: String(plan.site),
  fallback_reason: fallback,
  selection_reasons: JSON.stringify(reasons),
};

// The same reasons for a person: the job summary on GitHub, stderr locally.
const summary = fallback
  ? [`Full catalog and site selected: ${fallback}`]
  : [
    `Selected ${plan.selected.length} of ${registry.apps.length} apps; site build ${plan.site ? 'runs' : 'skipped'}.`,
    ...Object.entries(reasons.apps).map(([app, list]) => `- ${app}: ${list.join('; ')}`),
    ...reasons.site.map((reason) => `- site: ${reason}`),
  ];
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
