#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DEFAULT_BEADS_REF, readBeadsFromRef } from './lib/beads.mjs';
import {
  DEFAULT_MAX_OPEN_WORKER_PRS,
  DEFAULT_RECENT_CLOSED_DAYS,
  assertTrustedAppDir,
  fetchWorkerPullRequests,
  selectBeadForPullRequest,
} from './lib/beads-pr-worker.mjs';
import { discoverFirstPartyApps } from './lib/beads-safe-outputs.mjs';

function parseArgs(argv) {
  const args = {
    ref: DEFAULT_BEADS_REF,
    beadId: process.env.BEAD_ID || '',
    dryRun: process.env.DRY_RUN === 'true',
    maxOpenPrs: Number(process.env.MAX_OPEN_WORKER_PRS || DEFAULT_MAX_OPEN_WORKER_PRS),
    recentClosedDays: Number(process.env.RECENT_CLOSED_DAYS || DEFAULT_RECENT_CLOSED_DAYS),
    output: 'quality-artifacts/beads-worker/selected-bead.json',
    prsFile: null,
    repository: process.env.GITHUB_REPOSITORY || '',
    apiUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
    defaultBranch: process.env.DEFAULT_BRANCH || 'main',
    githubRef: process.env.GITHUB_REF || '',
  };
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--ref') args.ref = argv[++i];
    else if (token === '--bead-id') args.beadId = argv[++i] ?? '';
    else if (token === '--dry-run') args.dryRun = true;
    else if (token === '--max-open-prs') args.maxOpenPrs = Number(argv[++i]);
    else if (token === '--recent-closed-days') args.recentClosedDays = Number(argv[++i]);
    else if (token === '--output') args.output = argv[++i];
    else if (token === '--prs-file') args.prsFile = argv[++i];
    else if (token === '--repo') args.repository = argv[++i];
    else if (token === '--default-branch') args.defaultBranch = argv[++i];
    else throw new Error(`Unknown option: ${token}`);
  }
  if (!Number.isSafeInteger(args.maxOpenPrs) || args.maxOpenPrs < 1 || args.maxOpenPrs > 10) {
    throw new Error(`--max-open-prs must be an integer between 1 and 10 (got ${args.maxOpenPrs})`);
  }
  if (!Number.isSafeInteger(args.recentClosedDays) || args.recentClosedDays < 0 || args.recentClosedDays > 365) {
    throw new Error(`--recent-closed-days must be an integer between 0 and 365 (got ${args.recentClosedDays})`);
  }
  return args;
}

function writeGithubOutput(values) {
  const outPath = process.env.GITHUB_OUTPUT;
  if (!outPath) return;
  const lines = Object.entries(values).map(([key, value]) => `${key}=${String(value ?? '')}`);
  appendFileSync(outPath, `${lines.join('\n')}\n`, 'utf8');
}

function writeStepSummary(payload) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  const lines = [
    '## Beads PR worker selection',
    '',
    `- **Selected:** ${payload.selected ? 'yes' : 'no'}`,
    `- **Dry run:** ${payload.dryRun ? 'yes' : 'no'}`,
    `- **Open worker PRs:** ${payload.openWorkerPrCount}/${payload.maxOpenPrs}`,
  ];
  if (payload.selected) {
    lines.push(
      `- **Bead:** \`${payload.bead.id}\` (rev ${payload.bead.revision}, P${payload.bead.priority})`,
      `- **App:** \`apps/${payload.app}/\``,
      `- **Branch:** \`${payload.branch}\``,
      `- **Title:** ${payload.bead.title}`,
    );
  } else {
    lines.push(`- **Reason:** ${payload.reason}`);
  }
  appendFileSync(summaryPath, `${lines.join('\n')}\n\n`, 'utf8');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cwd = process.cwd();
  const baseSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();

  // Refuse to select a bead when dispatched from a non-default ref.
  if (args.githubRef && args.githubRef !== `refs/heads/${args.defaultBranch}`) {
    throw new Error(
      `Refusing to run beads-pr-worker outside default branch refs/heads/${args.defaultBranch} (got ${args.githubRef})`,
    );
  }

  const allowedApps = await discoverFirstPartyApps(cwd);
  const { beads } = readBeadsFromRef(cwd, args.ref);

  let existingPullRequests = [];
  if (args.prsFile) {
    existingPullRequests = JSON.parse(readFileSync(args.prsFile, 'utf8'));
  } else if (args.repository && process.env.GITHUB_TOKEN) {
    existingPullRequests = await fetchWorkerPullRequests({
      repository: args.repository,
      apiUrl: args.apiUrl,
      token: process.env.GITHUB_TOKEN,
      recentClosedDays: args.recentClosedDays,
    });
  }

  let selection = selectBeadForPullRequest({
    beads,
    allowedApps,
    existingPullRequests,
    beadId: args.beadId,
    maxOpenPrs: args.maxOpenPrs,
    recentClosedDays: args.recentClosedDays,
  });

  if (selection.selected) {
    try {
      assertTrustedAppDir(cwd, selection.app);
    } catch (error) {
      selection = {
        ...selection,
        selected: false,
        reason: `Selected app directory failed containment check: ${error.message}`,
        bead: null,
        app: null,
        branch: null,
      };
    }
  }

  const payload = {
    selected: selection.selected,
    reason: selection.reason,
    dryRun: args.dryRun,
    baseSha,
    openWorkerPrCount: selection.openWorkerPrCount,
    maxOpenPrs: selection.maxOpenPrs,
    app: selection.app,
    branch: selection.branch,
    bead: selection.bead
      ? {
          id: selection.bead.id,
          revision: selection.bead.revision,
          priority: selection.bead.priority,
          kind: selection.bead.kind,
          dedupeKey: selection.bead.dedupeKey,
          title: selection.bead.title,
          summary: selection.bead.summary,
          scope: selection.bead.scope,
          links: selection.bead.links,
          journal: selection.bead.journal,
        }
      : null,
  };

  const outPath = resolve(cwd, args.output);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');

  writeGithubOutput({
    selected: payload.selected ? 'true' : 'false',
    bead_id: payload.bead?.id ?? '',
    app: payload.app ?? '',
    branch: payload.branch ?? '',
  });
  writeStepSummary(payload);

  if (payload.selected) {
    console.log(`Selected ${payload.bead.id} (apps/${payload.app}/, branch ${payload.branch})`);
  } else {
    console.log(`No bead selected: ${payload.reason}`);
  }
}

main().catch((error) => {
  console.error(`select-bead-for-pr failed: ${error.message}`);
  process.exit(1);
});
