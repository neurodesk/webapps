#!/usr/bin/env node
import { appendFile } from 'node:fs/promises';
import { createAppPlan, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const registry = await loadAppsRegistry();
let changedPaths = process.argv.includes('--all')
  ? []
  : changedPathsFromGit({ base: option('--base'), head: option('--head') || 'HEAD', cwd: repoRoot });
const only = option('--only');
if (only && only !== 'affected') {
  const ids = new Set(only.split(',').map((id) => id.trim()).filter(Boolean));
  const unknown = [...ids].filter((id) => !registry.apps.some((app) => app.id === id));
  if (unknown.length) throw new Error(`Unknown app ids: ${unknown.join(', ')}`);
  changedPaths = [...ids].map((id) => `apps/${id}/package.json`);
}
const plan = createAppPlan(registry, changedPaths);
const emptyMatrix = { include: [{ app: '__none__', path: '', runtime: '', rust_wasm: false, python_reference: false, shared_runtime: false }] };
const outputs = {
  apps: JSON.stringify(plan.apps.include.length ? plan.apps : emptyMatrix),
  shared_apps: JSON.stringify(plan.sharedApps.include.length ? plan.sharedApps : emptyMatrix),
  release_apps: JSON.stringify(plan.releaseApps.include.length ? plan.releaseApps : emptyMatrix),
  selected_ids: JSON.stringify(plan.selected.map((app) => app.id)),
  has_apps: String(plan.apps.include.length > 0),
  has_shared_apps: String(plan.sharedApps.include.length > 0),
  has_release_apps: String(plan.releaseApps.include.length > 0),
  all_apps: String(plan.allApps),
};

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    Object.entries(outputs).map(([key, value]) => `${key}=${value}\n`).join(''),
  );
} else {
  console.log(JSON.stringify({ changedPaths, ...outputs }, null, 2));
}
