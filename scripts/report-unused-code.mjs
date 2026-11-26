#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const KINDS = ['files', 'exports', 'types', 'duplicates', 'dependencies', 'devDependencies'];
const normalizePath = (value) => String(value).replaceAll('\\', '/');

export function extractFindings(report) {
  if (!report || !Array.isArray(report.issues)) {
    throw new Error('Knip did not produce its expected JSON report');
  }
  const findings = [];
  for (const issue of report.issues) {
    if (!issue || typeof issue.file !== 'string') throw new Error('Invalid Knip issue file');
    for (const kind of KINDS) {
      if (!Array.isArray(issue[kind])) throw new Error(`Invalid Knip ${kind} report`);
      for (const item of issue[kind]) {
        const symbols = kind === 'duplicates' ? item : [item];
        if (!Array.isArray(symbols) || symbols.length === 0 || symbols.some((symbol) => !symbol || Array.isArray(symbol) || typeof symbol.name !== 'string')) {
          throw new Error(`Invalid Knip ${kind} issue item`);
        }
        findings.push({
          file: normalizePath(issue.file),
          kind,
          name: symbols.map((symbol) => symbol.name).join(', '),
          line: symbols[0].line,
        });
      }
    }
  }
  return findings;
}

export function upstreamAppPrefixes(cwd) {
  const appsDir = join(cwd, 'apps');
  const prefixes = new Set();
  if (!existsSync(appsDir)) return prefixes;
  for (const entry of readdirSync(appsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (existsSync(join(appsDir, entry.name, 'upstream.json'))) {
      prefixes.add(`apps/${entry.name}/`);
    }
  }
  return prefixes;
}

// High-confidence ratchet scope: unused files in owned first-party code only.
// Exports, types, duplicates, dependencies and upstream-tracked apps remain report-only.
export function ratchetedFindings(findings, { cwd = process.cwd() } = {}) {
  const upstream = upstreamAppPrefixes(cwd);
  return findings
    .filter((finding) => finding.kind === 'files')
    .map(({ file, kind, name }) => ({
      file: normalizePath(file),
      kind,
      name: normalizePath(name),
    }))
    .filter((finding) => ![...upstream].some((prefix) => finding.file.startsWith(prefix)));
}

// Identity excludes line numbers so moving declarations never churns baseline entries.
export function findingKey({ file, kind, name }) {
  return JSON.stringify([
    normalizePath(file),
    kind,
    kind === 'files' ? normalizePath(name) : name,
  ]);
}

export function compareUnusedBaseline(findings, baseline) {
  if (!Array.isArray(baseline)) throw new Error('Unused-code baseline must be a JSON array.');
  for (const entry of baseline) {
    if (!entry || typeof entry.file !== 'string' || typeof entry.kind !== 'string' || typeof entry.name !== 'string') {
      throw new Error('Every unused-code baseline entry must specify file, kind and name.');
    }
    if (!entry.reason?.trim()) {
      throw new Error(`Every unused-code baseline entry needs a specific reason (${entry.file}).`);
    }
  }
  const actualByKey = new Map();
  for (const finding of findings) actualByKey.set(findingKey(finding), finding);
  const baselineByKey = new Map();
  for (const entry of baseline) {
    const key = findingKey(entry);
    if (baselineByKey.has(key)) throw new Error(`Duplicate unused-code baseline entry: ${entry.file} (${entry.kind}: ${entry.name})`);
    baselineByKey.set(key, entry);
  }
  const added = [...actualByKey.entries()].filter(([key]) => !baselineByKey.has(key)).map(([, finding]) => finding);
  const stale = [...baselineByKey.entries()].filter(([key]) => !actualByKey.has(key)).map(([, entry]) => entry);
  return { added, stale };
}

export function summarize(report, diagnostics = '', ratchet = null) {
  const findings = extractFindings(report);
  const escape = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ').replaceAll('`', "'");
  const diagnosticLines = diagnostics.trim().split('\n').filter(Boolean);
  const warnings = diagnosticLines.length ? `\nScan diagnostics (${diagnosticLines.length} lines; review for incomplete analysis):\n\n${diagnosticLines.slice(0, 10).map((line) => `- ${escape(line)}`).join('\n')}\n` : '';
  const rows = findings.slice(0, 100).map(({ file, kind, name, line }) => `| ${escape(file)}${line ? `:${line}` : ''} | ${kind} | ${escape(name)} |`);
  const ratchetNote = ratchet
    ? `First-party unused files are ratcheted against the baseline (${ratchet.checked} current, ${ratchet.added.length} new, ${ratchet.stale.length} stale); exports, types, duplicates, dependencies and upstream-tracked apps remain report-only.`
    : 'Findings are report-only and require review before deletion. Public exports, runtime-loaded assets and upstream copies need particular care.';
  return `## Unused code candidates\n\nKnip found ${findings.length} candidates. ${ratchetNote}\n\n| File | Kind | Symbol |\n| --- | --- | --- |\n${rows.join('\n')}\n\n${findings.length > 100 ? 'The summary shows the first 100 candidates. ' : ''}Download the unused-code artifact for the complete JSON report and scan diagnostics.\n${warnings}`;
}

export function runReport({
  cwd = process.cwd(),
  config = 'knip.config.mjs',
  output = 'quality-artifacts/unused-code',
  baseline = 'config/unused-code-baseline.json',
  executable = process.execPath,
  prefix = [fileURLToPath(new URL('../node_modules/knip/bin/knip.js', import.meta.url))],
  summary = process.env.GITHUB_STEP_SUMMARY,
} = {}) {
  output = resolve(cwd, output);
  mkdirSync(output, { recursive: true });
  // --no-exit-code suppresses findings only. Configuration failures and crashes still fail.
  const result = spawnSync(executable, [...prefix, '--config', config, '--reporter', 'json', '--no-exit-code'], { cwd, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  writeFileSync(resolve(output, 'diagnostics.log'), result.stderr ?? '');
  writeFileSync(resolve(output, 'knip.json'), result.stdout ?? '');
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Knip failed with ${result.signal ?? `exit ${result.status}`}: ${result.stderr}`);
  const parsed = JSON.parse(result.stdout);
  const findings = extractFindings(parsed);
  let ratchet = null;
  if (baseline) {
    const baselinePath = resolve(cwd, baseline);
    const baselineEntries = JSON.parse(readFileSync(baselinePath, 'utf8'));
    const scoped = ratchetedFindings(findings, { cwd });
    const { added, stale } = compareUnusedBaseline(scoped, baselineEntries);
    ratchet = { baseline: baselinePath, checked: scoped.length, added, stale };
  }
  const markdown = summarize(parsed, result.stderr, ratchet);
  writeFileSync(resolve(output, 'summary.md'), markdown);
  if (summary) appendFileSync(summary, markdown);
  console.log(markdown);
  if (result.stderr) console.error(result.stderr);
  if (ratchet && (ratchet.added.length || ratchet.stale.length)) {
    const lines = [];
    if (ratchet.added.length) {
      lines.push(`New unused first-party files (${ratchet.added.length}): ${ratchet.added.map((entry) => entry.file).join(', ')}`);
    }
    if (ratchet.stale.length) {
      lines.push(`Resolved unused-code baseline entries (${ratchet.stale.length}); remove from ${baseline}: ${ratchet.stale.map((entry) => entry.file).join(', ')}`);
    }
    throw new Error(lines.join('\n'));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', default: 'knip.config.mjs' },
      output: { type: 'string', default: 'quality-artifacts/unused-code' },
      baseline: { type: 'string', default: 'config/unused-code-baseline.json' },
    },
  });
  try {
    runReport({ ...values, baseline: values.baseline || null });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
