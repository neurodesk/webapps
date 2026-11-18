#!/usr/bin/env node
// Writes .github/workflows/native.yml from the workflows whose gate job lists
// shared_paths (scripts/lib/native-workflow.mjs). With --check it only fails
// when the file differs. test/workflow-gate.test.mjs runs the same check.
//
//   node scripts/native-workflow.mjs [--check]
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './lib/apps-registry.mjs';
import { dispatchedWorkflows, renderNativeWorkflow } from './lib/native-workflow.mjs';

const file = join(repoRoot, '.github/workflows/native.yml');
const text = renderNativeWorkflow(await dispatchedWorkflows(repoRoot));
if (process.argv.includes('--check')) {
  const current = await readFile(file, 'utf8').catch(() => '');
  if (current !== text) {
    console.error('.github/workflows/native.yml is out of date: run node scripts/native-workflow.mjs');
    process.exitCode = 1;
  }
} else {
  await writeFile(file, text);
}
