import { appendFile } from 'node:fs/promises';
import { createGitHubClient } from './lib/nightly-failures.mjs';
import { approvalReport, publishApprovalReport } from './lib/ci-approvals.mjs';

const repository = process.env.GITHUB_REPOSITORY;
const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN;
if (!token) throw new Error('GH_TOKEN or GITHUB_TOKEN is required');
if (process.argv.slice(2).some(arg => arg !== '--dry-run')) throw new Error('Only --dry-run is supported');
const client = createGitHubClient({ token, repository });
const report = await approvalReport(client, repository);
console.log(report.body);
if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, `${report.body}\n`);
if (!process.argv.includes('--dry-run')) await publishApprovalReport(client, report);
