#!/usr/bin/env node
// Decides whether a path-filtered workflow has to run for a pull request, a
// push to main or its nightly sweep (scripts/lib/workflow-gate.mjs). Writes
// `run=true|false` to GITHUB_OUTPUT and the reason to the job summary. Any
// failure to decide runs the workflow.
//
//   node scripts/workflow-gate.mjs --workflow elastix-native --base <sha> --head <sha>
//   node scripts/workflow-gate.mjs --workflow elastix-native --push --head <sha>
//   node scripts/workflow-gate.mjs --workflow neuroflow --sweep --head <sha>
//
// With --native it decides at once for every workflow native.yml calls
// (scripts/lib/native-decision.mjs) and writes the JSON list of the ones that
// run to NATIVE_SELECTION, which pr-gate.yml checks before it passes it on
// (without it, `workflows=<list>` goes to GITHUB_OUTPUT): for a pull request
// those it may call, for the sweep those it sweeps. When it cannot decide for a
// workflow, the workflow runs, and native.yml runs every workflow when the gate
// fails. A ready pull request over its full-plan budget writes `withheld=true`
// first and exits 1. NATIVE_ELIGIBLE (space-separated names) limits the
// decision to those workflows, for local replays and tests.
//
//   node scripts/workflow-gate.mjs --native --base <sha> --head <sha>
//   node scripts/workflow-gate.mjs --native --sweep --head <sha>
//
// --push and --sweep need GITHUB_REPOSITORY and a GITHUB_TOKEN that can read
// Actions runs. In a ready pull request's run (GITHUB_EVENT_NAME and
// GITHUB_EVENT_PATH), the token also reads the pull request's labels.
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir, writeFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { changedManifests } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { eventPullRequest, fullPlanBudget } from './lib/full-plan-budget.mjs';
import { publishNative, pullRequestSelection, sweepSelection } from './lib/native-decision.mjs';
import { createGitHubClient } from './lib/nightly-failures.mjs';
import { gitAncestry, testedBase } from './lib/tested-base.mjs';
import { DISPATCHER, budgetedDecision, calledWorkflows, decideWorkflow, dispatchDecision, dispatched, dispatchedRuns, mainWorkflow, readChangedPaths, swept } from './lib/workflow-gate.mjs';
import { loadConservativeWorkspaceGraph } from './lib/workspace-graph.mjs';

function option(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const native = process.argv.includes('--native');
const name = native ? DISPATCHER : option('--workflow');
if (!name || !/^[\w-]+$/.test(name)) throw new Error('Usage: workflow-gate.mjs (--workflow <name> | --native) (--base <sha> | --push | --sweep) --head <sha>');
const head = option('--head') || 'HEAD';
const event = process.argv.includes('--sweep') ? 'schedule' : process.argv.includes('--push') ? 'push' : 'pull_request';
const env = process.env;
const workflowsDirectory = `${repoRoot}/.github/workflows`;
const read = async (file) => parse(await readFile(`${workflowsDirectory}/${file}.yml`, 'utf8'));

// The pr-gate job times out after 10 minutes, and setting it up takes about
// two: the decision ends well before, and every workflow it has not decided
// for by then runs.
const deadline = Date.now() + Number(env.NATIVE_DECISION_SECONDS ?? 300) * 1000;
// Every API read stops at the deadline. Job listings come in pages of 30
// (createGitHubClient), and a read that fails leaves its base unknown.
let client;
const github = () => {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to read workflow runs');
  client ??= createGitHubClient({
    token: env.GITHUB_TOKEN,
    repository: env.GITHUB_REPOSITORY,
    fetchImpl: (url, init = {}) => fetch(url, { ...init, signal: AbortSignal.any([init.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))].filter(Boolean)) }),
  });
  return client;
};

// native.yml's newest finished scheduled runs on main (only the newest few
// that did not finish green have their jobs read: an older one is left out,
// which can only move a base back and run more), with what each needs to be
// read as a run of one workflow it called (dispatchedRuns).
const JOB_READS = 10;
let history;
function dispatcherHistory() {
  history ??= (async () => {
    const { workflow_runs: listed } = await github().request(`/actions/workflows/${DISPATCHER}.yml/runs?branch=main&event=schedule&status=completed&per_page=100`);
    const runs = listed.filter((run) => run.event === 'schedule');
    const jobs = new Map();
    for (const run of runs.filter((each) => each.conclusion !== 'success').slice(0, JOB_READS)) {
      jobs.set(run.id, await github().list(`/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs`, 'jobs'));
    }
    const called = new Map();
    const calls = (workflow) => (run) => {
      if (!called.has(run.head_sha)) {
        try {
          called.set(run.head_sha, Object.keys(parse(execFileSync('git', ['show', `${run.head_sha}:.github/workflows/${DISPATCHER}.yml`], { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })).jobs ?? {}));
        } catch {
          called.set(run.head_sha, []);
        }
      }
      return called.get(run.head_sha).includes(workflow);
    };
    return { runs, calls, jobs: (run) => jobs.get(run.id) ?? null };
  })();
  return history;
}

