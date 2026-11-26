import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DISPATCHER, dispatcherName, dispatched, sharedPaths, swept } from './workflow-gate.mjs';

// .github/workflows/native.yml (and native-2.yml, ... when sharded beyond
// MAX_CALLS_PER_DISPATCHER to stay under GitHub's 50-reusable-workflow limit),
// written from the workflows whose gate job lists shared_paths (scripts/native-workflow.mjs).
// One run per shard decides for all of its workflows (pr-gate.yml with
// `workflow: native` / `native-2`, scripts/lib/workflow-gate.mjs) and calls the
// ones that run, so a pull request that only touches shared trees starts one run
// per shard instead of one per workflow, and the nightly sweep runs per shard too.

// GitHub allows at most 50 unique reusable workflows in a single workflow's call
// tree (including nested pr-gate and node-cli-portable). Cap each dispatcher
// shard at 40 direct calls (42 unique reusable workflows) for comfortable headroom.
export const MAX_CALLS_PER_DISPATCHER = 40;
const NATIVE_CRON_HOUR = 13;
const NATIVE_CRON_BASE_MINUTE = 5;
const NATIVE_CRON_STEP_MINUTES = 5;
const LEVELS = ['none', 'read', 'write'];

export function shardCron(index) {
  const totalMinutes = NATIVE_CRON_BASE_MINUTE + index * NATIVE_CRON_STEP_MINUTES;
  const hour = (NATIVE_CRON_HOUR + Math.floor(totalMinutes / 60)) % 24;
  const minute = totalMinutes % 60;
  return `${minute} ${hour} * * *`;
}

export function shardWorkflows(workflows, maxPerShard = MAX_CALLS_PER_DISPATCHER) {
  if (!Number.isInteger(maxPerShard) || maxPerShard < 1) {
    throw new Error(`maxPerShard must be a positive integer, got ${maxPerShard}`);
  }
  if (!workflows.length) return [[DISPATCHER, []]];
  const shards = [];
  for (let offset = 0, index = 0; offset < workflows.length; offset += maxPerShard, index += 1) {
    shards.push([dispatcherName(index), workflows.slice(offset, offset + maxPerShard)]);
  }
  return shards;
}

// A called workflow gets at most what its calling job grants, so each call
// grants every permission one of the workflow's jobs, or the workflow
// itself, asks for (the gate's included).
export function callerPermissions(flow) {
  const granted = {};
  for (const permissions of [flow.permissions, ...Object.values(flow.jobs ?? {}).map((job) => job.permissions)]) {
    if (permissions === undefined) continue;
    if (typeof permissions !== 'object') throw new Error(`permissions ${JSON.stringify(permissions)} are not a map of scopes`);
    for (const [scope, level] of Object.entries(permissions)) {
      if (!LEVELS.includes(level)) throw new Error(`permission ${scope}: ${level} is not one of ${LEVELS.join(', ')}`);
      if (LEVELS.indexOf(level) > LEVELS.indexOf(granted[scope] ?? 'none')) granted[scope] = level;
    }
  }
  return Object.fromEntries(Object.entries(granted).sort(([a], [b]) => a.localeCompare(b)));
}

// The workflows native.yml calls, by file name without .yml, with their parsed files.
export async function dispatchedWorkflows(root) {
  const directory = join(root, '.github/workflows');
  const files = (await readdir(directory)).filter((file) => file.endsWith('.yml')).sort();
  const flows = await Promise.all(files.map(async (file) => [file.slice(0, -'.yml'.length), parse(await readFile(join(directory, file), 'utf8'))]));
  return flows.filter(([, flow]) => dispatched(flow));
}

// Whether native.yml calls a workflow. Running is the default: a call is
// skipped only when the gate succeeded and names the workflow in its `skips`
// output, the JSON array of the workflows it decided, each one explicitly, to
// skip (the decide step checks that it holds only names native.yml may call),
// or when the gate confirmed a full-plan denial (`withheld` exactly 'true').
// Absence means run, so a gate that failed, timed out, was cancelled or
// skipped, and a skip list that is missing, empty, truncated or names other
// workflows, run it. A workflow native.yml does not sweep is never called on
// the schedule. Every call uses this one template; test/native-decision.test.mjs
// evaluates it for each gate outcome and for corrupted skip lists.
// Draft pull requests and converted_to_draft transitions skip the gate job
// entirely (zero runners allocated) while still cancelling any in-flight PR run
// through the workflow concurrency group.
export const NOT_DRAFT_CONDITION = "(github.event_name != 'pull_request' || (!github.event.pull_request.draft && github.event.action != 'converted_to_draft'))";

