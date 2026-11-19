import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// The ci.yml jobs the CI policy in AGENTS.md needs: the plan, the contract and
// package tests, the per-app jobs, the composite site build, the five checks of
// that build and the agentic jobs that wait for all of them, and the homepage
// easter egg. example-cache-retention keeps a cache and may fail without
// failing the run, so it is not one of them (test/ci-policy.test.mjs pins what
// it waits for).
//
// This file runs twice in every ci run: in app-plan (`pnpm check:integration`,
// before the plan) and in workspace-contracts (`pnpm test:contracts`, which
// runs every test file). Each copy checks both jobs and both steps, so a
// change that removes one guard, or the job around it, fails the other. A
// change that removes both is caught only by review and by the full plan it
// triggers: the planner selects every app for a change to app-plan or to a
// root script ci.yml runs.
//
// What each job waits for and when it runs. A change to either can skip a
// check, so it changes this table too.
const REQUIRED = {
  'app-plan': { needs: [], if: "github.event.action != 'converted_to_draft'" },
  'workspace-contracts': { needs: [], if: "github.event.action != 'converted_to_draft' && inputs.scope != 'gpu' && inputs.scope != 'site'" },
  'app-tests': { needs: ['app-plan'], if: "needs.app-plan.outputs.has_apps == 'true'" },
  'browser-e2e': { needs: ['app-plan'], if: "needs.app-plan.outputs.has_browser_apps == 'true' && (github.event_name != 'pull_request' || !github.event.pull_request.draft)" },
  'browser-e2e-gpu': { needs: ['app-plan'], if: "needs.app-plan.outputs.has_gpu_apps == 'true' && (github.event_name != 'pull_request' || (!github.event.pull_request.draft && needs.app-plan.outputs.all_apps != 'true'))" },
  'composite-site': { needs: ['app-plan'], if: "(github.event_name != 'pull_request' || !github.event.pull_request.draft) && (github.event_name == 'push' || github.event_name == 'schedule' || needs.app-plan.outputs.has_site == 'true')" },
  'site-runtime': { needs: ['composite-site'], if: "needs.composite-site.result == 'success'" },
  'site-audit': { needs: ['composite-site'], if: "needs.composite-site.result == 'success'" },
  'site-e2e': { needs: ['composite-site'], if: "needs.composite-site.result == 'success'" },
  'site-mobile': { needs: ['composite-site'], if: "needs.composite-site.result == 'success'" },
  'site-catalog': { needs: ['composite-site'], if: "needs.composite-site.result == 'success'" },
  'agent-interactions': { needs: ['composite-site', 'site-runtime', 'site-audit', 'site-e2e', 'site-mobile', 'site-catalog'], if: "needs.composite-site.outputs.agent_site_ready == 'true'" },
  'processing-workflows': { needs: ['composite-site', 'site-runtime', 'site-audit', 'site-e2e', 'site-mobile', 'site-catalog'], if: "github.event_name == 'workflow_dispatch' && inputs.agentic_mode == 'pipeline' && needs.composite-site.result == 'success'" },
  'homepage-easter-egg': { needs: ['app-plan'], if: "${{ !cancelled() && github.event.action != 'converted_to_draft' && inputs.scope != 'gpu' && (github.event_name != 'pull_request' || needs.app-plan.result != 'success' || needs.app-plan.outputs.easter_egg != 'skip') }}" },
  // The check a ruleset requires: every other job but the cache clean-up, which
  // runs only on main's ref and may fail by design (AGGREGATE_EXEMPT).
  'ci-required': { needs: 'every job', if: "${{ always() && github.event_name == 'pull_request' && github.event.action != 'converted_to_draft' }}" },
};
const AGGREGATE = 'ci-required';
const AGGREGATE_EXEMPT = ['example-cache-retention'];
// What the aggregate waits for: every job of ci.yml but itself and the exempt one, in file order.
const aggregateNeeds = (ci) => Object.keys(ci?.jobs ?? {}).filter((id) => id !== AGGREGATE && !AGGREGATE_EXEMPT.includes(id));
// The aggregate's one step: it prints every job's result and fails unless
// PASSES, the jq filter in its env, is true. Malformed or missing input fails it.
const AGGREGATE_RUN = `jq -rn --argjson needs "$NEEDS" '$needs | to_entries[] | "\\(.key): \\(.value.result)"'
jq -en --argjson needs "$NEEDS" "$PASSES" > /dev/null || {
  echo '::error title=ci-required::app-plan did not succeed, or a job failed, was cancelled or timed out. Read the jobs above.'
  exit 1
}
`;
const AGGREGATE_PASSES = '$needs | type == "object" and (.["app-plan"].result == "success") and ([.[] | .result] | all(. == "success" or . == "skipped"))';
const pinnedNeeds = (ci, id) => (REQUIRED[id].needs === 'every job' ? aggregateNeeds(ci) : REQUIRED[id].needs);
const REQUIRED_JOBS = Object.keys(REQUIRED);
const GUARDS = { 'app-plan': ['check:integration', 'pnpm check:integration'], 'workspace-contracts': ['test:contracts', 'pnpm test:contracts'] };
const GUARD_FILE = 'test/ci-required-jobs.test.mjs';
// The run steps of required jobs that may be skipped, by job and step name, with their condition.
const STEP_CONDITIONS = {
  'workspace-contracts': { 'Check correctness on full CI runs': "${{ !cancelled() && (github.event_name == 'schedule' || github.event_name == 'workflow_dispatch') }}" },
  'app-tests': { 'Install pinned nightly toolchain': 'matrix.rust_wasm', 'Install Python reference dependencies': 'matrix.python_reference', 'Test qsmbly against its built WASM': "matrix.app == 'qsmbly'" },
  'browser-e2e': { 'Install Greedy WebAssembly toolchain': 'matrix.rust_wasm', 'Install Python reference dependencies': 'matrix.python_reference' },
  'browser-e2e-gpu': { 'Install Greedy WebAssembly toolchain': 'matrix.rust_wasm', 'Install Python reference dependencies': 'matrix.python_reference' },
  'composite-site': {
    'Check that agent interactions can run': "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && inputs.agentic_mode == 'interactions')",
  },
};

