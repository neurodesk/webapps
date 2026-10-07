#!/usr/bin/env node
// Downloads and checks the data an app's browser suite needs, then prints the
// environment that enables its data-gated tests as KEY=VALUE lines. CI appends
// the output to $GITHUB_ENV; locally, export the lines before
// `pnpm --filter <app> test:e2e`. An app without data prints nothing.
//
//   node scripts/e2e-test-data.mjs <app> [cache-directory]
import { join, resolve } from 'node:path';
import { provisionTestData } from './lib/e2e-test-data.mjs';

const [app, cacheArgument] = process.argv.slice(2);
if (!app) {
  console.error('Usage: e2e-test-data.mjs <app> [cache-directory]');
  process.exit(2);
}
// fetchPinnedExample reports downloads with console.log; keep stdout for the environment.
console.log = console.error;
const cache = resolve(cacheArgument ?? join(process.env.TMPDIR ?? '.', 'neurodesk-e2e-test-data'));
for (const [key, value] of Object.entries(await provisionTestData(app, cache))) process.stdout.write(`${key}=${value}\n`);
