#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const output = 'quality-artifacts/mutations';
const target = 'packages/nii2tvx/src/disconnectome.js';

export function summarizeMutations(report, { smoke = false } = {}) {
  if (!report || !report.files || typeof report.files !== 'object') {
    throw new Error('Stryker did not produce a mutation report');
  }
  const files = Object.entries(report.files);
  if (files.length !== 1 || files[0][0] !== target || !Array.isArray(files[0][1].mutants)) {
    throw new Error('Mutation report must contain only the pilot module');
  }
  const mutants = files[0][1].mutants;
  if (!mutants.length) throw new Error('No mutations were tested');
  const counts = { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0, Ignored: 0 };
  for (const mutant of mutants) {
    if (!(mutant.status in counts)) throw new Error(`Invalid mutant status: ${mutant.status}`);
    counts[mutant.status]++;
  }
  if (counts.RuntimeError) throw new Error('Stryker reported test runner runtime errors');
  if (smoke && !counts.Killed) throw new Error('Smoke canary did not detect any mutation');
  const assessed = counts.Killed + counts.Timeout + counts.Survived + counts.NoCoverage;
  if (!assessed) throw new Error('No mutations completed successfully');
  const score = (100 * (counts.Killed + counts.Timeout) / assessed).toFixed(2);
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'");
  const survivors = mutants.filter((mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage');
  const rows = survivors.map((mutant) => `| ${mutant.location.start.line} | ${mutant.mutatorName} | ${escape(mutant.replacement)} |`);
  return `## Mutation pilot${smoke ? ' smoke' : ''}\n\n${target}: ${score}% mutation score across ${assessed} assessed mutants.\n\nKilled: ${counts.Killed}; survived: ${counts.Survived}; uncovered: ${counts.NoCoverage}; timed out: ${counts.Timeout}; compile errors: ${counts.CompileError}; ignored: ${counts.Ignored}.\n\nScores are report-only. Configuration, baseline test and tool failures fail the job. The smoke canary must detect at least one mutation.\n\n${rows.length ? `| Line | Mutator | Surviving replacement |\n| --- | --- | --- |\n${rows.join('\n')}\n\n` : 'No surviving mutants in this run.\n\n'}The mutation-quality artifact contains the JSON report, HTML report and tool log.\n`;
}

export function runMutations({ cwd = process.cwd(), smoke = false, config = 'stryker.config.mjs', executable = process.execPath, prefix = [fileURLToPath(new URL('../node_modules/@stryker-mutator/core/bin/stryker.js', import.meta.url))], summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const artifacts = resolve(cwd, output);
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  const args = [...prefix, 'run', config];
  // A small, stable naming function provides the PR mutation-detection canary.
  if (smoke) args.push('--mutate', `${target}:10-12`);
  const env = { ...process.env };
  // Nested node:test processes must execute their suites independently.
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  writeFileSync(resolve(artifacts, 'stryker.log'), `${result.stdout ?? ''}\n${result.stderr ?? ''}`);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Stryker failed with ${result.signal ?? `exit ${result.status}`}`);
  const report = JSON.parse(readFileSync(resolve(artifacts, 'mutation.json'), 'utf8'));
  const markdown = summarizeMutations(report, { smoke });
  writeFileSync(resolve(artifacts, 'summary.md'), markdown);
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { smoke: { type: 'boolean', default: false }, config: { type: 'string', default: 'stryker.config.mjs' } } });
  try {
    runMutations(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
