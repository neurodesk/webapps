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
// With --native it decides at once for every workflow native.yml calls, and
// writes `workflows=<JSON list>` of the ones that run: for a pull request,
// those whose shared paths it changed (and none of their own), and for the
// sweep, those a push to main also starts.
//
//   node scripts/workflow-gate.mjs --native --base <sha> --head <sha>
//   node scripts/workflow-gate.mjs --native --sweep --head <sha>
//
// --push and --sweep need GITHUB_REPOSITORY and a GITHUB_TOKEN that can read
// Actions runs. In a ready pull request's run (GITHUB_EVENT_NAME and
// GITHUB_EVENT_PATH), the token also reads the pull request's labels.
import { execFileSync } from 'node:child_process';
import { appendFile, readFile, readdir } from 'node:fs/promises';
import { parse } from 'yaml';
import { changedManifests, changedPathsFromGit } from './lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from './lib/apps-registry.mjs';
import { eventPullRequest, fullPlanBudget } from './lib/full-plan-budget.mjs';
import { gitAncestry, successfulRuns, testedBase } from './lib/tested-base.mjs';
import { DISPATCHER, budgetedDecision, calledWorkflows, decideWorkflow, dispatchDecision, dispatched, dispatchedRuns, mainWorkflow, swept } from './lib/workflow-gate.mjs';
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

