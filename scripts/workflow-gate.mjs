#!/usr/bin/env node
// Decides whether a path-filtered workflow has to run for a pull request, or
// for the nightly sweep of main (scripts/lib/workflow-gate.mjs). Writes
// `run=true|false` to GITHUB_OUTPUT and the reason to the job summary. Any
// failure to decide runs the workflow.
//
//   node scripts/workflow-gate.mjs --workflow elastix-native --base <sha> --head <sha>
//   node scripts/workflow-gate.mjs --workflow elastix-native --sweep --head <sha>
//
// --sweep needs GITHUB_REPOSITORY and a GITHUB_TOKEN that can read Actions runs.
import { appendFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { resolveTestedBase } from './lib/tested-base.mjs';
import { calledWorkflows, decideWorkflow, sweepWorkflow } from './lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from './lib/workspace-graph.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const name = option('--workflow');
if (!name || !/^[\w-]+$/.test(name)) throw new Error('Usage: workflow-gate.mjs --workflow <name> (--base <sha> | --sweep) --head <sha>');
const head = option('--head') || 'HEAD';

// The sweep reads what main gained since this workflow last finished green on
// it, by a merge or an earlier sweep. A sweep that failed or that GitHub
// dropped leaves that commit where it was, so the next one still sees the
// change. A dispatch does not count: its inputs can run part of the workflow.
async function sweep(flow) {
  const tested = await resolveTestedBase({ head, workflow: `${name}.yml`, cwd: repoRoot, atHead: true, events: new Set(['push', 'schedule']) });
  if (!tested.base) return { run: true, reason: tested.reason };
  return sweepWorkflow({ flow, changedPaths: changedPathsFromGit({ base: tested.base, head, cwd: repoRoot }) });
}

async function decide(flow, read) {
  if (process.argv.includes('--sweep')) return sweep(flow);
  const base = option('--base');
  const calledFlows = await Promise.all(calledWorkflows(flow).map(read));
  const changedPaths = changedPathsFromGit({ base, head, cwd: repoRoot });
  const manifests = changedManifests({ base, head, cwd: repoRoot, changedPaths });
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(repoRoot);
  return decideWorkflow({ flow, calledFlows, changedPaths, registry, graph, manifests, root: repoRoot });
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