// The commit a workflow last finished green at on main, by a push or a
// sweep: its own runs, and native.yml's scheduled runs for a workflow
// native.yml sweeps. A run that failed, was cancelled or that GitHub dropped
// leaves that commit where it was, so the next one still sees the change. A
// dispatch does not count: its inputs can run part of the workflow. A read
// that fails throws, and the workflow runs.
async function testedOnMain(file, flow) {
  const git = gitAncestry(repoRoot);
  const sha = git.resolve(head);
  if (!sha) return { base: null, reason: `${head} is not a commit in this checkout` };
  const { workflow_runs: green } = await github().request(`/actions/workflows/${file}.yml/runs?branch=main&status=success&per_page=100`);
  let runs = green;
  if (swept(flow)) {
    const { runs: sweeps, calls, jobs } = await dispatcherHistory();
    runs = [...runs, ...dispatchedRuns(file, sweeps, { calls: calls(file), jobs })];
  }
  return testedBase({ runs, head: sha, branch: 'main', git, workflow: file, atHead: event === 'schedule', events: new Set(['push', 'schedule']) });
}

function range(base) {
  const diff = readChangedPaths({ base, head, cwd: repoRoot });
  return diff.ok ? { ...diff, manifests: changedManifests({ base, head, cwd: repoRoot, changedPaths: diff.paths }) } : diff;
}

async function onMain(file, flow, registry) {
  const tested = await testedOnMain(file, flow);
  if (!tested.base) return { run: true, reason: tested.reason };
  const changed = range(tested.base);
  if (!changed.ok) return { run: true, reason: `the changed paths are unknown (${changed.reason})` };
  return mainWorkflow({ flow, changedPaths: changed.paths, manifests: changed.manifests, registry, event });
}

// A ready pull request over its full-plan budget withholds what would run.
function budget(context) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH) return { withheld: false };
  const check = async () => {
    const pullRequest = eventPullRequest(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
    return fullPlanBudget({ pullRequest, excludeHead: pullRequest.head });
  };
  return budgetedDecision({ run: true, reason: 'it runs' }, { ...context, budget: check, log: (message) => console.error(`${name}: ${message}`) });
}

async function pullRequestContext(diff) {
  const base = option('--base');
  const manifests = changedManifests({ base, head, cwd: repoRoot, changedPaths: diff.paths });
  return { changedPaths: diff.paths, manifests, registry: await loadAppsRegistry(), graph: await loadConservativeWorkspaceGraph(repoRoot), root: repoRoot };
}

async function decideOne() {
  const flow = await read(name);
  if (event !== 'pull_request') return onMain(name, flow, await loadAppsRegistry());
  const diff = readChangedPaths({ base: option('--base'), head, cwd: repoRoot });
  if (!diff.ok) return { run: true, reason: `the changed paths are unknown (${diff.reason})` };
  const context = await pullRequestContext(diff);
  const calledFlows = await Promise.all(calledWorkflows(flow).map(read));
  const decision = decideWorkflow({ flow, calledFlows, ...context });
  if (!decision.run) return decision;
  const verdict = await budget(context);
  return verdict.withheld ? { run: false, withheld: true, reason: verdict.reason } : decision;
}

// The workflows native.yml may call for this event.
async function eligibleWorkflows() {
  const listed = env.NATIVE_ELIGIBLE?.split(/\s+/).filter(Boolean);
  if (listed?.length) return listed;
  const files = (await readdir(workflowsDirectory)).filter((file) => file.endsWith('.yml')).map((file) => file.slice(0, -'.yml'.length)).sort();
  const flows = await Promise.all(files.map(async (file) => [file, await read(file)]));
  return flows.filter(([, flow]) => (event === 'schedule' ? swept(flow) : dispatched(flow))).map(([file]) => file);
}

function decideNative(eligible) {
  if (event === 'schedule') {
    return sweepSelection({ eligible, readRegistry: loadAppsRegistry, readFlow: read, readBase: testedOnMain, readRange: range, deadline });
  }
  return pullRequestSelection({
    eligible,
    readDiff: () => readChangedPaths({ base: option('--base'), head, cwd: repoRoot }),
    readFlow: read,
    readContext: pullRequestContext,
    decide: async ({ flow, diff, ...context }) => dispatchDecision({ flow, calledFlows: await Promise.all(calledWorkflows(flow).map(read)), ...context, changedPaths: diff.paths, renamed: diff.renamed }),
    budget,
    deadline,
  });
}

// Optional: a summary that cannot be written never changes a verdict or an exit code.
async function report(lines) {
  for (const line of lines) console.error(line);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function output(text) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${text}\n`);
  else console.log(text);
}

if (native) {
  const eligible = await eligibleWorkflows();
  let result;
  try {
    result = await decideNative(eligible);
  } catch (error) {
    result = { decisions: new Map(eligible.map((file) => [file, { run: true, reason: `the gate could not decide (${error.message})` }])) };
  }
  process.exitCode = await publishNative({
    eligible,
    result,
    writeOutput: output,
    // pr-gate.yml checks the selection before it passes it on.
    writeSelection: (json) => (env.NATIVE_SELECTION ? writeFile(env.NATIVE_SELECTION, `${json}\n`) : output(`workflows=${json}`)),
    writeSummary: report,
  });
  // Reads the decision gave up on (a budget read past the deadline) must not hold the step open.
  process.exit();
} else {
  let decision;
  try {
    decision = await decideOne();
  } catch (error) {
    decision = { run: true, reason: `the gate could not decide (${error.message})` };
    console.log(`::warning::${name}: ${decision.reason}`);
  }
  await output(`run=${decision.run}`);
  // A withheld suite fails, like ci's full-plan-withheld job, instead of reading as green.
  if (decision.withheld) {
    process.exitCode = 1;
    console.log(`::error title=Full plan withheld::${name}: ${decision.reason}`);
  }
  try {
    await report([`${name} ${decision.run ? 'runs' : 'is skipped'}: ${decision.reason}`]);
  } catch (error) {
    console.error(`${name}: the summary could not be written (${error.message})`);
  }
}
