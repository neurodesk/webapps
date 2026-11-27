import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';
import {
  DEFAULT_BEADS_REF,
  mutateBeadsRef,
  readBeadsFromRef,
  syncBeadsRef,
} from '../scripts/lib/beads.mjs';
import {
  buildWorkerBranchName,
  extractBeadIdFromBranch,
  findMatchingDraftPr,
  matchesWorkerBranchForBead,
  parseRecordBeadPrItems,
  recordVerifiedBeadDraftPr,
  selectBeadForPullRequest,
  validateWorkerChangedFiles,
} from '../scripts/lib/beads-pr-worker.mjs';

const GIT_IDENTITY = {
  GIT_AUTHOR_NAME: 'Test Runner',
  GIT_AUTHOR_EMAIL: 'test@neurodesk.local',
  GIT_COMMITTER_NAME: 'Test Runner',
  GIT_COMMITTER_EMAIL: 'test@neurodesk.local',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_CONFIG_PARAMETERS: "'user.useConfigOnly=true'",
};

function git(args, cwd) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...GIT_IDENTITY },
  }).trim();
}

function makeBead(overrides = {}) {
  return {
    schemaVersion: 1,
    id: 'bd-11111111',
    revision: 1,
    stateRevision: 1,
    title: 'Remove unused dep',
    summary: 'Verified unused dependency',
    kind: 'maintenance',
    status: 'open',
    priority: 3,
    scope: { type: 'app', targets: ['deconvolution'] },
    dedupeKey: 'knip:apps/deconvolution/package.json:jsdom',
    deps: { blockedBy: [], parent: null, discoveredFrom: null },
    links: { evidence: ['apps/deconvolution/package.json'] },
    lease: null,
    releasedLeases: [],
    leaseFloorAt: null,
    journal: [],
    createdAt: '2026-11-27T05:00:00.000Z',
    updatedAt: '2026-11-27T05:00:00.000Z',
    stateUpdatedAt: '2026-11-27T05:00:00.000Z',
    lastSeenAt: '2026-11-27T05:00:00.000Z',
    closedAt: null,
    reopenedAt: null,
    closeReason: null,
    ...overrides,
  };
}

test('worker branch naming and matching handle exact and gh-aw salted branch names', () => {
  assert.equal(buildWorkerBranchName('bd-7a37cab9', 'deconvolution'), 'beads/bd-7a37cab9-deconvolution');
  assert.equal(extractBeadIdFromBranch('beads/bd-7a37cab9-deconvolution'), 'bd-7a37cab9');
  assert.equal(extractBeadIdFromBranch('beads/bd-7a37cab9-deconvolution-a1b2c3d4'), 'bd-7a37cab9');
  assert.equal(extractBeadIdFromBranch('t3/something-else'), null);

  assert.equal(matchesWorkerBranchForBead('beads/bd-7a37cab9-deconvolution', 'bd-7a37cab9', 'deconvolution'), true);
  assert.equal(matchesWorkerBranchForBead('beads/bd-7a37cab9-deconvolution-f09e8d7c', 'bd-7a37cab9', 'deconvolution'), true);
  assert.equal(matchesWorkerBranchForBead('beads/bd-7a37cab9-stardist', 'bd-7a37cab9', 'deconvolution'), false);
  assert.equal(matchesWorkerBranchForBead('beads/bd-7a37cab9-deconvolution/extra', 'bd-7a37cab9', 'deconvolution'), false);
});

