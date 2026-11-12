#!/usr/bin/env node
// Reports what one UTC day of workflow runs cost and exits 1 when a budget in
// scripts/lib/ci-usage.mjs is exceeded, so the scheduled run fails and
// nightly-failures.yml opens an issue.
//
//   node scripts/ci-usage-report.mjs [--hours 24] [--until 2026-11-11T00:00:00Z]
//
// Without --until the window ends at the last UTC midnight. Consecutive daily
// reports then share a boundary whenever they start, so no run falls between
// two reports or into both, and every run in the window has had hours to show
// how many jobs it has. Needs an authenticated `gh`.
import { appendFile } from 'node:fs/promises';
import { budgetFindings, largeRunCandidates, summarizeUsage, usageMarkdown } from './lib/ci-usage.mjs';
import { jobCount, listAllRuns, mapLimited } from './lib/github-actions.mjs';

const argv = process.argv.slice(2);
const option = (name, fallback) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : fallback);
const hours = Number(option('--hours', 24));
const now = new Date();
const until = new Date(option('--until', new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString()));
if (!Number.isFinite(hours) || hours <= 0 || Number.isNaN(until.getTime())) throw new Error('Usage: ci-usage-report.mjs [--hours <n>] [--until <ISO time>]');
const since = new Date(until.getTime() - hours * 3600e3);

const runs = await listAllRuns({ since, until });
// A run still going has used its runners up to now, not up to the window's end.
const candidates = largeRunCandidates(runs, now.toISOString());
const counts = await mapLimited(candidates, 6, (run) => jobCount(run.id));
const usage = summarizeUsage(runs, new Map(candidates.map((run, index) => [run.id, counts[index]])), now.toISOString());
const findings = budgetFindings(usage);
const text = usageMarkdown(usage, findings, { since: since.toISOString(), until: until.toISOString() });

process.stdout.write(text);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, text);
for (const finding of findings) console.log(`::error::${finding}`);
process.exitCode = findings.length ? 1 : 0;
