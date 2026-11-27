#!/usr/bin/env node
import { appendFileSync, readFileSync } from 'node:fs';
import { DEFAULT_BEADS_REF } from './lib/beads.mjs';
import {
  DEFAULT_WORKER_ACTOR,
  findMatchingDraftPr,
  parseRecordBeadPrItems,
  recordVerifiedBeadDraftPr,
} from './lib/beads-pr-worker.mjs';
import { assertCleanThreatDetection, discoverFirstPartyApps } from './lib/beads-safe-outputs.mjs';

function parseArgs(argv) {
  const args = {
    input: process.env.GH_AW_AGENT_OUTPUT || null,
    ref: DEFAULT_BEADS_REF,
    remote: 'origin',
    actor: DEFAULT_WORKER_ACTOR,
    defaultBranch: process.env.DEFAULT_BRANCH || 'main',
    repository: process.env.GITHUB_REPOSITORY || '',
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    dryRun: process.env.DRY_RUN === 'true',
    requireCleanDetection: false,
    detectionConclusion: process.env.GH_AW_DETECTION_CONCLUSION ?? null,
    detectionSuccess: process.env.GH_AW_DETECTION_SUCCESS ?? null,
    expectedAuthor: process.env.EXPECTED_PR_AUTHOR || 'github-actions[bot]',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--input') args.input = argv[++i];
    else if (token === '--ref') args.ref = argv[++i];
    else if (token === '--remote') args.remote = argv[++i];
    else if (token === '--actor') args.actor = argv[++i];
    else if (token === '--default-branch') args.defaultBranch = argv[++i];
    else if (token === '--repo') args.repository = argv[++i];
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--require-clean-detection') args.requireCleanDetection = true;
    else throw new Error(`Unknown option: ${token}`);
  }
  return args;
}

async function githubGetJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

async function fetchOpenPullRequests({ repository, apiUrl, token }) {
  const base = apiUrl.replace(/\/+$/, '');
  return githubGetJson(`${base}/repos/${repository}/pulls?state=open&sort=created&direction=desc&per_page=50`, token);
}

async function fetchPullRequestFiles({ repository, apiUrl, token, prNumber }) {
  const base = apiUrl.replace(/\/+$/, '');
  const files = [];
  for (let page = 1; page <= 5; page++) {
    const batch = await githubGetJson(
      `${base}/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`,
      token,
    );
    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const entry of batch) {
      if (typeof entry?.filename === 'string') files.push(entry.filename);
      if (typeof entry?.previous_filename === 'string') files.push(entry.previous_filename);
    }
    if (batch.length < 100) break;
  }
  return files;
}

function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${lines.join('\n')}\n\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.requireCleanDetection) {
    assertCleanThreatDetection({
      detectionConclusion: args.detectionConclusion,
      detectionSuccess: args.detectionSuccess,
    });
  }
  if (!args.input) {
    throw new Error('Missing --input or GH_AW_AGENT_OUTPUT path');
  }
  const raw = JSON.parse(readFileSync(args.input, 'utf8'));
  const items = parseRecordBeadPrItems(raw);
  if (items.length === 0) {
    console.log('No record_bead_pr items emitted; nothing to record.');
    writeSummary(['## Beads PR worker record', '', '- No draft PR recorded for this run.']);
    return;
  }
  if (items.length > 1) {
    throw new Error(`Expected at most 1 record_bead_pr item per run (got ${items.length})`);
  }

  const item = items[0];
  const beadId = typeof item.bead_id === 'string' ? item.bead_id.trim() : '';
  const app = typeof item.app === 'string' ? item.app.trim() : '';
  const note = typeof item.note === 'string' ? item.note.trim() : '';

  const cwd = process.cwd();
  const allowedApps = await discoverFirstPartyApps(cwd);
  if (!allowedApps.has(app)) {
    throw new Error(`App "${app}" is not a registered first-party non-upstream app`);
  }

  if (args.dryRun) {
    console.log(`Dry run: skipping remote draft PR recording for ${beadId} (apps/${app}/).`);
    writeSummary([
      '## Beads PR worker record',
      '',
      `- **Mode:** dry-run (no memory/beads writes)`,
      `- **Bead:** \`${beadId}\``,
      `- **App:** \`apps/${app}/\``,
    ]);
    return;
  }

  const token = process.env.GITHUB_TOKEN || '';
  if (!args.repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify the created draft PR');
  }

  const openPrs = await fetchOpenPullRequests({
    repository: args.repository,
    apiUrl: args.apiUrl,
    token,
  });
  const pr = findMatchingDraftPr(openPrs, {
    beadId,
    app,
    defaultBranch: args.defaultBranch,
    expectedAuthor: args.expectedAuthor,
  });
  if (!pr) {
    throw new Error(
      `No open draft PR by ${args.expectedAuthor} matching beads/${beadId}-${app} against ${args.defaultBranch} was found; refusing to update memory/beads.`,
    );
  }

  const prFiles = await fetchPullRequestFiles({
    repository: args.repository,
    apiUrl: args.apiUrl,
    token,
    prNumber: pr.number,
  });

  const result = recordVerifiedBeadDraftPr({
    cwd,
    ref: args.ref,
    remote: args.remote,
    beadId,
    app,
    pr,
    prFiles,
    note,
    actor: args.actor,
    dryRun: false,
    requireCleanDetection: args.requireCleanDetection,
    detectionConclusion: args.detectionConclusion,
    detectionSuccess: args.detectionSuccess,
  });

  console.log(
    `Recorded verified draft PR #${result.prNumber} (${result.branch}) on ${args.ref} for ${result.beadId} (${result.files.length} file(s), pushed=${result.pushed}).`,
  );
  writeSummary([
    '## Beads PR worker record',
    '',
    `- **Bead:** \`${result.beadId}\``,
    `- **App:** \`apps/${result.app}/\``,
    `- **Draft PR:** [#${result.prNumber}](${result.prUrl})`,
    `- **Branch:** \`${result.branch}\``,
    `- **Verified files:** ${result.files.map((file) => `\`${file}\``).join(', ')}`,
    `- **Pushed to \`${args.ref}\`:** ${result.pushed ? 'yes' : 'no'}`,
  ]);
}

main().catch((error) => {
  console.error(`record-bead-pr failed: ${error.message}`);
  process.exit(1);
});
