#!/usr/bin/env node
// Downloads and checks the data an app's browser suite needs, then prints the
// environment that enables its data-gated tests as KEY=VALUE lines. CI appends
// the output to $GITHUB_ENV; locally, export the lines before
// `pnpm --filter <app> test:e2e`. An app without data prints nothing. With
// --cpu, only the tests a browser without a hardware GPU can finish.
//
//   node scripts/e2e-test-data.mjs <app> [cache-directory] [--cpu]
import { join, resolve } from 'node:path';
import { provisionTestData } from './lib/e2e-test-data.mjs';

const cpu = process.argv.includes('--cpu');
const [app, cacheArgument] = process.argv.slice(2).filter((argument) => argument !== '--cpu');
if (!app) {
  console.error('Usage: e2e-test-data.mjs <app> [cache-directory] [--cpu]');
  process.exit(2);
}
// fetchPinnedExample reports downloads with console.log; keep stdout for the environment.
console.log = console.error;
const cache = resolve(cacheArgument ?? join(process.env.TMPDIR ?? '.', 'neurodesk-e2e-test-data'));
for (const [key, value] of Object.entries(await provisionTestData(app, cache, { cpu }))) process.stdout.write(`${key}=${value}\n`);
