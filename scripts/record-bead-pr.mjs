#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { DEFAULT_BEADS_REF } from './lib/beads.mjs';
import {
  DEFAULT_WORKER_ACTOR,
  closeViolatingPullRequest,
  fetchPullRequestByNumber,
  fetchPullRequestFiles,
  matchesWorkerBranchForBead,
  recordVerifiedBeadDraftPr,
  validatePackageJsonDiff,
  validateWorkerChangedFiles,
  verifyRegeneratedLockfile,
} from './lib/beads-pr-worker.mjs';
import { assertCleanThreatDetection, discoverFirstPartyApps } from './lib/beads-safe-outputs.mjs';

function parseArgs(argv) {
  const args = {
    selection: process.env.SELECTION_ARTIFACT || 'quality-artifacts/beads-worker/selected-bead.json',
    prNumber: process.env.CREATED_PR_NUMBER ? Number(process.env.CREATED_PR_NUMBER) : null,
    ref: DEFAULT_BEADS_REF,
    remote: 'origin',
    actor: DEFAULT_WORKER_ACTOR,
    defaultBranch: process.env.DEFAULT_BRANCH || 'main',
    githubRef: process.env.GITHUB_REF || '',
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
    if (token === '--selection') args.selection = argv[++i];
    else if (token === '--pr-number') args.prNumber = Number(argv[++i]);
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

function writeSummary(lines) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  appendFileSync(summaryPath, `${lines.join('\n')}\n\n`, 'utf8');
}

function fetchCommitObject(cwd, remote, sha) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) {
    throw new Error(`Invalid commit SHA "${sha}"`);
  }
  execFileSync('git', ['fetch', '--no-tags', '--depth=1', remote, sha], { cwd, stdio: 'pipe' });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!Number.isSafeInteger(args.prNumber) || args.prNumber <= 0) {
    console.log('No created PR number supplied; nothing to verify or record.');
    writeSummary(['## Beads PR worker verification', '', '- No pull request was created by this run.']);
    return;
  }

  const token = process.env.GITHUB_TOKEN || '';
  if (!args.repository || !token) {
    throw new Error('GITHUB_REPOSITORY and GITHUB_TOKEN are required to verify the created draft PR');
  }

  const cwd = process.cwd();
  let failureReason = null;

  try {
    if (args.githubRef && args.githubRef !== `refs/heads/${args.defaultBranch}`) {
      throw new Error(
        `PR #${args.prNumber} was opened outside exact default branch refs/heads/${args.defaultBranch} (got ${args.githubRef})`,
      );
    }
    if (args.dryRun) {
      throw new Error(`PR #${args.prNumber} was unexpectedly created while dry_run=true`);
    }
    if (args.requireCleanDetection) {
      assertCleanThreatDetection({
        detectionConclusion: args.detectionConclusion,
        detectionSuccess: args.detectionSuccess,
      });
    }

    const selection = JSON.parse(readFileSync(resolve(cwd, args.selection), 'utf8'));
    if (!selection || selection.selected !== true || !selection.bead?.id || !selection.app) {
      throw new Error(
        `PR #${args.prNumber} was opened even though immutable pre-selection chose no bead (${selection?.reason ?? 'missing selection'})`,
      );
    }

    const allowedApps = await discoverFirstPartyApps(cwd);
    const pr = await fetchPullRequestByNumber({
      repository: args.repository,
      apiUrl: args.apiUrl,
      token,
      prNumber: args.prNumber,
    });
    const { filenames: prFiles, previousFilenames: prPreviousFiles } = await fetchPullRequestFiles({
      repository: args.repository,
      apiUrl: args.apiUrl,
      token,
      prNumber: args.prNumber,
    });

    const app = selection.app;
    const beadId = selection.bead.id;
    if (!allowedApps.has(app)) {
      throw new Error(`Selected app "${app}" is not a registered first-party non-upstream app`);
    }
    if (!pr.draft || String(pr.state).toLowerCase() !== 'open') {
      throw new Error(`PR #${args.prNumber} must be an open draft PR (state=${pr.state}, draft=${pr.draft})`);
    }
    if (pr.base?.ref !== args.defaultBranch) {
      throw new Error(`PR #${args.prNumber} base branch "${pr.base?.ref}" must be "${args.defaultBranch}"`);
    }
    if (args.expectedAuthor && pr.user?.login !== args.expectedAuthor) {
      throw new Error(`PR #${args.prNumber} author "${pr.user?.login}" does not match expected "${args.expectedAuthor}"`);
    }
    if (!matchesWorkerBranchForBead(pr.head?.ref, beadId, app)) {
      throw new Error(`PR #${args.prNumber} branch "${pr.head?.ref}" does not match selected bead ${beadId} (${app})`);
    }

    const scopeCheck = validateWorkerChangedFiles(prFiles, { app, previousFiles: prPreviousFiles });
    if (!scopeCheck.valid) {
      throw new Error(`PR #${args.prNumber} violates single-app scope for ${app}: ${scopeCheck.violations.join('; ')}`);
    }

    const appPkg = `apps/${app}/package.json`;
    const touchesPkg = scopeCheck.files.includes(appPkg);
    const touchesLock = scopeCheck.files.includes('pnpm-lock.yaml');

    if (touchesPkg || touchesLock) {
      const baseSha = pr.base?.sha || selection.baseSha;
      const headSha = pr.head?.sha;
      if (!baseSha || !headSha) {
        throw new Error(`PR #${args.prNumber} is missing base or head SHA for manifest verification`);
      }
      fetchCommitObject(cwd, args.remote, baseSha);
      fetchCommitObject(cwd, args.remote, headSha);
      const currentHead = execFileSync('git', ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8' }).trim();
      if (currentHead !== baseSha) {
        execFileSync('git', ['checkout', '--detach', baseSha], { cwd, stdio: 'pipe' });
      }

      if (touchesLock) {
        // Verifies both apps/<app>/package.json policy AND byte-for-byte pnpm-lock.yaml regeneration.
        verifyRegeneratedLockfile({ cwd, baseSha, headSha, app });
      } else if (touchesPkg) {
        const basePkg = execFileSync('git', ['show', `${baseSha}:${appPkg}`], { cwd, encoding: 'utf8' });
        const headPkg = execFileSync('git', ['show', `${headSha}:${appPkg}`], { cwd, encoding: 'utf8' });
        const pkgCheck = validatePackageJsonDiff(basePkg, headPkg);
        if (!pkgCheck.valid) {
          throw new Error(`${appPkg} policy violation: ${pkgCheck.violations.join('; ')}`);
        }
      }
    }

    const result = recordVerifiedBeadDraftPr({
      cwd,
      ref: args.ref,
      remote: args.remote,
      selection,
      allowedApps,
      pr,
      prFiles,
      prPreviousFiles,
      defaultBranch: args.defaultBranch,
      expectedAuthor: args.expectedAuthor,
      actor: args.actor,
      dryRun: false,
      requireCleanDetection: args.requireCleanDetection,
      detectionConclusion: args.detectionConclusion,
      detectionSuccess: args.detectionSuccess,
    });

    console.log(
      `Verified and recorded draft PR #${result.prNumber} (${result.branch}) on ${args.ref} for ${result.beadId} (${result.files.length} file(s), pushed=${result.pushed}).`,
    );
    writeSummary([
      '## Beads PR worker verification & record',
      '',
      `- **Status:** verified and recorded`,
      `- **Bead:** \`${result.beadId}\``,
      `- **App:** \`apps/${result.app}/\``,
      `- **Draft PR:** [#${result.prNumber}](${result.prUrl})`,
      `- **Branch:** \`${result.branch}\``,
      `- **Verified files:** ${result.files.map((file) => `\`${file}\``).join(', ')}`,
      `- **Pushed to \`${args.ref}\`:** ${result.pushed ? 'yes' : 'no'}`,
    ]);
    return;
  } catch (error) {
    failureReason = error.message;
  }

  // Fail closed: close any violating PR so it never remains open for merge.
  console.error(`Verification failed for PR #${args.prNumber}: ${failureReason}`);
  try {
    await closeViolatingPullRequest({
      repository: args.repository,
      apiUrl: args.apiUrl,
      token,
      prNumber: args.prNumber,
      reason: failureReason,
    });
    console.error(`Closed violating PR #${args.prNumber}.`);
    writeSummary([
      '## Beads PR worker verification & record',
      '',
      `- **Status:** FAILED — closed PR #${args.prNumber}`,
      `- **Reason:** ${failureReason}`,
    ]);
  } catch (closeError) {
    console.error(`Failed to close violating PR #${args.prNumber}: ${closeError.message}`);
    writeSummary([
      '## Beads PR worker verification & record',
      '',
      `- **Status:** FAILED (could not auto-close PR #${args.prNumber}: ${closeError.message})`,
      `- **Reason:** ${failureReason}`,
    ]);
  }
  process.exit(1);
}

main().catch((error) => {
  console.error(`record-bead-pr failed: ${error.message}`);
  process.exit(1);
});
