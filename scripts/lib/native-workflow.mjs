import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { DISPATCHER, dispatched, sharedPaths, swept } from './workflow-gate.mjs';

// .github/workflows/native.yml, written from the workflows whose gate job
// lists shared_paths (scripts/native-workflow.mjs). One run of it decides for
// all of them (pr-gate.yml with `workflow: native`) and calls the ones that
// run, so a pull request that only touches shared trees starts one workflow
// run instead of one per workflow, and the nightly sweep is one run too.

const NATIVE_CRON = '5 13 * * *';
// A change to the decision itself starts native.yml, so a pull request shows the new decision.
const GATE_FILES = ['.github/workflows/native.yml', '.github/workflows/pr-gate.yml', 'scripts/workflow-gate.mjs', 'scripts/lib/workflow-gate.mjs'];
const LEVELS = ['none', 'read', 'write'];

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

export function renderNativeWorkflow(workflows) {
  const paths = [...GATE_FILES, ...new Set(workflows.flatMap(([, flow]) => sharedPaths(flow)).sort())];
  const calls = workflows.flatMap(([name, flow]) => [
    '',
    `  ${name}:`,
    '    needs: gate',
    `    if: contains(fromJSON(needs.gate.outputs.workflows || '[]'), '${name}')`,
    `    uses: ./.github/workflows/${name}.yml`,
    '    permissions:',
    ...Object.entries(callerPermissions(flow)).map(([scope, level]) => `      ${scope}: ${level}`),
    '    secrets: inherit',
  ]);
  return [
    `name: ${DISPATCHER}`,
    '',
    '# Written by scripts/native-workflow.mjs from every workflow whose gate job',
    '# lists shared_paths. Edit those workflows, then run `node scripts/native-workflow.mjs`.',
    '#',
    '# A pull request that changes a shared path starts this one workflow, not',
    '# every workflow that builds on the path. Its gate decides for all of them',
    '# (pr-gate.yml with `workflow: native`, scripts/lib/workflow-gate.mjs) and',
    '# it calls the ones the change reaches, on the pull request\'s own event and',
    '# commit. A workflow whose own paths the pull request also changed runs',
    '# itself, and is left out here. The nightly schedule is the sweep of every',
    '# called workflow that a push to main also starts.',
    'on:',
    '  pull_request:',
    '    types: [opened, synchronize, reopened, ready_for_review, converted_to_draft]',
    '    paths:',
    ...paths.map((path) => `      - '${path}'`),
    '  schedule:',
    `    - cron: '${NATIVE_CRON}'`,
    '',
    'permissions:',
    '  contents: read',
    '',
    'concurrency:',
    `  group: ${DISPATCHER}-\${{ github.ref }}`,
    "  cancel-in-progress: ${{ github.event_name == 'pull_request' }}",
    '',
    'jobs:',
    '  # Always finishes unless a ready pull request is over its full-plan budget,',
    '  # where it fails as ci\'s full-plan-withheld does.',
    '  gate:',
    '    uses: ./.github/workflows/pr-gate.yml',
    '    permissions:',
    '      contents: read',
    '      actions: read',
    '      pull-requests: read',
    '    with:',
    `      workflow: ${DISPATCHER}`,
    '      # What runs when the decision ends without a selection.',
    '      calls: >-',
    ...workflows.map(([name]) => `        ${name}`),
    '      sweeps: >-',
    ...workflows.filter(([, flow]) => swept(flow)).map(([name]) => `        ${name}`),
    ...calls,
    '',
  ].join('\n');
}