const needsOf = (job) => [job?.needs ?? []].flat();

// What keeps the guard from holding: a missing or soft required job, one that
// waits for or runs under anything but its row, a run step that can be skipped
// other than as listed, a dependency that can be skipped where the job is due,
// or a guard step that is missing, conditional, soft or no longer runs this file.
function guardProblems(ci, scripts, contractFiles) {
  const problems = [];
  for (const id of REQUIRED_JOBS) {
    const job = ci?.jobs?.[id];
    if (!Array.isArray(job?.steps) || job.steps.length === 0) {
      problems.push(`ci.yml has no ${id} job with steps`);
      continue;
    }
    if (job['continue-on-error'] !== undefined && job['continue-on-error'] !== false) problems.push(`${id} may fail without failing the run (continue-on-error)`);
    if (job.if !== REQUIRED[id].if) problems.push(`${id} runs when ${JSON.stringify(job.if)}, not as the policy says`);
    if (JSON.stringify(needsOf(job)) !== JSON.stringify(pinnedNeeds(ci, id))) problems.push(`${id} needs ${JSON.stringify(needsOf(job))}, not ${JSON.stringify(pinnedNeeds(ci, id))}`);
    for (const step of job.steps) {
      if (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false) problems.push(`a step of ${id} may fail without failing it (continue-on-error)`);
      if (step.run && step.if !== undefined && STEP_CONDITIONS[id]?.[step.name] !== step.if) problems.push(`${id} step ${step.name ?? step.run} can be skipped (if: ${step.if})`);
    }
  }
  const decide = ci?.jobs?.[AGGREGATE]?.steps;
  if (!Array.isArray(decide) || decide.length !== 1 || decide[0].run !== AGGREGATE_RUN || decide[0].env?.NEEDS !== '${{ toJSON(needs) }}' || decide[0].env?.PASSES !== AGGREGATE_PASSES || decide[0].if !== undefined) problems.push(`${AGGREGATE} does not decide with its one tested step`);
  if (REQUIRED_JOBS.every((id) => ci?.jobs?.[id])) problems.push(...skippableNeeds(ci));
  for (const [id, [script, command]] of Object.entries(GUARDS)) {
    const step = ci?.jobs?.[id]?.steps?.find((each) => each.run === command);
    if (!step) problems.push(`${id} does not run ${command}, which runs this guard`);
    else if (step.if !== undefined || (step['continue-on-error'] !== undefined && step['continue-on-error'] !== false)) problems.push(`${id} can skip or ignore ${command}`);
    if (!scripts?.[script]) problems.push(`package.json has no ${script} script`);
  }
  if (!/(?:^| )test\/ci-required-jobs\.test\.mjs(?: |$)/.test(scripts?.['check:integration'] ?? '')) problems.push(`check:integration does not run ${GUARD_FILE}`);
  if (!contractFiles.includes(GUARD_FILE)) problems.push(`test:contracts does not run ${GUARD_FILE}`);
  return problems;
}

// A required job is skipped when a job it needs is skipped, unless its own `if`
// calls a status function (always(), !cancelled()) that admits that. For each
// required job this simulates every run ci.yml triggers on, with every value of
// the outputs read by the job and the jobs it waits for: the job is due when its
// own condition holds, with the outputs its skipped dependencies leave empty,
// and it must then run.
function skippableNeeds(ci) {
  const jobs = ci.jobs;
  const compiled = new Map();
  const condition = (id) => {
    if (!jobs[id]) fail(`a required job waits for ${id}, which ci.yml does not have`);
    if (!compiled.has(id)) compiled.set(id, jobs[id].if === undefined ? null : compile(String(jobs[id].if)));
    return compiled.get(id);
  };
  const found = new Map();
  const runs = runContexts(ci);
  for (const required of REQUIRED_JOBS) {
    // A condition that calls always() or !cancelled() and neither success() nor
    // failure() reads no need's outcome, so no skipped need can skip the job.
    if (condition(required)?.status && !/\b(?:success|failure)\(\)/.test(String(jobs[required].if))) continue;
    // The job and every job it waits for, directly or not.
    const closure = new Set();
    const visit = (id) => {
      if (closure.has(id)) return;
      condition(id);
      closure.add(id);
      needsOf(jobs[id]).forEach(visit);
    };
    visit(required);
    const outputs = [...new Set([...closure].flatMap((id) => [...String(jobs[id].if ?? '').matchAll(/\bneeds\.([\w-]+)\.outputs\.(\w+)/g)].map(([, need, name]) => `${need}.${name}`)))];
    for (const run of runs) {
      for (let bits = 0; bits < 2 ** outputs.length; bits++) {
        const values = Object.fromEntries(outputs.map((output, index) => [output, bits & (1 << index) ? 'true' : 'false']));
        const ran = new Map();
        const context = (id, success) => ({
          call: (name) => ({ always: true, cancelled: false, failure: false, success })[name] ?? fail(`${id} calls ${name}(), which the guard does not model`),
          read: (path) => read(path, { run, ran, values, id }),
        });
        const simulate = (id) => {
          if (!ran.has(id)) {
            const succeeded = needsOf(jobs[id]).map(simulate).every(Boolean);
            const own = condition(id);
            ran.set(id, own ? own(context(id, succeeded)) && (own.status || succeeded) : succeeded);
          }
          return ran.get(id);
        };
        if (simulate(required) || (condition(required) && !condition(required)(context(required, true)))) continue;
        for (const need of needsOf(jobs[required]).filter((each) => !ran.get(each))) {
          const key = `${required} needs ${need}`;
          if (!found.has(key)) found.set(key, `${key}, which is skipped on a ${describe(run)} run where ${required} is due; drop the need or let ${required} admit it with a status function`);
        }
      }
    }
  }
  return [...found.values()];
}

