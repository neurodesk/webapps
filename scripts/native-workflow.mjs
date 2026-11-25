#!/usr/bin/env node
// Writes .github/workflows/native.yml (and native-2.yml, ... when sharded) from
// the workflows whose gate job lists shared_paths (scripts/lib/native-workflow.mjs).
// With --check it only fails when any dispatcher file differs or is stale.
// test/workflow-gate.test.mjs runs the same check.
//
//   node scripts/native-workflow.mjs [--check]
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './lib/apps-registry.mjs';
import { dispatchedWorkflows, renderNativeWorkflows } from './lib/native-workflow.mjs';
import { isDispatcher } from './lib/workflow-gate.mjs';

const workflowsDir = join(repoRoot, '.github/workflows');
const expected = renderNativeWorkflows(await dispatchedWorkflows(repoRoot));
const existing = (await readdir(workflowsDir))
  .filter((file) => file.endsWith('.yml') && isDispatcher(file.slice(0, -'.yml'.length)))
  .map((file) => file.slice(0, -'.yml'.length))
  .sort();

if (process.argv.includes('--check')) {
  let stale = false;
  for (const [name, text] of expected) {
    const file = join(workflowsDir, `${name}.yml`);
    const current = await readFile(file, 'utf8').catch(() => '');
    if (current !== text) {
      console.error(`.github/workflows/${name}.yml is out of date: run node scripts/native-workflow.mjs`);
      stale = true;
    }
  }
  for (const name of existing) {
    if (!expected.has(name)) {
      console.error(`.github/workflows/${name}.yml is obsolete: run node scripts/native-workflow.mjs`);
      stale = true;
    }
  }
  if (stale) process.exitCode = 1;
} else {
  for (const [name, text] of expected) {
    await writeFile(join(workflowsDir, `${name}.yml`), text);
  }
  for (const name of existing) {
    if (!expected.has(name)) {
      await rm(join(workflowsDir, `${name}.yml`), { force: true });
    }
  }
}
