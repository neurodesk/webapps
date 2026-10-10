#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

export function summarize(report) {
  if (!report || !Array.isArray(report.issues)) {
    throw new Error('Knip did not produce its expected JSON report');
  }
  const findings = [];
  for (const issue of report.issues) {
    if (typeof issue.file !== 'string') throw new Error('Invalid Knip issue file');
    for (const kind of ['files', 'exports', 'types', 'duplicates', 'dependencies', 'devDependencies']) {
      if (!Array.isArray(issue[kind])) throw new Error(`Invalid Knip ${kind} report`);
      for (const item of issue[kind]) findings.push({ file: issue.file, kind, name: item.name ?? item.symbol ?? '', line: item.line });
    }
  }
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'");
  const rows = findings.slice(0, 100).map(({ file, kind, name, line }) => `| ${escape(file)}${line ? `:${line}` : ''} | ${kind} | ${escape(name)} |`);
  return `## Unused code candidates\n\nKnip found ${findings.length} candidates. Findings are report-only and require review before deletion. Public exports, runtime-loaded assets and upstream copies need particular care.\n\n| File | Kind | Symbol |\n| --- | --- | --- |\n${rows.join('\n')}\n\n${findings.length > 100 ? 'The summary shows the first 100 candidates. ' : ''}Download the unused-code artifact for the complete JSON report and scan diagnostics.\n`;
}

export function runReport({ cwd = process.cwd(), config = 'knip.config.mjs', output = 'quality-artifacts/unused-code', executable = process.execPath, prefix = [fileURLToPath(new URL('../node_modules/knip/bin/knip.js', import.meta.url))], summary = process.env.GITHUB_STEP_SUMMARY } = {}) {
  mkdirSync(output, { recursive: true });
  // --no-exit-code suppresses findings only. Configuration failures and crashes still fail.
  const result = spawnSync(executable, [...prefix, '--config', config, '--reporter', 'json', '--no-exit-code'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(resolve(output, 'diagnostics.log'), result.stderr ?? '');
  writeFileSync(resolve(output, 'knip.json'), result.stdout ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Knip failed with ${result.signal ?? `exit ${result.status}`}: ${result.stderr}`);
  const markdown = summarize(JSON.parse(result.stdout));
  writeFileSync(resolve(output, 'summary.md'), markdown);
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
  if (result.stderr) console.error(result.stderr);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { config: { type: 'string', default: 'knip.config.mjs' }, output: { type: 'string', default: 'quality-artifacts/unused-code' } } });
  try {
    runReport(values);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