// The runs ci.yml triggers on, with each value a job condition can tell apart.
function runContexts(ci) {
  const inputs = ci.on?.workflow_dispatch?.inputs ?? {};
  const options = (name) => inputs[name]?.options ?? [inputs[name]?.default ?? null];
  const runs = [];
  for (const event of ['push', 'schedule']) runs.push({ event_name: event, ref: 'refs/heads/main', event: {}, inputs: {} });
  for (const ref of ['refs/heads/main', 'refs/heads/feature']) {
    for (const scope of options('scope')) {
      for (const agentic of options('agentic_mode')) runs.push({ event_name: 'workflow_dispatch', ref, event: {}, inputs: { scope, agentic_mode: agentic } });
    }
  }
  for (const action of ci.on?.pull_request?.types ?? ['opened', 'synchronize', 'reopened']) {
    const drafts = action === 'converted_to_draft' ? [true] : action === 'ready_for_review' ? [false] : [true, false];
    for (const draft of drafts) runs.push({ event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action, pull_request: { draft } }, inputs: {} });
  }
  return runs;
}

function describe(run) {
  if (run.event_name === 'pull_request') return `pull_request ${run.event.action}${run.event.pull_request.draft ? ' draft' : ''}`;
  if (run.event_name === 'workflow_dispatch') return `workflow_dispatch (scope ${run.inputs.scope}, agentic ${run.inputs.agentic_mode}, ${run.ref})`;
  return run.event_name;
}

// The context paths job conditions read. Any other path fails, so a condition
// that reads a new one extends the simulation before it can pass.
function read(path, { run, ran, values, id }) {
  const need = path.match(/^needs\.([\w-]+)\.(?:outputs\.(\w+)|(result))$/);
  if (need) {
    if (!ran.has(need[1])) fail(`${id} reads ${path} but does not need ${need[1]}`);
    if (need[3]) return ran.get(need[1]) ? 'success' : 'skipped';
    return ran.get(need[1]) ? values[`${need[1]}.${need[2]}`] : '';
  }
  const known = {
    'github.event_name': run.event_name,
    'github.ref': run.ref,
    'github.event.action': run.event.action ?? null,
    'github.event.pull_request.draft': run.event.pull_request?.draft ?? null,
  };
  if (Object.hasOwn(known, path)) return known[path];
  const input = path.match(/^inputs\.(\w+)$/)?.[1];
  if (input) return run.inputs[input] ?? null;
  return fail(`${id} reads ${path}, which the guard does not model`);
}

function fail(message) {
  throw new Error(message);
}

// A GitHub Actions expression, evaluated as GitHub does for what job conditions
// use: ! == != && || and parentheses over strings, booleans, null, context paths
// and status functions. Anything else fails to compile.
function compile(expression) {
  const source = expression.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1').trim();
  const tokens = [];
  const pattern = /\s*(?:'((?:[^']|'')*)'|(==|!=|&&|\|\||[!()])|([A-Za-z_][\w-]*(?:\.[A-Za-z_][\w-]*)*)(\(\))?)/y;
  while (pattern.lastIndex < source.length) {
    const at = pattern.lastIndex;
    const match = pattern.exec(source);
    if (!match) fail(`the guard cannot read ${JSON.stringify(source.slice(at))} in ${expression}`);
    if (match[1] !== undefined) tokens.push({ literal: match[1].replace(/''/g, "'") });
    else if (match[2]) tokens.push({ op: match[2] });
    else if (match[4]) tokens.push({ call: match[3] });
    else tokens.push(['true', 'false', 'null'].includes(match[3]) ? { literal: JSON.parse(match[3]) } : { path: match[3] });
  }
  const evaluate = (context) => {
    let at = 0;
    const or = () => {
      let left = and();
      while (tokens[at]?.op === '||') {
        at++;
        const right = and();
        left = truthy(left) ? left : right;
      }
      return left;
    };
    const and = () => {
      let left = compare();
      while (tokens[at]?.op === '&&') {
        at++;
        const right = compare();
        left = truthy(left) ? right : left;
      }
      return left;
    };
    const compare = () => {
      let left = unary();
      while (tokens[at]?.op === '==' || tokens[at]?.op === '!=') {
        const op = tokens[at++].op;
        const right = unary();
        left = op === '==' ? equal(left, right) : !equal(left, right);
      }
      return left;
    };
    const unary = () => {
      if (tokens[at]?.op !== '!') return primary();
      at++;
      return !truthy(unary());
    };
    const primary = () => {
      const token = tokens[at++];
      if (token?.op === '(') {
        const inner = or();
        if (tokens[at++]?.op !== ')') fail(`unbalanced parentheses in ${expression}`);
        return inner;
      }
      if (token && 'literal' in token) return token.literal;
      if (token?.call) return context.call(token.call);
      if (token?.path) return context.read(token.path);
      return fail(`unexpected ${JSON.stringify(token)} in ${expression}`);
    };
    const result = or();
    if (at !== tokens.length) fail(`the guard cannot read ${expression}`);
    return truthy(result);
  };
  evaluate.status = tokens.some((token) => ['always', 'cancelled', 'failure', 'success'].includes(token.call));
  return evaluate;
}

