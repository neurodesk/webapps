#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { moduleById, modules, output, smoke as smokeTarget } from './lib/mutation-modules.mjs';

function countStatuses(file, mutants) {
  if (!mutants.length) throw new Error(`No mutations were tested in ${file}`);
  const counts = { Killed: 0, Survived: 0, NoCoverage: 0, Timeout: 0, CompileError: 0, RuntimeError: 0, Ignored: 0 };
  for (const mutant of mutants) {
    if (!(mutant.status in counts)) throw new Error(`Invalid mutant status: ${mutant.status}`);
    counts[mutant.status]++;
  }
  if (counts.RuntimeError) throw new Error(`Stryker reported test runner runtime errors in ${file}`);
  const assessed = counts.Killed + counts.Timeout + counts.Survived + counts.NoCoverage;
  if (!assessed) throw new Error(`No mutations completed successfully in ${file}`);
  return { ...counts, assessed, score: (100 * (counts.Killed + counts.Timeout) / assessed).toFixed(2) };
}

export function summarizeMutations(report, { smoke = false, expected = smoke ? [moduleById(smokeTarget.module).file] : modules.map((module) => module.file) } = {}) {
  if (!report || !report.files || typeof report.files !== 'object') {
    throw new Error('Stryker did not produce a mutation report');
  }
  const files = Object.entries(report.files);
  const names = files.map(([file]) => file).sort();
  if (names.join('\n') !== [...expected].sort().join('\n') || files.some(([, file]) => !Array.isArray(file.mutants))) {
    throw new Error(`Mutation report must contain exactly the configured modules: ${expected.join(', ')}`);
  }
  const results = files.map(([file, { mutants }]) => ({ file, mutants, counts: countStatuses(file, mutants) }));
  if (smoke && !results.some(({ counts }) => counts.Killed)) throw new Error('Smoke canary did not detect any mutation');
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'");
  const totals = results.map(({ file, counts }) => `| ${file} | ${counts.score}% | ${counts.assessed} | ${counts.Killed} | ${counts.Survived} | ${counts.NoCoverage} | ${counts.Timeout} | ${counts.CompileError} | ${counts.Ignored} |`);
  const survivors = results.flatMap(({ file, mutants }) => mutants
    .filter((mutant) => mutant.status === 'Survived' || mutant.status === 'NoCoverage')
    .map((mutant) => `| ${file} | ${mutant.location.start.line} | ${mutant.mutatorName} | ${escape(mutant.replacement)} |`));
  return `## Mutation testing${smoke ? ' smoke' : ''}\n\n| Module | Score | Assessed | Killed | Survived | Uncovered | Timed out | Compile errors | Ignored |\n| --- | --- | --- | --- | --- | --- | --- | --- | --- |\n${totals.join('\n')}\n\nScores are report-only. Configuration, baseline test and tool failures fail the job. The smoke canary must detect at least one mutation.\n\n${survivors.length ? `| Module | Line | Mutator | Surviving replacement |\n| --- | --- | --- | --- |\n${survivors.join('\n')}\n\n` : 'No surviving mutants in this run.\n\n'}docs/quality/mutation-testing.md explains the reviewed survivors. The mutation-quality artifact contains the JSON and HTML report of each module and the tool log.\n`;
}

export function runMutations({ cwd = process.cwd(), smoke = false, config = 'stryker.config.mjs', executable = process.execPath, prefix = [fileURLToPath(new URL('../node_modules/@stryker-mutator/core/bin/stryker.js', import.meta.url))], summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  const artifacts = resolve(cwd, output);
  rmSync(artifacts, { recursive: true, force: true });
  mkdirSync(artifacts, { recursive: true });
  // A small, stable naming function provides the PR mutation-detection canary.
  const runs = smoke ? [{ id: smokeTarget.module, mutate: smokeTarget.mutate }] : modules.map(({ id }) => ({ id }));
  const merged = { files: {} };
  let log = '';
  for (const { id, mutate } of runs) {
    const args = [...prefix, 'run', config];
    if (mutate) args.push('--mutate', mutate);
    // Stryker kills a timed-out suite before its cleanup hooks run, so each run's
    // temporary files go to a directory removed here, whatever the suites left.
    const scratch = mkdtempSync(join(tmpdir(), `mutation-${id}-`));
    const env = { ...process.env, MUTATION_MODULE: id, TMPDIR: scratch, TMP: scratch, TEMP: scratch };
    // Nested node:test processes must execute their suites independently.
    delete env.NODE_TEST_CONTEXT;
    let result;
    try {
      result = spawnSync(executable, args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
    log += `### ${id}\n${result.stdout ?? ''}\n${result.stderr ?? ''}\n`;
    writeFileSync(resolve(artifacts, 'stryker.log'), log);
    if (result.stdout) console.log(result.stdout);
    if (result.stderr) console.error(result.stderr);
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`Stryker failed for ${id} with ${result.signal ?? `exit ${result.status}`}`);
    const report = JSON.parse(readFileSync(resolve(artifacts, id, 'mutation.json'), 'utf8'));
    if (!report || !report.files || typeof report.files !== 'object') throw new Error(`Stryker did not produce a mutation report for ${id}`);
    for (const [file, data] of Object.entries(report.files)) {
      if (file in merged.files) throw new Error(`${file} was mutated by more than one module`);
      merged.files[file] = data;
    }
  }
  const markdown = summarizeMutations(merged, { smoke });
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
