#!/usr/bin/env node
// Decides whether a path-filtered workflow has to run for a pull request, or
// for the nightly sweep of main (scripts/lib/workflow-gate.mjs). Writes
// `run=true|false` to GITHUB_OUTPUT and the reason to the job summary. Any
// failure to decide runs the workflow.
//
//   node scripts/workflow-gate.mjs --workflow elastix-native --base <sha> --head <sha>
//   node scripts/workflow-gate.mjs --workflow elastix-native --push --head <sha>
//   node scripts/workflow-gate.mjs --workflow elastix-native --sweep --head <sha>
//
// --push and --sweep need GITHUB_REPOSITORY and a GITHUB_TOKEN that can read
// Actions runs. In a ready pull request's run (GITHUB_EVENT_NAME and
// GITHUB_EVENT_PATH), the token also reads the pull request's labels.
import { appendFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { eventPullRequest, fullPlanBudget } from './lib/full-plan-budget.mjs';
import { resolveTestedBase } from './lib/tested-base.mjs';
import { budgetedDecision, calledWorkflows, decideWorkflow, mainWorkflow } from './lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from './lib/workspace-graph.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const name = option('--workflow');
if (!name || !/^[\w-]+$/.test(name)) throw new Error('Usage: workflow-gate.mjs --workflow <name> (--base <sha> | --push | --sweep) --head <sha>');
const head = option('--head') || 'HEAD';

// A push and the sweep read what main gained since this workflow last
// finished green on it, by a push or a sweep (mainWorkflow). A run that failed,
// was cancelled or that GitHub dropped leaves that commit where it was, so the
// next one still sees the change. A dispatch does not count: its inputs can run
// part of the workflow.
async function main(flow, event) {
  const tested = await resolveTestedBase({ head, workflow: `${name}.yml`, cwd: repoRoot, atHead: event === 'schedule', events: new Set(['push', 'schedule']) });
  if (!tested.base) return { run: true, reason: tested.reason };
  const changedPaths = changedPathsFromGit({ base: tested.base, head, cwd: repoRoot });
  const manifests = changedManifests({ base: tested.base, head, cwd: repoRoot, changedPaths });
  return mainWorkflow({ flow, changedPaths, manifests, registry: await loadAppsRegistry(), event });
}

async function decide(flow, read) {
  if (process.argv.includes('--sweep')) return main(flow, 'schedule');
  if (process.argv.includes('--push')) return main(flow, 'push');
  const base = option('--base');
  const calledFlows = await Promise.all(calledWorkflows(flow).map(read));
  const changedPaths = changedPathsFromGit({ base, head, cwd: repoRoot });
  const manifests = changedManifests({ base, head, cwd: repoRoot, changedPaths });
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(repoRoot);
  const decision = decideWorkflow({ flow, calledFlows, changedPaths, registry, graph, manifests, root: repoRoot });
  if (process.env.GITHUB_EVENT_NAME !== 'pull_request' || !process.env.GITHUB_EVENT_PATH) return decision;
  const budget = async () => {
    const pullRequest = eventPullRequest(JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH, 'utf8')));
    return fullPlanBudget({ pullRequest, excludeHead: pullRequest.head });
  };
  return budgetedDecision(decision, { registry, graph, changedPaths, manifests, budget, log: (message) => console.error(`${name}: ${message}`) });
}

let decision;
try {
  const read = async (file) => parse(await readFile(`${repoRoot}/.github/workflows/${file}.yml`, 'utf8'));
  decision = await decide(await read(name), read);
} catch (error) {
  decision = { run: true, reason: `the gate could not decide (${error.message})` };
  console.log(`::warning::${name}: ${decision.reason}`);
}

const line = `${name} ${decision.run ? 'runs' : 'is skipped'}: ${decision.reason}`;
console.error(line);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
else console.log(JSON.stringify(decision));
// A withheld suite fails, like ci's full-plan-withheld job, instead of reading as green.
if (decision.withheld) {
  console.log(`::error title=Full plan withheld::${name}: ${decision.reason}`);
  process.exitCode = 1;
}