const truthy = (value) => !(value === false || value === null || value === undefined || value === '' || value === 0 || Number.isNaN(value));
const number = (value) => (value === null || value === undefined ? 0 : typeof value === 'boolean' ? Number(value) : typeof value === 'string' ? (value.trim() === '' ? 0 : Number(value)) : value);
// Strings compare without case; values of different types compare as numbers.
function equal(left, right) {
  if (typeof left === 'string' && typeof right === 'string') return left.toLowerCase() === right.toLowerCase();
  if (typeof left === typeof right) return left === right;
  return number(left) === number(right);
}

// The files `pnpm test:contracts` passes to node --test: its listing, run without the final runner.
const listings = new Map();
function contractFiles(script, cwd) {
  const listing = script.match(/^(.*)\|\s*xargs node --test$/)?.[1];
  if (!listing) return [];
  if (!listings.has(listing)) listings.set(listing, execFileSync('bash', ['-o', 'pipefail', '-c', listing], { cwd, encoding: 'utf8' }).split(/\s+/).filter(Boolean));
  return listings.get(listing);
}

const loadCi = async () => parse(await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8'));

test('ci.yml keeps every job the CI policy needs, unskippable, with the guard in two places', async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const ci = await loadCi();
  const scripts = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).scripts;
  const files = contractFiles(scripts['test:contracts'], root);
  assert.ok(files.includes(GUARD_FILE), 'test:contracts runs this file');
  assert.deepEqual(guardProblems(ci, scripts, files), [], 'restore what the CI policy needs, or change the policy in AGENTS.md and here');
  // The guard catches its own removal from either place, and a softened job or step.
  const edited = (edit) => {
    const copy = structuredClone(ci);
    const scriptsCopy = structuredClone(scripts);
    edit(copy, scriptsCopy);
    return guardProblems(copy, scriptsCopy, contractFiles(scriptsCopy['test:contracts'], root));
  };
  const cases = {
    'workspace-contracts deleted': (copy) => { delete copy.jobs['workspace-contracts']; },
    'app-plan guard step removed': (copy) => { copy.jobs['app-plan'].steps = copy.jobs['app-plan'].steps.filter((step) => step.run !== 'pnpm check:integration'); },
    'workspace-contracts guard step removed': (copy) => { copy.jobs['workspace-contracts'].steps = copy.jobs['workspace-contracts'].steps.filter((step) => step.run !== 'pnpm test:contracts'); },
    'guard step made soft': (copy) => { copy.jobs['app-plan'].steps.find((step) => step.run === 'pnpm check:integration')['continue-on-error'] = true; },
    'guard step made conditional': (copy) => { copy.jobs['workspace-contracts'].steps.find((step) => step.run === 'pnpm test:contracts').if = "github.event_name == 'schedule'"; },
    'required job made soft': (copy) => { copy.jobs['app-tests']['continue-on-error'] = true; },
    'required job condition changed': (copy) => { copy.jobs['composite-site'].if = "github.event_name == 'schedule'"; },
    // S4: the reviewer's case, a need on a job the plan skips on most runs.
    'composite-site needs full-plan-withheld': (copy) => { copy.jobs['composite-site'].needs = ['app-plan', 'full-plan-withheld']; },
    'workspace-contracts waits for the plan': (copy) => { copy.jobs['workspace-contracts'].needs = 'app-plan'; },
    'check step made skippable': (copy) => { copy.jobs['app-tests'].steps.find((step) => step.run).if = 'false'; },
    'guard left out of check:integration': (copy, scriptsCopy) => { scriptsCopy['check:integration'] = scriptsCopy['check:integration'].replace(`${GUARD_FILE} `, ''); },
    'guard left out of test:contracts': (copy, scriptsCopy) => { scriptsCopy['test:contracts'] = scriptsCopy['test:contracts'].replace('-e /easter-egg.test.mjs', '-e /easter-egg.test.mjs -e /ci-required-jobs.test.mjs'); },
  };
  for (const [label, edit] of Object.entries(cases)) assert.ok(edited(edit).length > 0, label);
  assert.ok(edited(cases['composite-site needs full-plan-withheld']).includes('composite-site needs ["app-plan","full-plan-withheld"], not ["app-plan"]'));
});