test('selectBeadForPullRequest filters strictly and enforces priority, open cap, and PR deduplication', () => {
  const now = new Date('2026-11-27T12:00:00.000Z');
  const allowedApps = new Set(['deconvolution', 'stardist', 'topofit']);

  const blocker = makeBead({
    id: 'bd-aaaaaaaa',
    kind: 'blocker',
    status: 'open',
    scope: { type: 'package', targets: ['runtime-support'] },
    dedupeKey: 'blocker:1',
  });
  const blockedBead = makeBead({
    id: 'bd-bbbbbbbb',
    priority: 1,
    scope: { type: 'app', targets: ['topofit'] },
    deps: { blockedBy: ['bd-aaaaaaaa'], parent: null, discoveredFrom: null },
    dedupeKey: 'knip:apps/topofit/a.js:foo',
  });
  const leasedBead = makeBead({
    id: 'bd-cccccccc',
    priority: 1,
    scope: { type: 'app', targets: ['topofit'] },
    lease: { owner: 'dev', branch: 'feat', acquiredAt: '2026-11-27T10:00:00.000Z', expiresAt: '2026-11-28T10:00:00.000Z' },
    dedupeKey: 'knip:apps/topofit/b.js:bar',
  });
  const upstreamBead = makeBead({
    id: 'bd-dddddddd',
    priority: 1,
    scope: { type: 'app', targets: ['qsmbly'] },
    dedupeKey: 'knip:apps/qsmbly/a.js:baz',
  });
  const followupBead = makeBead({
    id: 'bd-eeeeeeee',
    kind: 'followup',
    priority: 1,
    scope: { type: 'app', targets: ['topofit'] },
    dedupeKey: 'followup:1',
  });
  const deconvBead = makeBead({
    id: 'bd-7a37cab9',
    priority: 3,
    createdAt: '2026-11-27T05:28:29.936Z',
    scope: { type: 'app', targets: ['deconvolution'] },
    dedupeKey: 'knip:apps/deconvolution/package.json:jsdom',
  });
  const stardistBead = makeBead({
    id: 'bd-cee384d5',
    priority: 2,
    createdAt: '2026-11-27T05:28:29.937Z',
    scope: { type: 'app', targets: ['stardist'] },
    dedupeKey: 'knip:apps/stardist/package.json:clipper-lib',
  });

  const beads = [blocker, blockedBead, leasedBead, upstreamBead, followupBead, deconvBead, stardistBead];

  // Picks higher-priority stardistBead (P2) over deconvBead (P3), skipping blocked/leased/upstream/followup
  const first = selectBeadForPullRequest({ beads, allowedApps, existingPullRequests: [], now });
  assert.equal(first.selected, true);
  assert.equal(first.bead.id, 'bd-cee384d5');
  assert.equal(first.app, 'stardist');
  assert.equal(first.branch, 'beads/bd-cee384d5-stardist');

  // If stardist already has an open worker PR, falls through to deconvolution
  const withOpenStardist = selectBeadForPullRequest({
    beads,
    allowedApps,
    existingPullRequests: [
      { number: 980, state: 'open', draft: true, head: { ref: 'beads/bd-cee384d5-stardist-deadbeef' } },
    ],
    now,
  });
  assert.equal(withOpenStardist.selected, true);
  assert.equal(withOpenStardist.bead.id, 'bd-7a37cab9');
  assert.equal(withOpenStardist.openWorkerPrCount, 1);

  // Open worker PR cap (2/2) halts automatic selection
  const capped = selectBeadForPullRequest({
    beads,
    allowedApps,
    existingPullRequests: [
      { number: 980, state: 'open', draft: true, head: { ref: 'beads/bd-00000001-topofit' } },
      { number: 981, state: 'open', draft: true, head: { ref: 'beads/bd-00000002-topofit' } },
    ],
    maxOpenPrs: 2,
    now,
  });
  assert.equal(capped.selected, false);
  assert.match(capped.reason, /cap reached/i);

  // Recently closed unmerged PR skips bead automatically, but explicit bead_id allows retry
  const recentClosedPrs = [
    {
      number: 982,
      state: 'closed',
      draft: true,
      closed_at: '2026-11-20T00:00:00.000Z',
      merged_at: null,
      head: { ref: 'beads/bd-cee384d5-stardist-1234' },
    },
  ];
  const autoSkipClosed = selectBeadForPullRequest({ beads, allowedApps, existingPullRequests: recentClosedPrs, now });
  assert.equal(autoSkipClosed.selected, true);
  assert.equal(autoSkipClosed.bead.id, 'bd-7a37cab9');

  const explicitRetry = selectBeadForPullRequest({
    beads,
    allowedApps,
    existingPullRequests: recentClosedPrs,
    beadId: 'bd-cee384d5',
    now,
  });
  assert.equal(explicitRetry.selected, true);
  assert.equal(explicitRetry.bead.id, 'bd-cee384d5');

  // Even explicit bead_id refuses duplicate when an open PR already exists
  const dupExplicit = selectBeadForPullRequest({
    beads,
    allowedApps,
    existingPullRequests: [
      { number: 980, state: 'open', draft: true, head: { ref: 'beads/bd-cee384d5-stardist' } },
    ],
    beadId: 'bd-cee384d5',
    now,
  });
  assert.equal(dupExplicit.selected, false);
  assert.match(dupExplicit.reason, /already has an open worker PR/i);
});