export function callCondition(name, { sweep }) {
  const skipped = `needs.gate.result == 'success' && startsWith(needs.gate.outputs.skips, '[') && endsWith(needs.gate.outputs.skips, ']') && contains(needs.gate.outputs.skips, '"${name}"')`;
  return `\${{ !cancelled() && ${NOT_DRAFT_CONDITION} && ${sweep ? '' : "github.event_name != 'schedule' && "}needs.gate.outputs.withheld != 'true' && !(${skipped}) }}`;
}

// The job that fails a run whose full plan the gate withheld.
export const WITHHELD_CONDITION = `\${{ !cancelled() && ${NOT_DRAFT_CONDITION} && needs.gate.outputs.withheld == 'true' }}`;

export function renderNativeWorkflow(workflows, { name = DISPATCHER, cron = shardCron(0) } = {}) {
  const gateFiles = [`.github/workflows/${name}.yml`, '.github/workflows/pr-gate.yml', 'scripts/workflow-gate.mjs', 'scripts/lib/workflow-gate.mjs', 'scripts/lib/native-dispatcher.mjs'];
  const paths = [...gateFiles, ...new Set(workflows.flatMap(([, flow]) => sharedPaths(flow)).sort())];
  const calls = workflows.flatMap(([calledName, flow]) => [
    '',
    `  ${calledName}:`,
    '    needs: gate',
    `    if: ${callCondition(calledName, { sweep: swept(flow) })}`,
    `    uses: ./.github/workflows/${calledName}.yml`,
    '    permissions:',
    ...Object.entries(callerPermissions(flow)).map(([scope, level]) => `      ${scope}: ${level}`),
    '    secrets: inherit',
  ]);
  return [
    `name: ${name}`,
    '',
    '# Written by scripts/native-workflow.mjs from every workflow whose gate job',
    '# lists shared_paths. Edit those workflows, then run `node scripts/native-workflow.mjs`.',
    '#',
    '# A pull request that changes a shared path starts this one workflow, not',
    '# every workflow that builds on the path. Its gate decides for all of them',
    '# (pr-gate.yml with `workflow: native`, scripts/lib/workflow-gate.mjs) and',
    '# it calls the ones the change reaches, on the pull request\'s own event and',
    '# commit. A workflow GitHub certainly started itself for its own paths is',
    '# skipped here. A call runs unless the gate names it in its skip list',
    '# (callCondition in scripts/lib/native-workflow.mjs). The nightly schedule',
    '# is the sweep of every called workflow that a push to main also starts.',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]',
    '    paths:',
    ...paths.map((path) => `      - '${path}'`),
    '  schedule:',
    `    - cron: '${cron}'`,
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    `  group: ${name}-\${{ github.ref }}`,
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    '',
    'jobs:',
    '  # Decides which workflows to skip (scripts/lib/native-decision.mjs). Whatever',
    '  # goes wrong in it runs them: each call skips only when the gate names it.',
    '  gate:',
    `    if: ${NOT_DRAFT_CONDITION}`,
    '    uses: ./.github/workflows/pr-gate.yml',
    '    permissions:',
    '      contents: read',
    '      actions: read',
    '      pull-requests: read',
    '    with:',
    `      workflow: ${name}`,
    '      # The workflows the gate may name in `skips`: all of them for a draft.',
    '      calls: >-',
    ...workflows.map(([calledName]) => `        ${calledName}`),
    '      sweeps: >-',
    ...workflows.filter(([, flow]) => swept(flow)).map(([calledName]) => `        ${calledName}`),
    '',
    '  # Fails where ci withholds the full plan too: every call was skipped.',
    '  full-plan-withheld:',
    '    needs: gate',
    `    if: ${WITHHELD_CONDITION}`,
    '    runs-on: ubuntu-latest',
    '    timeout-minutes: 5',
    '    steps:',
    '      - name: Fail the withheld run',
    '        run: |',
    `          echo "::error title=Full plan withheld::This ready pull request already used its full-plan ci runs, so ${name}.yml ran none of the workflows it calls. Add the full-ci label, then re-run all jobs of ci and of ${name}."`,
    '          exit 1',
    ...calls,
    '',
  ].join('\n');
}

export function renderNativeWorkflows(workflows, { maxPerShard = MAX_CALLS_PER_DISPATCHER } = {}) {
  const shards = shardWorkflows(workflows, maxPerShard);
  return new Map(shards.map(([name, group], index) => [name, renderNativeWorkflow(group, { name, cron: shardCron(index) })]));
}