async function api(path) {
  if (!env.GITHUB_REPOSITORY || !env.GITHUB_TOKEN) throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are needed to read workflow runs');
  const response = await fetch(`${env.GITHUB_API_URL ?? 'https://api.github.com'}/repos/${env.GITHUB_REPOSITORY}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`the Actions API answered ${response.status} for ${path}`);
  return response.json();
}

// The jobs of a run's listed attempt, read only for the newest few
// scheduled native.yml runs that did not finish green: an older one is left
// out, which can only move a base back and run more.
const JOB_READS = 10;
async function attemptJobs(run) {
  const jobs = [];
  for (let page = 1; page <= 5; page++) {
    const body = await api(`/actions/runs/${run.id}/attempts/${run.run_attempt ?? 1}/jobs?per_page=100&page=${page}`);
    jobs.push(...body.jobs.map(({ name: job, conclusion }) => ({ name: job, conclusion })));
    if (jobs.length >= body.total_count) return jobs;
  }
  return null;
}

// native.yml's finished scheduled runs on main, with what each needs to be
// read as a run of one workflow it called (dispatchedRuns).
let history;
function dispatcherHistory() {
  history ??= (async () => {
    const runs = (await successfulRuns({ repository: env.GITHUB_REPOSITORY, workflow: `${DISPATCHER}.yml`, branch: 'main', token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL, status: 'completed' }))
      .filter((run) => run.event === 'schedule');
    const listed = new Map();
    for (const run of runs.filter((each) => each.conclusion !== 'success').slice(0, JOB_READS)) listed.set(run.id, await attemptJobs(run));
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
    return { runs, calls, jobs: (run) => listed.get(run.id) ?? null };
  })();
  return history;
}

// A push and the sweep read what main gained since this workflow last
// finished green on it, by a push or a sweep: its own runs, and native.yml's
// scheduled runs for a workflow native.yml sweeps. A run that failed, was
// cancelled or that GitHub dropped leaves that commit where it was, so the
// next one still sees the change. A dispatch does not count: its inputs can
// run part of the workflow.
async function testedOnMain(file, flow) {
  const git = gitAncestry(repoRoot);
  const sha = git.resolve(head);
  if (!sha) return { base: null, reason: `${head} is not a commit in this checkout` };
  let runs;
  try {
    runs = await successfulRuns({ repository: env.GITHUB_REPOSITORY, workflow: `${file}.yml`, branch: 'main', token: env.GITHUB_TOKEN, apiUrl: env.GITHUB_API_URL });
    if (swept(flow)) {
      const { runs: sweeps, calls, jobs } = await dispatcherHistory();
      runs = [...runs, ...dispatchedRuns(file, sweeps, { calls: calls(file), jobs })];
    }
  } catch (error) {
    return { base: null, reason: `the last successful ${file} run on main is unknown: ${error.message}` };
  }
  return testedBase({ runs, head: sha, branch: 'main', git, workflow: file, atHead: event === 'schedule', events: new Set(['push', 'schedule']) });
}

async function onMain(file, flow, registry) {
  const tested = await testedOnMain(file, flow);
  if (!tested.base) return { run: true, reason: tested.reason };
  const changedPaths = changedPathsFromGit({ base: tested.base, head, cwd: repoRoot });
  const manifests = changedManifests({ base: tested.base, head, cwd: repoRoot, changedPaths });
  return mainWorkflow({ flow, changedPaths, manifests, registry, event });
}

// A ready pull request over its full-plan budget withholds every workflow that would run.
async function budgeted(decision, context) {
  if (env.GITHUB_EVENT_NAME !== 'pull_request' || !env.GITHUB_EVENT_PATH) return decision;
  const budget = async () => {
    const pullRequest = eventPullRequest(JSON.parse(await readFile(env.GITHUB_EVENT_PATH, 'utf8')));
    return fullPlanBudget({ pullRequest, excludeHead: pullRequest.head });
  };
  return budgetedDecision(decision, { ...context, budget, log: (message) => console.error(`${name}: ${message}`) });
}

async function pullRequestContext() {
  const base = option('--base');
  const changedPaths = changedPathsFromGit({ base, head, cwd: repoRoot });
  const manifests = changedManifests({ base, head, cwd: repoRoot, changedPaths });
  return { changedPaths, manifests, registry: await loadAppsRegistry(), graph: await loadConservativeWorkspaceGraph(repoRoot), root: repoRoot };
}

async function decideOne() {
  const flow = await read(name);
  if (event !== 'pull_request') return onMain(name, flow, await loadAppsRegistry());
  const context = await pullRequestContext();
  const calledFlows = await Promise.all(calledWorkflows(flow).map(read));
  return budgeted(decideWorkflow({ flow, calledFlows, ...context }), context);
}

// Every workflow native.yml calls, by file name.
async function dispatchedFlows() {
  const files = (await readdir(workflowsDirectory)).filter((file) => file.endsWith('.yml')).map((file) => file.slice(0, -'.yml'.length)).sort();
  const flows = await Promise.all(files.map(async (file) => [file, await read(file)]));
  return flows.filter(([, flow]) => (event === 'schedule' ? swept(flow) : dispatched(flow)));
}

// A workflow it cannot decide for runs; when it cannot decide at all, every one runs.
async function decideNative() {
  const flows = await dispatchedFlows();
  const decisions = new Map();
  const each = async (file, decide) => {
    try {
      decisions.set(file, await decide());
    } catch (error) {
      decisions.set(file, { run: true, reason: `the gate could not decide (${error.message})` });
    }
  };
  if (event === 'schedule') {
    const registry = await loadAppsRegistry();
    for (const [file, flow] of flows) await each(file, () => onMain(file, flow, registry));
    return { decisions };
  }
  let context;
  try {
    context = await pullRequestContext();
  } catch (error) {
    for (const [file] of flows) decisions.set(file, { run: true, reason: `the gate could not decide (${error.message})` });
    return { decisions };
  }
  for (const [file, flow] of flows) {
    await each(file, async () => dispatchDecision({ flow, calledFlows: await Promise.all(calledWorkflows(flow).map(read)), ...context }));
  }
  const runs = [...decisions.values()].some((decision) => decision.run);
  const verdict = runs ? await budgeted({ run: true, reason: 'a workflow runs' }, context) : { run: false };
  return { decisions, withheld: verdict.withheld ? verdict.reason : null };
}

async function report(lines) {
  for (const line of lines) console.error(line);
  if (env.GITHUB_STEP_SUMMARY) await appendFile(env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
}

async function output(text) {
  if (env.GITHUB_OUTPUT) await appendFile(env.GITHUB_OUTPUT, `${text}\n`);
  else console.log(text);
}

// A withheld suite fails, like ci's full-plan-withheld job, instead of reading as green.
function withhold(reason) {
  console.log(`::error title=Full plan withheld::${name}: ${reason}`);
  process.exitCode = 1;
}

if (native) {
  const { decisions, withheld } = await decideNative();
  const running = [...decisions].filter(([, decision]) => decision.run).map(([file]) => file);
  await report([...decisions].map(([file, decision]) => `${file} ${decision.run ? 'runs' : 'is skipped'}: ${decision.reason}`));
  if (withheld) {
    await output('workflows=[]');
    withhold(withheld);
  } else {
    await output(`workflows=${JSON.stringify(running)}`);
  }
} else {
  let decision;
  try {
    decision = await decideOne();
  } catch (error) {
    decision = { run: true, reason: `the gate could not decide (${error.message})` };
    console.log(`::warning::${name}: ${decision.reason}`);
  }
  await report([`${name} ${decision.run ? 'runs' : 'is skipped'}: ${decision.reason}`]);
  await output(`run=${decision.run}`);
  if (decision.withheld) withhold(decision.reason);
}