test('validateWorkerChangedFiles enforces single-app containment and lockfile coupling', () => {
  assert.equal(validateWorkerChangedFiles(['apps/deconvolution/src/main.js'], { app: 'deconvolution' }).valid, true);
  assert.equal(
    validateWorkerChangedFiles(['apps/deconvolution/package.json', 'pnpm-lock.yaml'], { app: 'deconvolution' }).valid,
    true,
  );

  // pnpm-lock.yaml without apps/<app>/package.json is rejected
  const lockOnly = validateWorkerChangedFiles(['apps/deconvolution/src/main.js', 'pnpm-lock.yaml'], { app: 'deconvolution' });
  assert.equal(lockOnly.valid, false);
  assert.match(lockOnly.violations.join('\n'), /pnpm-lock\.yaml may only change alongside apps\/deconvolution\/package\.json/);

  // Cross-app, workflow, package, root manifest, traversal, and empty diffs are rejected
  for (const bad of [
    [],
    ['apps/stardist/package.json'],
    ['apps/deconvolution/src/main.js', 'apps/stardist/src/main.js'],
    ['apps/deconvolution/src/main.js', '.github/workflows/ci.yml'],
    ['apps/deconvolution/src/main.js', 'packages/components/src/index.js'],
    ['apps/deconvolution/src/main.js', 'package.json'],
    ['apps/deconvolution/../stardist/package.json'],
  ]) {
    assert.equal(validateWorkerChangedFiles(bad, { app: 'deconvolution' }).valid, false, JSON.stringify(bad));
  }
});