test('no required job needs a job that can be skipped on a run where it is due', async () => {
  const ci = await loadCi();
  assert.deepEqual(skippableNeeds(ci), []);
  const withEdit = (edit) => {
    const copy = structuredClone(ci);
    edit(copy);
    return skippableNeeds(copy);
  };
  // S4, found apart from the needs pin: full-plan-withheld runs only when the budget withholds the plan.
  assert.deepEqual(withEdit((copy) => { copy.jobs['composite-site'].needs = ['app-plan', 'full-plan-withheld']; }), [
    'composite-site needs full-plan-withheld, which is skipped on a push run where composite-site is due; drop the need or let composite-site admit it with a status function',
  ]);
  // A job that runs only on main, and a per-app job, are skipped where the job needing them is due.
  assert.match(withEdit((copy) => { copy.jobs['app-tests'].needs = ['app-plan', 'example-cache-retention']; }).join('\n'), /^app-tests needs example-cache-retention, which is skipped on a /);
  assert.match(withEdit((copy) => { copy.jobs['workspace-contracts'].needs = ['browser-e2e']; }).join('\n'), /^workspace-contracts needs browser-e2e, which is skipped on a push run/);
  // Without its own converted_to_draft check the easter egg would be due where app-plan is skipped, were it not for !cancelled().
  assert.deepEqual(withEdit((copy) => { copy.jobs['homepage-easter-egg'].if = "${{ !cancelled() && inputs.scope != 'gpu' }}"; }), []);
  assert.deepEqual(withEdit((copy) => { copy.jobs['homepage-easter-egg'].if = "inputs.scope != 'gpu'"; }), [
    'homepage-easter-egg needs app-plan, which is skipped on a pull_request converted_to_draft draft run where homepage-easter-egg is due; drop the need or let homepage-easter-egg admit it with a status function',
  ]);
  // A status function that admits a skipped need lets the job run without it.
  assert.deepEqual(withEdit((copy) => {
    copy.jobs['composite-site'].needs = ['app-plan', 'full-plan-withheld'];
    copy.jobs['composite-site'].if = `\${{ !cancelled() && ${copy.jobs['composite-site'].if} }}`;
  }), []);
  // A condition the simulation cannot evaluate fails instead of passing.
  assert.throws(() => withEdit((copy) => { copy.jobs['app-tests'].if = "contains(github.event.pull_request.labels.*.name, 'x')"; }), /cannot read/);
  assert.throws(() => withEdit((copy) => { copy.jobs['app-tests'].if = "github.actor != 'bot'"; }), /reads github\.actor, which the guard does not model/);
});

// S10: running is the default. Only a plan that succeeded and wrote `skip` skips the easter egg on a pull request.
test('a pull request skips the easter egg only when the plan succeeded and wrote skip', async () => {
  const condition = compile((await loadCi()).jobs['homepage-easter-egg'].if);
  const starts = ({ action = 'synchronize', draft = false, result = 'success', output }) => {
    const values = {
      'github.event_name': 'pull_request',
      'github.event.action': action,
      'github.event.pull_request.draft': draft,
      'inputs.scope': null,
      'needs.app-plan.result': result,
      'needs.app-plan.outputs.easter_egg': output ?? '',
    };
    return condition({
      call: (name) => ({ always: true, cancelled: false, failure: result === 'failure', success: result === 'success' })[name],
      read: (path) => (Object.hasOwn(values, path) ? values[path] : fail(`the case does not set ${path}`)),
    });
  };
  for (const [action, draft] of [['opened', true], ['opened', false], ['synchronize', true], ['synchronize', false], ['reopened', false], ['ready_for_review', false]]) {
    const label = `${action}${draft ? ' draft' : ''}`;
    assert.equal(starts({ action, draft, output: 'skip' }), false, label);
    // GitHub compares strings without case; the planner writes only `run` or `skip`.
    assert.equal(starts({ action, draft, output: 'SKIP' }), false, label);
    for (const output of ['run', '', undefined, 'true', 'false', 'skipped', ' skip']) assert.equal(starts({ action, draft, output }), true, `${label}: ${JSON.stringify(output)}`);
    for (const result of ['failure', 'cancelled', 'skipped']) {
      for (const output of ['skip', '']) assert.equal(starts({ action, draft, result, output }), true, `${label}: app-plan ${result}, ${JSON.stringify(output)}`);
    }
  }
  // Converting a pull request to draft starts nothing.
  assert.equal(starts({ action: 'converted_to_draft', draft: true, result: 'skipped' }), false);
});

test('the guard evaluates conditions as GitHub does', () => {
  const run = (expression, values = {}) => compile(expression)({ call: (name) => name !== 'cancelled' && name !== 'failure', read: (path) => values[path] ?? null });
  // A missing input is null, which equals '' but no other string; strings compare without case.
  assert.equal(run("inputs.scope != 'gpu'"), true);
  assert.equal(run("inputs.scope == ''"), true);
  assert.equal(run("inputs.scope == 'GPU'", { 'inputs.scope': 'gpu' }), true);
  assert.equal(run('!github.event.pull_request.draft'), true);
  assert.equal(run('!github.event.pull_request.draft', { 'github.event.pull_request.draft': true }), false);
  // ! binds tighter than ==, which binds tighter than &&, which binds tighter than ||.
  assert.equal(run("a == 'x' || b == 'y' && c == 'z'", { b: 'y', c: 'z' }), true);
  assert.equal(run("(a == 'x' || b == 'y') && c == 'z'", { b: 'y' }), false);
  assert.equal(run("!a == 'x'", { a: 'x' }), false);
  assert.equal(run('${{ !cancelled() && success() }}'), true);
  assert.equal(compile('${{ !cancelled() }}').status, true);
  assert.equal(compile("needs.a.outputs.b == 'true'").status, false);
});

