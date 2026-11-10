#!/usr/bin/env node
// Decides whether a path-filtered workflow has to run for a pull request
// (scripts/lib/workflow-gate.mjs). Writes `run=true|false` to GITHUB_OUTPUT
// and the reason to the job summary. Any failure to decide runs the workflow.
//
//   node scripts/workflow-gate.mjs --workflow elastix-native --base <sha> --head <sha>
import { appendFile, readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { decideWorkflow } from './lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from './lib/workspace-graph.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const name = option('--workflow');
if (!name || !/^[\w-]+$/.test(name)) throw new Error('Usage: workflow-gate.mjs --workflow <name> --base <sha> --head <sha>');
const base = option('--base');
const head = option('--head') || 'HEAD';

let decision;
try {
  const flow = parse(await readFile(`${repoRoot}/.github/workflows/${name}.yml`, 'utf8'));
  const changedPaths = changedPathsFromGit({ base, head, cwd: repoRoot });
  const manifests = changedManifests({ base, head, cwd: repoRoot, changedPaths });
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(repoRoot);
  decision = decideWorkflow({ flow, changedPaths, registry, graph, manifests, root: repoRoot });
} catch (error) {
  decision = { run: true, reason: `the gate could not decide (${error.message})` };
  console.log(`::warning::${name}: ${decision.reason}`);
}

const line = `${name} ${decision.run ? 'runs' : 'is skipped'}: ${decision.reason}`;
console.error(line);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `run=${decision.run}\n`);
else console.log(JSON.stringify(decision));