test('findMatchingDraftPr and recordVerifiedBeadDraftPr verify draft status, scope, detection, and remote push', (t) => {
  const scratch = mkdtempSync(join(tmpdir(), 'beads-pr-worker-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const bare = join(scratch, 'origin.git');
  const work = join(scratch, 'work');
  git(['init', '--bare', bare], scratch);
  git(['clone', bare, work], scratch);
  git(['config', 'user.name', 'Test Runner'], work);
  git(['config', 'user.email', 'test@neurodesk.local'], work);
  git(['commit', '--allow-empty', '-m', 'init'], work);
  git(['branch', '-M', 'main'], work);
  git(['push', '-u', 'origin', 'main'], work);

  // Seed one maintenance bead on origin/memory/beads
  const seeded = mutateBeadsRef(
    work,
    [
      {
        op: 'create',
        dedupeKey: 'knip:apps/deconvolution/package.json:jsdom',
        title: 'Remove unused devDependency jsdom from deconvolution',
        summary: 'Verified unused devDependency',
        kind: 'maintenance',
        priority: 3,
        scope: { type: 'app', targets: ['deconvolution'] },
        links: { evidence: ['apps/deconvolution/package.json'] },
      },
    ],
    { ref: DEFAULT_BEADS_REF, actor: 'test', message: 'seed' },
  );
  const beadId = seeded.createdIds[0];
  syncBeadsRef(work, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: true });
  const initialRemoteSha = git(['rev-parse', DEFAULT_BEADS_REF], bare);

  // findMatchingDraftPr rejects non-draft, wrong author, wrong base, wrong branch
  const prs = [
    { number: 10, state: 'open', draft: false, user: { login: 'github-actions[bot]' }, base: { ref: 'main' }, head: { ref: `beads/${beadId}-deconvolution` }, html_url: 'https://github.com/neurodesk/webapps/pull/10' },
    { number: 11, state: 'open', draft: true, user: { login: 'someone-else' }, base: { ref: 'main' }, head: { ref: `beads/${beadId}-deconvolution` }, html_url: 'https://github.com/neurodesk/webapps/pull/11' },
    { number: 12, state: 'open', draft: true, user: { login: 'github-actions[bot]' }, base: { ref: 'main' }, head: { ref: `beads/${beadId}-deconvolution-9f8e7d6c` }, html_url: 'https://github.com/neurodesk/webapps/pull/12' },
  ];
  const matched = findMatchingDraftPr(prs, { beadId, app: 'deconvolution' });
  assert.equal(matched?.number, 12);

  // parseRecordBeadPrItems extracts only matching item types
  assert.equal(
    parseRecordBeadPrItems({ items: [{ type: 'noop' }, { type: 'record_bead_pr', bead_id: beadId, app: 'deconvolution' }] }).length,
    1,
  );

  // Refuses when threat detection is not clean
  assert.throws(
    () =>
      recordVerifiedBeadDraftPr({
        cwd: work,
        beadId,
        app: 'deconvolution',
        pr: matched,
        prFiles: ['apps/deconvolution/package.json', 'pnpm-lock.yaml'],
        requireCleanDetection: true,
        detectionConclusion: 'failure',
        detectionSuccess: 'false',
      }),
    /Threat detection verdict/,
  );

  // Refuses when PR files escape target app
  assert.throws(
    () =>
      recordVerifiedBeadDraftPr({
        cwd: work,
        beadId,
        app: 'deconvolution',
        pr: matched,
        prFiles: ['apps/deconvolution/package.json', 'apps/stardist/package.json'],
        requireCleanDetection: true,
        detectionConclusion: 'success',
        detectionSuccess: 'true',
      }),
    /violates single-app scope/,
  );

  // dryRun leaves remote untouched
  const dryResult = recordVerifiedBeadDraftPr({
    cwd: work,
    beadId,
    app: 'deconvolution',
    pr: matched,
    prFiles: ['apps/deconvolution/package.json', 'pnpm-lock.yaml'],
    dryRun: true,
    requireCleanDetection: true,
    detectionConclusion: 'success',
    detectionSuccess: 'true',
  });
  assert.equal(dryResult.pushed, false);
  assert.equal(git(['rev-parse', DEFAULT_BEADS_REF], bare), initialRemoteSha);

  // Live call records links.pr + journal note and pushes to origin/memory/beads
  const liveResult = recordVerifiedBeadDraftPr({
    cwd: work,
    beadId,
    app: 'deconvolution',
    pr: matched,
    prFiles: ['apps/deconvolution/package.json', 'pnpm-lock.yaml'],
    note: 'pnpm --filter deconvolution test + build passed',
    dryRun: false,
    requireCleanDetection: true,
    detectionConclusion: 'success',
    detectionSuccess: 'true',
  });
  assert.equal(liveResult.pushed, true);
  assert.notEqual(git(['rev-parse', DEFAULT_BEADS_REF], bare), initialRemoteSha);

  const verifyClone = join(scratch, 'verify');
  git(['clone', bare, verifyClone], scratch);
  syncBeadsRef(verifyClone, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  const { beads: after } = readBeadsFromRef(verifyClone, DEFAULT_BEADS_REF);
  const updated = after.get(beadId);
  assert.equal(updated.links.pr, 12);
  assert.equal(updated.revision, 2);
  assert.match(updated.journal.at(-1).note, /Draft PR #12 opened/);
  assert.equal(updated.journal.at(-1).actor, 'gh-aw/beads-pr-worker');
});

test('beads-pr-worker compiled lockfile enforces draft-only, no auto-merge, zero issues:write, and post-PR scope recording', () => {
  const lockText = readFileSync(new URL('../.github/workflows/beads-pr-worker.lock.yml', import.meta.url), 'utf8');
  const flow = YAML.parse(lockText);

  assert.equal(flow.name, 'beads-pr-worker');
  assert.equal(/issues:\s*write/.test(lockText), false, 'workflow must not hold issues:write');
  assert.equal(lockText.includes('GH_AW_CI_TRIGGER_TOKEN'), false, 'workflow must not reference GH_AW_CI_TRIGGER_TOKEN');

  assert.equal(flow.jobs.agent.permissions.contents, 'read');
  assert.equal(flow.jobs.agent.permissions['pull-requests'], 'read');
  assert.equal(flow.jobs.agent.permissions['copilot-requests'], 'none');
  assert.equal(typeof flow.jobs.agent['timeout-minutes'], 'number');
  assert.equal(typeof flow.jobs.detection['timeout-minutes'], 'number');
  assert.equal(typeof flow.jobs.safe_outputs['timeout-minutes'], 'number');

  // Safe-outputs config enforces draft-only, never auto-merge, strict file allowlist & upstream exclusions
  const safeConfigStep = flow.jobs.agent.steps.find((step) => step.env?.GH_AW_SAFE_OUTPUTS_CONFIG);
  assert.ok(safeConfigStep, 'safe-outputs config step must exist');
  const cfg = JSON.parse(safeConfigStep.env.GH_AW_SAFE_OUTPUTS_CONFIG);
  assert.equal(cfg.create_pull_request.draft, true);
  assert.equal(cfg.create_pull_request.auto_merge, false);
  assert.equal(cfg.create_pull_request.fallback_as_issue, false);
  assert.equal(cfg.create_pull_request.max, 1);
  assert.equal(cfg.create_pull_request.base_branch, 'main');
  assert.equal(cfg.create_pull_request.branch_prefix, 'beads/');
  assert.deepEqual(cfg.create_pull_request.allowed_branches, ['beads/*']);
  assert.deepEqual(cfg.create_pull_request.allowed_files, ['apps/**', 'pnpm-lock.yaml']);
  for (const upstream of ['apps/qsmbly/**', 'apps/seedseg/**', 'apps/dicompare/**']) {
    assert.ok(cfg.create_pull_request.excluded_files.includes(upstream), `excluded_files must exclude ${upstream}`);
  }
  assert.equal(cfg.create_pull_request.signed_commits, true);
  assert.equal(cfg.create_pull_request.protected_files_policy, 'request-review');
  assert.equal(cfg['record-bead-pr'].max, 1);

  // record_bead_pr runs strictly after detection AND safe_outputs on default branch only
  const recordJob = flow.jobs.record_bead_pr;
  assert.ok(recordJob, 'record_bead_pr job must exist');
  assert.ok(recordJob.needs.includes('detection'));
  assert.ok(recordJob.needs.includes('safe_outputs'));
  assert.equal(recordJob.permissions.contents, 'write');
  assert.equal(recordJob.permissions['pull-requests'], 'read');
  assert.match(recordJob.if, /needs\.detection\.outputs\.detection_success == 'true'/);
  assert.match(recordJob.if, /needs\.detection\.outputs\.detection_conclusion == 'success'/);
  assert.match(recordJob.if, /needs\.safe_outputs\.result == 'success'/);

  const recordStep = recordJob.steps.find((step) => step.run?.includes('scripts/record-bead-pr.mjs'));
  assert.ok(recordStep, 'record-bead-pr.mjs step must exist');
  assert.match(recordStep.run, /--require-clean-detection/);
  assert.equal(typeof recordStep['timeout-minutes'], 'number');
});

test('beads-pr-worker workflow and helper scripts select no apps or site builds in app-plan', async () => {
  const repoRoot = fileURLToPath(new URL('..', import.meta.url));
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(repoRoot);
  const plan = createAppPlan(registry, [
    '.github/workflows/beads-pr-worker.md',
    '.github/workflows/beads-pr-worker.lock.yml',
    'scripts/lib/beads-pr-worker.mjs',
    'scripts/select-bead-for-pr.mjs',
    'scripts/verify-bead-pr-diff.mjs',
    'scripts/record-bead-pr.mjs',
    'test/beads-pr-worker.test.mjs',
    'test/ci-policy.test.mjs',
    'scripts/lib/ci-measures.mjs',
    'docs/architecture/beads-memory.md',
  ], graph);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
  assert.equal(plan.reasons.fallback, null);
});
