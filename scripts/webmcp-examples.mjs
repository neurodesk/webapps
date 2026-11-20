#!/usr/bin/env node
// Reports how every app's examples reach a browser agent's inputs_load_example, and exits 1 when an
// example would be dropped without a stated reason.
//   node scripts/webmcp-examples.mjs [--all]
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { repoRoot } from './lib/apps-registry.mjs';
import { auditAppExamples } from './lib/webmcp-examples.mjs';

const all = process.argv.includes('--all');
let failed = false;
for (const app of (await readdir(join(repoRoot, 'apps'))).sort()) {
  const audit = await auditAppExamples(app);
  failed ||= audit.problems.length > 0;
  for (const problem of audit.problems) console.log(`${app}: PROBLEM ${problem}`);
  for (const example of audit.examples) {
    if (example.unavailable) console.log(`${app}: ${example.id} unavailable: ${example.unavailable}`);
    else if (example.omitted) console.log(`${app}: ${example.id} loads ${example.loads} of ${example.of} files: ${example.omitted}`);
    else if (all) console.log(`${app}: ${example.id} loads ${example.loads} files`);
  }
}
process.exitCode = failed ? 1 : 0;