// The jobs a run starts, given the outputs its jobs write: a job starts when its
// own condition holds and, unless that condition calls a status function, every
// job it needs started. Every started job is taken to succeed.
function startedJobs(ci, run, values) {
  const ran = new Map();
  const simulate = (id) => {
    if (!ran.has(id)) {
      const succeeded = needsOf(ci.jobs[id]).map(simulate).every(Boolean);
      const own = ci.jobs[id].if === undefined ? null : compile(String(ci.jobs[id].if));
      const context = {
        call: (name) => ({ always: true, cancelled: false, failure: false, success: succeeded })[name] ?? fail(`${id} calls ${name}()`),
        read: (path) => read(path, { run, ran, values, id }),
      };
      ran.set(id, own ? own(context) && (own.status || succeeded) : succeeded);
    }
    return ran.get(id);
  };
  return Object.keys(ci.jobs).filter(simulate);
}

// The outputs a one-app plan of a hardware-GPU app writes, with overrides.
const planOutputs = (overrides = {}) => ({
  'app-plan.has_apps': 'true',
  'app-plan.has_browser_apps': 'true',
  'app-plan.has_gpu_apps': 'true',
  'app-plan.all_apps': 'false',
  'app-plan.has_site': 'true',
  'app-plan.withheld': 'false',
  'app-plan.full_plan': 'false',
  'app-plan.easter_egg': 'run',
  'composite-site.agent_site_ready': '',
  ...Object.fromEntries(Object.entries(overrides).map(([key, value]) => [key.includes('.') ? key : `app-plan.${key}`, value])),
});
const pullRequest = (action, draft) => ({ event_name: 'pull_request', ref: 'refs/pull/1/merge', event: { action, pull_request: { draft } }, inputs: {} });
const onMain = (event_name) => ({ event_name, ref: 'refs/heads/main', event: {}, inputs: {} });
const dispatch = (scope, agentic_mode = 'none', ref = 'refs/heads/feature') => ({ event_name: 'workflow_dispatch', ref, event: {}, inputs: { scope, agentic_mode } });
const noApps = { has_apps: 'false', has_browser_apps: 'false', has_gpu_apps: 'false', has_site: 'false' };
// Each event, with the outputs the planner writes for it (scripts/app-plan.mjs).
export const JOB_GRAPH_SCENARIOS = {
  'draft pull request, one GPU app': [pullRequest('synchronize', true), planOutputs()],
  'ready pull request, one GPU app': [pullRequest('synchronize', false), planOutputs()],
  'ready pull request, whole catalogue': [pullRequest('ready_for_review', false), planOutputs({ all_apps: 'true', full_plan: 'true' })],
  'ready pull request over its budget': [pullRequest('synchronize', false), planOutputs({ withheld: 'true', has_site: 'false' })],
  'pull request converted to draft': [pullRequest('converted_to_draft', true), planOutputs()],
  'draft pull request opened, docs only': [pullRequest('opened', true), planOutputs(noApps)],
  'ready pull request, docs only': [pullRequest('synchronize', false), planOutputs(noApps)],
  'pull request reopened, one GPU app': [pullRequest('reopened', false), planOutputs()],
  'push, one GPU app': [onMain('push'), planOutputs()],
  'push, docs only': [onMain('push'), planOutputs(noApps)],
  nightly: [onMain('schedule'), planOutputs({ all_apps: 'true', 'composite-site.agent_site_ready': 'true' })],
  'dispatch, scope affected': [dispatch('affected'), planOutputs()],
  'dispatch on main, scope affected': [dispatch('affected', 'none', 'refs/heads/main'), planOutputs()],
  'dispatch, scope all': [dispatch('all'), planOutputs({ all_apps: 'true' })],
  'dispatch, scope gpu': [dispatch('gpu'), planOutputs({ ...noApps, has_gpu_apps: 'true', all_apps: 'true' })],
  'dispatch, scope site, interactions': [dispatch('site', 'interactions'), planOutputs({ ...noApps, has_site: 'true', 'composite-site.agent_site_ready': 'true' })],
  'dispatch, scope site, pipeline': [dispatch('site', 'pipeline'), planOutputs({ ...noApps, has_site: 'true' })],
};
const SITE_CHECK_JOBS = ['site-runtime', 'site-audit', 'site-e2e', 'site-mobile', 'site-catalog'];
const PLAN_RUN = ['app-plan', 'workspace-contracts'];
const APP_RUN = ['app-tests', 'browser-e2e', 'browser-e2e-gpu'];
const SITE_RUN = ['composite-site', ...SITE_CHECK_JOBS];
// What each scenario starts, read off ci.yml by startedJobs. A change to a job
// condition that moves a job in or out of a row changes this table.
const EXPECTED_JOB_GRAPH = {
  // A draft runs unit and build tests; its browser tests run on a dispatch.
  'draft pull request, one GPU app': [...PLAN_RUN, 'app-tests', 'homepage-easter-egg', 'ci-required'],
  'ready pull request, one GPU app': [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'homepage-easter-egg', 'ci-required'],
  'ready pull request, whole catalogue': [...PLAN_RUN, 'full-plan', 'app-tests', ...SITE_RUN, 'browser-e2e', 'homepage-easter-egg', 'ci-required'],
  'ready pull request over its budget': [...PLAN_RUN.slice(0, 1), 'full-plan-withheld', 'workspace-contracts', ...APP_RUN, 'homepage-easter-egg', 'ci-required'],
  'pull request converted to draft': [],
  'draft pull request opened, docs only': [...PLAN_RUN, 'homepage-easter-egg', 'ci-required'],
  'ready pull request, docs only': [...PLAN_RUN, 'homepage-easter-egg', 'ci-required'],
  'pull request reopened, one GPU app': [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'homepage-easter-egg', 'ci-required'],
  // A push builds the site whatever its plan, and no check is required of it.
  'push, one GPU app': [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'example-cache-retention', 'homepage-easter-egg'],
  'push, docs only': [...PLAN_RUN, ...SITE_RUN, 'example-cache-retention', 'homepage-easter-egg'],
  nightly: [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'example-cache-retention', 'agent-interactions', 'homepage-easter-egg'],
  'dispatch, scope affected': [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'homepage-easter-egg'],
  'dispatch on main, scope affected': [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'example-cache-retention', 'homepage-easter-egg'],
  'dispatch, scope all': [...PLAN_RUN, ...APP_RUN, ...SITE_RUN, 'homepage-easter-egg'],
  'dispatch, scope gpu': ['app-plan', 'browser-e2e-gpu'],
  'dispatch, scope site, interactions': ['app-plan', ...SITE_RUN, 'agent-interactions', 'homepage-easter-egg'],
  'dispatch, scope site, pipeline': ['app-plan', ...SITE_RUN, 'processing-workflows', 'homepage-easter-egg'],
};

