import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { provisioners, unpublished } from '../scripts/lib/e2e-test-data.mjs';

// The full argument text of every `test.skip(...)` call, across line breaks.
// Parentheses inside string literals do not end the call.
function skipCalls(source) {
  const calls = [];
  for (const match of source.matchAll(/test\.skip\(/g)) {
    let depth = 1;
    let quote = null;
    let index = match.index + match[0].length;
    for (; index < source.length && depth > 0; index++) {
      const character = source[index];
      if (quote) {
        if (character === '\\') index++;
        else if (character === quote) quote = null;
      } else if (`'"\``.includes(character)) quote = character;
      else if (character === '(') depth++;
      else if (character === ')') depth--;
    }
    calls.push(source.slice(match.index, index));
  }
  return calls;
}

// Environment variables that decide whether an e2e test skips itself: any
// `process.env.X` in a `test.skip(...)` call, or a `name` there where
// `const name = process.env.X` (`!name`, `name !== "check"`, ...).
async function dataGates() {
  const gates = new Map();
  for (const app of await readdir(join(repoRoot, 'apps'))) {
    const directory = join(repoRoot, 'apps', app, 'e2e');
    const files = await readdir(directory).catch(() => []);
    for (const file of files.filter((name) => /\.(spec\.)?[cm]?[jt]s$/.test(name))) {
      const source = await readFile(join(directory, file), 'utf8');
      const aliases = new Map([...source.matchAll(/const (\w+) = process\.env\.([A-Z0-9_]+);/g)].map(([, name, variable]) => [name, variable]));
      for (const line of skipCalls(source)) {
        for (const [, variable] of line.matchAll(/process\.env\.([A-Z0-9_]+)/g)) gates.set(variable, `${app}/e2e/${file}`);
        for (const [name] of line.matchAll(/\b\w+\b/g)) if (aliases.has(name)) gates.set(aliases.get(name), `${app}/e2e/${file}`);
      }
    }
  }
  return gates;
}

test('every data-gated e2e test is provisioned in CI or documented as unpublished', async () => {
  const provided = new Set(Object.values(provisioners).flatMap(({ env }) => env));
  const gates = await dataGates();
  assert.ok(gates.size > 10, 'the gate scan should find the known data gates');
  const missing = [...gates].filter(([variable]) => !provided.has(variable) && !unpublished[variable]);
  assert.deepEqual(missing, [], 'add a provisioner in scripts/lib/e2e-test-data.mjs or an unpublished reason');
  for (const variable of Object.keys(unpublished)) assert.ok(gates.has(variable), `${variable} no longer gates a test`);
});

test('every hardware-GPU app has a provisioner for the macOS job', async () => {
  const registry = await loadAppsRegistry();
  for (const app of registry.apps.filter(({ ci }) => ci.hardware_gpu)) {
    assert.ok(provisioners[app.id], `${app.id} needs an entry in scripts/lib/e2e-test-data.mjs`);
  }
  for (const app of Object.keys(provisioners)) {
    const entry = registry.apps.find(({ id }) => id === app);
    assert.ok(entry?.ci.browser_test, `${app} is provisioned but has no browser suite`);
  }
});

test('both browser jobs download the data their apps need', async () => {
  const workflow = parse(await readFile(join(repoRoot, '.github/workflows/ci.yml'), 'utf8'));
  for (const name of ['browser-e2e', 'browser-e2e-gpu']) {
    const steps = workflow.jobs[name].steps;
    const download = steps.findIndex((step) => step.run?.includes('scripts/e2e-test-data.mjs'));
    const tests = steps.findIndex((step) => step.run?.includes('test:e2e'));
    assert.ok(download >= 0 && download < tests, `${name} downloads test data before its tests`);
  }
  // Linux cannot finish the hardware-GPU workloads, so it leaves them to macOS
  // and provisions only their CPU subset.
  const linux = workflow.jobs['browser-e2e'].steps.find((step) => step.run?.includes('scripts/e2e-test-data.mjs'));
  assert.equal(linux.if, undefined);
  assert.equal(linux.env.CPU_ONLY, "${{ matrix.hardware_gpu && '--cpu' || '' }}");
  assert.match(linux.run, /\$CPU_ONLY/);
  const macos = workflow.jobs['browser-e2e-gpu'].steps.find((step) => step.run?.includes('scripts/e2e-test-data.mjs'));
  assert.doesNotMatch(macos.run, /--cpu|CPU_ONLY/);
});

test('a CPU subset provisions only variables its full provisioner declares', async () => {
  const registry = await loadAppsRegistry();
  for (const [app, { env, cpu }] of Object.entries(provisioners)) {
    if (!cpu) continue;
    assert.ok(registry.apps.find(({ id }) => id === app).ci.hardware_gpu, `${app}: only hardware-GPU apps need a CPU subset`);
    assert.ok(cpu.env.length > 0, `${app}: an empty CPU subset is no subset`);
    for (const variable of cpu.env) assert.ok(env.includes(variable), `${app}: ${variable} is not in its full provisioner`);
  }
});

// SYNcro's pinned example runs through WASM SynthSR on Linux, not only on the macOS GPU job (issue #211).
test('Linux provisions SYNcro\'s pinned example for its CPU normalization', () => {
  assert.deepEqual(provisioners.syncro.cpu?.env, ['SYNCRO_AUTOMATION_IMAGE']);
});