test('every event starts the jobs the job-graph table says, read off ci.yml', async () => {
  const ci = await loadCi();
  const order = Object.keys(ci.jobs);
  const sorted = (ids) => [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const graph = Object.fromEntries(Object.entries(JOB_GRAPH_SCENARIOS).map(([name, [run, values]]) => [name, startedJobs(ci, run, values)]));
  if (process.env.PRINT_JOB_GRAPH) {
    const short = (id) => id.replace(/^site-/, 's-');
    console.log(`| Run | ${order.map(short).join(' | ')} |\n| --- |${order.map(() => ' :-: |').join('')}`);
    for (const [name, started] of Object.entries(graph)) console.log(`| ${name} | ${order.map((id) => (started.includes(id) ? 'x' : '')).join(' | ')} |`);
  }
  for (const [name, expected] of Object.entries(EXPECTED_JOB_GRAPH)) assert.deepEqual(graph[name], sorted(expected), name);
  assert.deepEqual(Object.keys(graph), Object.keys(EXPECTED_JOB_GRAPH));
});

// Runs the aggregate's step as GitHub runs a bash step, with `needs` as the
// raw text GitHub would pass.
function stepPasses(ci, text) {
  const step = ci.jobs[AGGREGATE].steps[0];
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', step.run], { env: { PATH: process.env.PATH, NEEDS: text, PASSES: step.env.PASSES }, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

// The step's verdict for each well-formed `needs` (an object), from its own
// filter in one jq process. A jq error, which fails the step, reads as fail.
function aggregatePasses(ci, cases) {
  const filter = `inputs as $needs | try (${ci.jobs[AGGREGATE].steps[0].env.PASSES}) catch false`;
  const output = execFileSync('jq', ['-cn', filter], { input: cases.map((needs) => JSON.stringify(needs)).join('\n'), encoding: 'utf8' });
  const verdicts = output.trim().split('\n').map((verdict) => verdict === 'true');
  assert.equal(verdicts.length, cases.length);
  return verdicts;
}

// The needs context of the aggregate for one run: a started job gets `result`,
// every other job `skipped`, and a job whose implicit success() a failed or
// cancelled need denies is skipped too, as GitHub skips it.
function needsContext(ci, started, results = {}) {
  const context = {};
  const outcome = (id) => {
    if (context[id]) return context[id].result;
    const blocked = needsOf(ci.jobs[id]).map(outcome).some((result) => result !== 'success');
    const status = /\b(?:always|cancelled|failure)\(\)/.test(String(ci.jobs[id].if ?? ''));
    const result = !started.includes(id) || (blocked && !status) ? 'skipped' : results[id] ?? 'success';
    context[id] = { result, outputs: {} };
    return result;
  };
  for (const id of needsOf(ci.jobs[AGGREGATE])) outcome(id);
  return context;
}

test('the aggregate passes only when the plan succeeded and every job succeeded or was skipped', async () => {
  const ci = await loadCi();
  const ids = needsOf(ci.jobs[AGGREGATE]);
  const all = (result) => Object.fromEntries(ids.map((id) => [id, { result, outputs: {} }]));
  const cases = [];
  const expect = (needs, pass, label) => cases.push({ needs, pass, label });
  // Every job passed, or every job but the plan was skipped by its condition.
  expect(all('success'), true, 'every job passed');
  expect({ ...all('skipped'), 'app-plan': { result: 'success', outputs: {} } }, true, 'only the plan ran');
  // One job in each other state, the rest passed or skipped.
  for (const id of ids) {
    for (const rest of ['success', 'skipped']) {
      for (const result of ['failure', 'cancelled', 'timed_out', 'neutral', 'action_required', 'SUCCESS', '', null]) {
        expect({ ...all(rest), 'app-plan': { result: 'success', outputs: {} }, [id]: { result, outputs: {} } }, false, `${id} ${JSON.stringify(result)} among ${rest}`);
      }
    }
    // A job with no result.
    expect({ ...all('success'), [id]: { outputs: {} } }, false, `${id} without a result`);
  }
  // The plan must have succeeded: skipped (converted to draft, or a condition) is not enough.
  for (const result of ['skipped', 'failure', 'cancelled']) expect({ ...all('skipped'), 'app-plan': { result, outputs: {} } }, false, `app-plan ${result}`);
  const { 'app-plan': plan, ...withoutPlan } = all('success');
  assert.ok(plan);
  expect(withoutPlan, false, 'no app-plan record');
  const verdicts = aggregatePasses(ci, cases.map((each) => each.needs));
  cases.forEach((each, index) => assert.equal(verdicts[index], each.pass, each.label));
  // The step itself, as GitHub runs it: the filter decides, and malformed or empty input fails.
  assert.equal(stepPasses(ci, JSON.stringify(all('success'))), true, 'the step passes every job passed');
  assert.equal(stepPasses(ci, JSON.stringify({ ...all('success'), 'site-audit': { result: 'failure', outputs: {} } })), false, 'the step fails a failed job');
  assert.equal(stepPasses(ci, JSON.stringify({ ...all('skipped'), 'app-plan': { result: 'cancelled', outputs: {} } })), false, 'the step fails a cancelled plan');
  for (const text of ['', 'null', '[]', '{}', '"success"', '{"app-plan":', 'not json', '{"app-plan":"success"}']) assert.equal(stepPasses(ci, text), false, JSON.stringify(text));
});

test('the aggregate fails every run in which a started job failed, also through the jobs that failure skips', async () => {
  const ci = await loadCi();
  const cases = [];
  for (const [name, [run, values]] of Object.entries(JOB_GRAPH_SCENARIOS)) {
    const started = startedJobs(ci, run, values);
    if (!started.includes(AGGREGATE)) continue;
    cases.push({ needs: needsContext(ci, started), pass: true, label: `${name}: every started job passed` });
    for (const id of started.filter((each) => each !== AGGREGATE)) {
      for (const result of ['failure', 'cancelled']) {
        const context = needsContext(ci, started, { [id]: result });
        cases.push({ needs: context, pass: false, label: `${name}: ${id} ${result}` });
        // The jobs that failure skips read as skipped, and the failure itself still fails the check.
        if (id === 'composite-site') assert.ok(SITE_CHECK_JOBS.every((check) => context[check].result === 'skipped'), name);
      }
    }
  }
  assert.ok(cases.length > 100);
  const verdicts = aggregatePasses(ci, cases.map((each) => each.needs));
  cases.forEach((each, index) => assert.equal(verdicts[index], each.pass, each.label));
});

test('the aggregate waits for every job but the main-only cache clean-up and runs on every pull request run', async () => {
  const ci = await loadCi();
  assert.deepEqual(needsOf(ci.jobs[AGGREGATE]), aggregateNeeds(ci));
  assert.equal(ci.jobs['example-cache-retention'].if, "github.ref == 'refs/heads/main'", 'the exempt job never runs in a pull request run');
  assert.equal(ci.jobs['example-cache-retention']['continue-on-error'], true);
  const condition = compile(ci.jobs[AGGREGATE].if);
  const due = (run) => condition({ call: (name) => ({ always: true, cancelled: true, failure: true, success: false })[name], read: (path) => read(path, { run, ran: new Map(), values: {}, id: AGGREGATE }) });
  // Even when the run was cancelled or a job failed, so the check never reads as a skipped pass.
  for (const action of ['opened', 'synchronize', 'reopened', 'ready_for_review']) {
    for (const draft of [true, false]) assert.equal(due(pullRequest(action, draft)), true, `${action} ${draft}`);
  }
  assert.equal(due(pullRequest('converted_to_draft', true)), false);
  // Nothing requires a check of a push, the nightly or a dispatch, so it does not run there.
  for (const run of [onMain('push'), onMain('schedule'), dispatch('affected'), dispatch('all', 'none', 'refs/heads/main')]) assert.equal(due(run), false, `${run.event_name} ${run.ref}`);
  // The guard fails when a job is added without the aggregate waiting for it, or the step changes.
  const edited = (edit) => {
    const copy = structuredClone(ci);
    edit(copy);
    return guardProblems(copy, { 'check:integration': `node --test ${GUARD_FILE} x`, 'test:contracts': 'x' }, [GUARD_FILE]).join('\n');
  };
  assert.match(edited((copy) => { copy.jobs['new-check'] = { needs: 'app-plan', 'runs-on': 'ubuntu-latest', steps: [{ run: 'true' }] }; }), /ci-required needs .*, not .*new-check/);
  assert.match(edited((copy) => { copy.jobs[AGGREGATE].needs = copy.jobs[AGGREGATE].needs.filter((id) => id !== 'site-audit'); }), /ci-required needs/);
  assert.match(edited((copy) => { copy.jobs[AGGREGATE].steps[0].run = 'exit 0'; }), /does not decide with its one tested step/);
  assert.match(edited((copy) => { copy.jobs[AGGREGATE].if = '${{ !cancelled() }}'; }), /ci-required runs when/);
  assert.match(edited((copy) => { copy.jobs[AGGREGATE]['continue-on-error'] = true; }), /ci-required may fail without failing the run/);
});
