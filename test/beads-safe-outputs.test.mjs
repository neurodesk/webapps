import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import {
  DEFAULT_BEADS_REF,
  mutateBeadsRef,
  readBeadsFromRef,
  summarizeBeads,
  syncBeadsRef,
} from '../scripts/lib/beads.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry } from '../scripts/lib/apps-registry.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';
import {
  DEFAULT_TRIAGE_ACTOR,
  UNUSED_CODE_ITEM_TYPE,
  applyUnusedCodeSafeOutputs,
  assertCleanThreatDetection,
  discoverFirstPartyApps,
  formatSafeOutputsSummary,
  parseAgentOutput,
  translateUnusedCodeItems,
} from '../scripts/lib/beads-safe-outputs.mjs';

const REPO_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const CLI_PATH = join(REPO_ROOT, 'scripts', 'apply-beads-safe-outputs.mjs');

function runGit(cwd, args) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function configureGitIdentity(cwd) {
  runGit(cwd, ['config', 'user.name', 'Test User']);
  runGit(cwd, ['config', 'user.email', 'test@example.com']);
}

function createFixtureRepo(t) {
  const scratchRoot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'beads-safe-outputs-'));
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

  const remoteDir = join(scratchRoot, 'remote.git');
  const workDir = join(scratchRoot, 'work');
  const outsideDir = join(scratchRoot, 'outside-app');
  mkdirSync(join(outsideDir, 'src'), { recursive: true });
  const outsideFile = join(outsideDir, 'src', 'secret.js');
  writeFileSync(outsideFile, 'export const secret = 1;\n', 'utf8');

  runGit(scratchRoot, ['init', '--bare', remoteDir]);
  runGit(scratchRoot, ['clone', remoteDir, workDir]);
  configureGitIdentity(workDir);

  mkdirSync(join(workDir, 'apps', 'alpha', 'src'), { recursive: true });
  mkdirSync(join(workDir, 'apps', 'beta', 'src'), { recursive: true });
  mkdirSync(join(workDir, 'apps', 'upstreamapp', 'src'), { recursive: true });
  mkdirSync(join(workDir, 'packages', 'shared', 'src'), { recursive: true });

  writeFileSync(join(workDir, 'apps', 'alpha', 'src', 'unused.js'), 'export const dead = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'alpha', 'src', 'other.js'), 'export const two = 2;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'beta', 'src', 'unused.js'), 'export const b = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'upstreamapp', 'src', 'unused.js'), 'export const u = 1;\n', 'utf8');
  writeFileSync(join(workDir, 'apps', 'upstreamapp', 'upstream.json'), '{"repo":"example/upstream"}\n', 'utf8');
  writeFileSync(join(workDir, 'packages', 'shared', 'src', 'index.js'), 'export const s = 1;\n', 'utf8');
  symlinkSync(outsideFile, join(workDir, 'apps', 'alpha', 'src', 'escape.js'));
  symlinkSync(outsideDir, join(workDir, 'apps', 'symapp'));

  runGit(workDir, ['add', '.']);
  runGit(workDir, ['commit', '-m', 'init fixture']);
  runGit(workDir, ['push', '-u', 'origin', 'HEAD']);

  const verifyDir = join(scratchRoot, 'verify');
  runGit(scratchRoot, ['clone', remoteDir, verifyDir]);
  configureGitIdentity(verifyDir);

  return {
    scratchRoot,
    remoteDir,
    workDir,
    verifyDir,
    allowedApps: new Set(['alpha', 'beta', 'symapp']),
  };
}

test('discoverFirstPartyApps includes registered first-party apps and excludes upstream-tracked apps', async () => {
  const apps = await discoverFirstPartyApps(REPO_ROOT);
  assert.ok(apps.has('topofit'), 'first-party app topofit should be included');
  assert.ok(apps.has('syncro'), 'first-party app syncro should be included');
  assert.ok(!apps.has('qsmbly'), 'upstream app qsmbly must be excluded');
  assert.ok(!apps.has('seedseg'), 'upstream app seedseg must be excluded');
  assert.ok(!apps.has('dicompare'), 'upstream app dicompare must be excluded');
});

test('assertCleanThreatDetection fails closed on missing, warning, or failed verdicts', () => {
  assert.doesNotThrow(() => assertCleanThreatDetection({ detectionConclusion: 'success', detectionSuccess: 'true' }));
  for (const bad of [
    {},
    { detectionConclusion: 'warning', detectionSuccess: 'false' },
    { detectionConclusion: 'warning', detectionSuccess: 'true' },
    { detectionConclusion: 'success', detectionSuccess: 'false' },
    { detectionConclusion: 'success', detectionSuccess: '' },
    { detectionConclusion: 'skipped', detectionSuccess: 'true' },
    { detectionConclusion: 'failure', detectionSuccess: 'false' },
  ]) {
    assert.throws(() => assertCleanThreatDetection(bad), /Threat detection verdict is not cleanly verified/);
  }
});

test('parseAgentOutput validates top-level structure and filters by item type', () => {
  assert.throws(() => parseAgentOutput(null), /must be an object/);
  assert.throws(() => parseAgentOutput([]), /must be an object/);
  assert.throws(() => parseAgentOutput({}), /missing an "items" array/);

  const parsed = parseAgentOutput({
    items: [
      { type: 'noop', message: 'nothing' },
      { type: UNUSED_CODE_ITEM_TYPE, app: 'alpha' },
      null,
      'noise',
    ],
  });
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].app, 'alpha');
});

test('translateUnusedCodeItems enforces single-app containment, real app root, file existence, Unicode key hygiene, and bounds', (t) => {
  const { workDir, allowedApps } = createFixtureRepo(t);
  const validItem = {
    type: UNUSED_CODE_ITEM_TYPE,
    app: 'alpha',
    dedupe_key: 'knip:apps/alpha/src/unused.js:dead',
    title: 'Remove unused export dead in alpha',
    summary: 'Confirmed via search_app_files that dead is never imported inside apps/alpha.',
    evidence: 'apps/alpha/src/unused.js, quality-artifacts/unused-code/knip.json',
    priority: '2',
    note: 'Checked imports across apps/alpha/src',
  };

  const { operations, skipped } = translateUnusedCodeItems([
    validItem,
    // Duplicate key in same batch
    { ...validItem },
    // Valid item with colon in symbol name and numeric expected_revision
    {
      ...validItem,
      dedupe_key: 'knip:apps/alpha/src/other.js:ns:two',
      evidence: 'apps/alpha/src/other.js',
      priority: 3,
      expected_revision: 1,
    },
    // Upstream / unregistered app
    { ...validItem, app: 'upstreamapp', dedupe_key: 'knip:apps/upstreamapp/src/unused.js:u', evidence: 'apps/upstreamapp/src/unused.js' },
    // Cross-app dedupe_key spoofing
    { ...validItem, app: 'alpha', dedupe_key: 'knip:apps/beta/src/unused.js:b', evidence: 'apps/alpha/src/unused.js' },
    // Symlink escape inside apps/alpha/
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/escape.js:leak', evidence: 'apps/alpha/src/escape.js' },
    // Symlinked app root apps/symapp -> outsideDir
    { ...validItem, app: 'symapp', dedupe_key: 'knip:apps/symapp/src/secret.js:secret', evidence: 'apps/symapp/src/secret.js' },
    // Directory instead of file
    { ...validItem, dedupe_key: 'knip:apps/alpha/src:dir', evidence: 'apps/alpha/src' },
    // Nonexistent file
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/missing.js:x', evidence: 'apps/alpha/src/missing.js' },
    // Evidence citing only knip.json without any file under apps/alpha/
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:onlyknip', evidence: 'quality-artifacts/unused-code/knip.json' },
    // Out-of-range priority
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:badprio', priority: 0 },
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:floatprio', priority: 2.5 },
    // Shared package path in evidence
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/other.js:shared', evidence: 'apps/alpha/src/other.js, packages/shared/src/index.js' },
    // Unicode invisible / BiDi format characters in dedupe_key
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/unused.js:dead\u200B' },
    { ...validItem, dedupe_key: 'knip:apps/alpha/src/unused.js:\u202Edead' },
  ], { cwd: workDir, allowedApps });

  assert.equal(operations.length, 2);
  assert.deepEqual(operations[0].scope, { type: 'app', targets: ['alpha'] });
  assert.deepEqual(operations[0].links.evidence, ['apps/alpha/src/unused.js', 'quality-artifacts/unused-code/knip.json']);
  assert.equal(operations[0].priority, 2);
  assert.equal(operations[1].expectedRevision, 1);
  assert.equal(operations[1].priority, 3);

  assert.equal(skipped.length, 13);
  assert.match(skipped[0].reason, /duplicate dedupe_key/);
  assert.match(skipped[1].reason, /not a registered first-party/);
  assert.match(skipped[2].reason, /must start with "knip:apps\/alpha\/"/);
  assert.match(skipped[3].reason, /does not exist inside apps\/alpha/);
  assert.match(skipped[4].reason, /must be a real directory, not a symlink/);
  assert.match(skipped[5].reason, /does not exist inside apps\/alpha/);
  assert.match(skipped[6].reason, /does not exist inside apps\/alpha/);
  assert.match(skipped[7].reason, /must include at least one file under apps\/alpha/);
  assert.match(skipped[8].reason, /priority must be an integer/);
  assert.match(skipped[9].reason, /priority must be an integer/);
  assert.match(skipped[10].reason, /must stay under apps\/alpha/);
  assert.match(skipped[11].reason, /invalid dedupe_key/);
  assert.match(skipped[12].reason, /invalid dedupe_key/);
});

test('applyUnusedCodeSafeOutputs enforces clean dry-run, fail-closed detection, concurrent revision CAS, replay, and push-failure retry', async (t) => {
  const { workDir, remoteDir, verifyDir, allowedApps } = createFixtureRepo(t);
  const rawOutput = {
    items: [
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/unused.js:dead',
        title: 'Remove unused export dead in alpha',
        summary: 'Verified unused export in apps/alpha/src/unused.js.',
        evidence: 'apps/alpha/src/unused.js',
        priority: 2,
      },
      // Invalid item mixed into the same batch must be skipped without aborting valid items
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'upstreamapp',
        dedupe_key: 'knip:apps/upstreamapp/src/unused.js:u',
        title: 'Should be skipped',
        summary: 'Upstream app must be skipped.',
        evidence: 'apps/upstreamapp/src/unused.js',
      },
    ],
  };

  // Fail-closed threat detection check rejects warning verdict before touching git
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs(rawOutput, {
      cwd: workDir,
      allowedApps,
      requireCleanDetection: true,
      detectionConclusion: 'warning',
      detectionSuccess: 'false',
    }),
    /Threat detection verdict is not cleanly verified/,
  );

  // Empty/noop output
  const noopResult = await applyUnusedCodeSafeOutputs({ items: [{ type: 'noop' }] }, {
    cwd: workDir,
    allowedApps,
    requireCleanDetection: true,
    detectionConclusion: 'success',
    detectionSuccess: 'true',
  });
  assert.equal(noopResult.status, 'skipped');
  assert.equal(noopResult.pushed, false);

  // Staged / dry-run preview on an empty store creates ZERO refs/commits both remotely AND locally
  const dryResult = await applyUnusedCodeSafeOutputs(rawOutput, {
    cwd: workDir,
    allowedApps,
    dryRun: true,
    requireCleanDetection: true,
    detectionConclusion: 'success',
    detectionSuccess: 'true',
    now: new Date('2026-11-26T08:00:00Z'),
  });
  assert.equal(dryResult.status, 'skipped');
  assert.equal(dryResult.staged, true);
  assert.equal(dryResult.pushed, false);
  assert.equal(dryResult.createdIds.length, 1);
  assert.equal(dryResult.skipped.length, 1);
  assert.equal(runGit(remoteDir, ['for-each-ref', DEFAULT_BEADS_REF]).trim(), '', 'dry-run must not push to remote');
  assert.equal(runGit(workDir, ['for-each-ref', 'refs/heads/memory/']).trim(), '', 'dry-run must not initialize local memory/beads');
  assert.equal(runGit(workDir, ['for-each-ref', 'refs/beads-tmp/']).trim(), '', 'dry-run must clean up temporary refs');

  // Failed push must NOT leave a local commit that tricks a retry into skipping push
  runGit(workDir, ['remote', 'set-url', '--push', 'origin', join(workDir, 'nonexistent-remote.git')]);
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs(rawOutput, {
      cwd: workDir,
      allowedApps,
      now: new Date('2026-11-26T08:00:30Z'),
    }),
  );
  assert.equal(runGit(workDir, ['for-each-ref', 'refs/heads/memory/']).trim(), '', 'failed push must not advance local ref');
  runGit(workDir, ['remote', 'set-url', '--push', 'origin', remoteDir]);

  // Retry in the same checkout now succeeds and pushes to bare remote
  const liveResult = await applyUnusedCodeSafeOutputs(rawOutput, {
    cwd: workDir,
    allowedApps,
    requireCleanDetection: true,
    detectionConclusion: 'success',
    detectionSuccess: 'true',
    now: new Date('2026-11-26T08:01:00Z'),
  });
  assert.equal(liveResult.status, 'success');
  assert.equal(liveResult.staged, false);
  assert.equal(liveResult.pushed, true);
  assert.equal(liveResult.createdIds.length, 1);
  assert.equal(liveResult.skipped.length, 1);

  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  const remoteTree = readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF);
  assert.equal(remoteTree.sha, liveResult.commitSha);
  assert.equal(remoteTree.beads.size, 1);
  const created = remoteTree.beads.get(liveResult.createdIds[0]);
  assert.equal(created.journal[0].actor, DEFAULT_TRIAGE_ACTOR);
  assert.deepEqual(created.scope, { type: 'app', targets: ['alpha'] });

  // Unchanged replay with CURRENT revision produces untouchedIds and skips push
  const unchangedReplay = await applyUnusedCodeSafeOutputs({
    items: [{ ...rawOutput.items[0], expected_revision: created.revision }],
  }, {
    cwd: workDir,
    allowedApps,
    now: new Date('2026-11-26T08:02:00Z'),
  });
  assert.equal(unchangedReplay.status, 'success');
  assert.equal(unchangedReplay.pushed, false);
  assert.deepEqual(unchangedReplay.untouchedIds, [created.id]);

  // Concurrent maintainer update on the SAME bead (rev 1 -> rev 2) between validation and push MUST fail with Stale revision
  let racedSameBead = false;
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs({
      items: [{
        ...rawOutput.items[0],
        summary: 'Triage updated summary that must not overwrite maintainer.',
        expected_revision: 1,
      }],
    }, {
      cwd: workDir,
      allowedApps,
      now: new Date('2026-11-26T08:03:00Z'),
      beforePush: () => {
        if (racedSameBead) return;
        racedSameBead = true;
        syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
        mutateBeadsRef(verifyDir, [{
          op: 'upsert',
          dedupeKey: rawOutput.items[0].dedupe_key,
          summary: 'Maintainer authoritative summary',
          expectedRevision: 1,
        }], { actor: 'maintainer', now: new Date('2026-11-26T08:02:30Z') });
        syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: true });
      },
    }),
    /Stale revision/i,
  );
  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  assert.equal(
    readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF).beads.get(created.id).summary,
    'Maintainer authoritative summary',
    'concurrent triage push must never overwrite maintainer update via merge',
  );

  // Replaying an earlier update payload with stale expected_revision=1 after bead moved to rev 2 throws Stale revision
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs({
      items: [{
        ...rawOutput.items[0],
        summary: 'Maintainer authoritative summary',
        expected_revision: 1,
      }],
    }, {
      cwd: workDir,
      allowedApps,
      now: new Date('2026-11-26T08:04:00Z'),
    }),
    /Stale revision/i,
  );

  // Concurrent maintainer update on an UNRELATED bead retries cleanly against fresh remote tip and preserves both
  let racedUnrelated = false;
  const retryCreate = await applyUnusedCodeSafeOutputs({
    items: [{
      type: UNUSED_CODE_ITEM_TYPE,
      app: 'beta',
      dedupe_key: 'knip:apps/beta/src/unused.js:b',
      title: 'Remove unused export b in beta',
      summary: 'Verified unused export in apps/beta/src/unused.js.',
      evidence: 'apps/beta/src/unused.js',
    }],
  }, {
    cwd: workDir,
    allowedApps,
    now: new Date('2026-11-26T08:05:00Z'),
    beforePush: () => {
      if (racedUnrelated) return;
      racedUnrelated = true;
      syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
      mutateBeadsRef(verifyDir, [{
        op: 'create',
        dedupeKey: 'maintainer:unrelated',
        title: 'Maintainer concurrent bead',
        scope: { type: 'app', targets: ['alpha'] },
      }], { actor: 'maintainer', now: new Date('2026-11-26T08:04:30Z') });
      syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: true });
    },
  });
  assert.equal(retryCreate.pushed, true);
  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  assert.equal(readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF).beads.size, 3);

  // Dry-run against a NON-EMPTY remote in a fresh clone writes ZERO refs and ZERO FETCH_HEAD
  const freshDryClone = join(workDir, '..', 'fresh-dry');
  runGit(join(workDir, '..'), ['clone', '--single-branch', remoteDir, freshDryClone]);
  configureGitIdentity(freshDryClone);
  const refsBefore = runGit(freshDryClone, ['for-each-ref']).trim();
  const nonEmptyDry = await applyUnusedCodeSafeOutputs({
    items: [{
      type: UNUSED_CODE_ITEM_TYPE,
      app: 'alpha',
      dedupe_key: 'knip:apps/alpha/src/other.js:dryprobe',
      title: 'Dry probe on non-empty remote',
      summary: 'Verified unused.',
      evidence: 'apps/alpha/src/other.js',
    }],
  }, {
    cwd: freshDryClone,
    allowedApps,
    dryRun: true,
    now: new Date('2026-11-26T08:05:30Z'),
  });
  assert.equal(nonEmptyDry.status, 'skipped');
  assert.equal(nonEmptyDry.createdIds.length, 1);
  assert.equal(runGit(freshDryClone, ['for-each-ref']).trim(), refsBefore, 'non-empty dry-run must not create or mutate any ref');
  assert.equal(existsSync(join(freshDryClone, '.git', 'FETCH_HEAD')), false, 'non-empty dry-run must not write FETCH_HEAD');

  // Previously closed bead in the same batch as an unrelated new finding skips the closed bead cleanly without blocking
  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  mutateBeadsRef(verifyDir, [{
    op: 'close',
    id: created.id,
    reason: 'Intentionally exported helper',
  }], { actor: 'maintainer', now: new Date('2026-11-26T08:05:45Z') });
  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: true });

  const snapAfterClose = summarizeBeads(readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF).beads);
  assert.ok(snapAfterClose.closedDedupeKeys.includes(rawOutput.items[0].dedupe_key), 'snapshot must advertise closedDedupeKeys');

  // Mixed closed + new finding: skips closed bead, creates new finding, pushes cleanly
  const mixedClosedResult = await applyUnusedCodeSafeOutputs({
    items: [
      { ...rawOutput.items[0], summary: 'Weekly repeat of closed finding' },
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:afterclose',
        title: 'Unrelated new finding alongside closed finding',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      },
    ],
  }, {
    cwd: workDir,
    allowedApps,
    now: new Date('2026-11-26T08:06:00Z'),
  });
  assert.equal(mixedClosedResult.status, 'success');
  assert.equal(mixedClosedResult.pushed, true);
  assert.equal(mixedClosedResult.createdIds.length, 1);
  assert.equal(mixedClosedResult.skipped.length, 1);
  assert.match(mixedClosedResult.skipped[0].reason, /already closed/);

  // Batch with ONLY already-closed findings returns skipped cleanly without error
  const onlyClosedResult = await applyUnusedCodeSafeOutputs({
    items: [{ ...rawOutput.items[0], summary: 'Weekly repeat of closed finding' }],
  }, {
    cwd: workDir,
    allowedApps,
    now: new Date('2026-11-26T08:06:15Z'),
  });
  assert.equal(onlyClosedResult.status, 'skipped');
  assert.equal(onlyClosedResult.pushed, false);
  assert.equal(onlyClosedResult.skipped.length, 1);

  // Tracking-ref lock error AFTER a successful remote push must NOT turn publication into a failure
  const trackingLockDir = join(workDir, '.git', 'refs', 'remotes', 'origin', 'memory');
  mkdirSync(trackingLockDir, { recursive: true });
  const trackingLockFile = join(trackingLockDir, 'beads.lock');
  writeFileSync(trackingLockFile, 'locked\n', 'utf8');
  try {
    const lockedPushResult = await applyUnusedCodeSafeOutputs({
      items: [{
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:lockedtrack',
        title: 'Push succeeds even if local tracking ref is locked',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      }],
    }, {
      cwd: workDir,
      allowedApps,
      now: new Date('2026-11-26T08:06:30Z'),
    });
    assert.equal(lockedPushResult.status, 'success');
    assert.equal(lockedPushResult.pushed, true);
  } finally {
    rmSync(trackingLockFile, { force: true });
  }

  // Receive-side pre-receive race (remote advances AFTER ref advertisement -> `[remote rejected] (incorrect old value provided)`)
  // must retry cleanly against the new tip instead of failing on attempt 1
  const hookMarker = join(workDir, '..', 'pre-receive-once');
  const preReceiveHook = join(remoteDir, 'hooks', 'pre-receive');
  writeFileSync(preReceiveHook, [
    '#!/bin/sh',
    `if [ ! -f "${hookMarker}" ]; then`,
    `  touch "${hookMarker}"`,
    '  git -C "$GIT_DIR" update-ref refs/heads/memory/beads "$(git -C "$GIT_DIR" commit-tree "$(git -C "$GIT_DIR" rev-parse refs/heads/memory/beads^{tree})" -p "$(git -C "$GIT_DIR" rev-parse refs/heads/memory/beads)" -m "concurrent receive-side race")"',
    'fi',
    'exit 0',
    '',
  ].join('\n'), 'utf8');
  chmodSync(preReceiveHook, 0o755);
  try {
    const receiveRaceResult = await applyUnusedCodeSafeOutputs({
      items: [{
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:receiverace',
        title: 'Retries cleanly on receive-side incorrect old value provided race',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      }],
    }, {
      cwd: workDir,
      allowedApps,
      now: new Date('2026-11-26T08:06:45Z'),
    });
    assert.equal(receiveRaceResult.status, 'success');
    assert.equal(receiveRaceResult.pushed, true);
    assert.equal(existsSync(hookMarker), true, 'pre-receive race hook must have fired');
  } finally {
    rmSync(preReceiveHook, { force: true });
    rmSync(hookMarker, { force: true });
  }

  // Local --no-sync path also filters closed upserts atomically inside mutateBeadsRef
  syncBeadsRef(workDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  const localClosedResult = await applyUnusedCodeSafeOutputs({
    items: [
      { ...rawOutput.items[0], summary: 'Closed bead repeated in local --no-sync mode' },
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:localafterclose',
        title: 'Local mode creates unrelated bead while skipping closed bead',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      },
    ],
  }, {
    cwd: workDir,
    allowedApps,
    skipSync: true,
    now: new Date('2026-11-26T08:06:50Z'),
  });
  assert.equal(localClosedResult.status, 'success');
  assert.equal(localClosedResult.pushed, false);
  assert.equal(localClosedResult.createdIds.length, 1);
  assert.equal(localClosedResult.skipped.length, 1);
  assert.match(localClosedResult.skipped[0].reason, /already closed/);

  // All-invalid batch rejects without touching remote
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs({ items: [rawOutput.items[1]] }, { cwd: workDir, allowedApps }),
    /All 1 upsert_unused_code_bead item\(s\) failed validation/,
  );

  // Exceeding maxCreates rejects atomically without writing
  const tooMany = {
    items: [
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:sym1',
        title: 'Unused sym1',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      },
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'alpha',
        dedupe_key: 'knip:apps/alpha/src/other.js:sym2',
        title: 'Unused sym2',
        summary: 'Verified unused.',
        evidence: 'apps/alpha/src/other.js',
      },
    ],
  };
  await assert.rejects(
    () => applyUnusedCodeSafeOutputs(tooMany, { cwd: workDir, allowedApps, maxCreates: 1 }),
    /maxCreates/,
  );
  syncBeadsRef(verifyDir, { ref: DEFAULT_BEADS_REF, remote: 'origin', push: false });
  assert.equal(readBeadsFromRef(verifyDir, DEFAULT_BEADS_REF).beads.size, 6);
});

test('apply-beads-safe-outputs CLI honors detection gate, writes escaped summary/outputs, and sanitizes stderr on warnings and fatal errors', (t) => {
  const scratchRoot = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'beads-safe-cli-'));
  t.after(() => rmSync(scratchRoot, { recursive: true, force: true }));

  const mixedInput = join(scratchRoot, 'mixed.json');
  const allBadInput = join(scratchRoot, 'all-bad.json');
  const summaryFile = join(scratchRoot, 'summary.md');
  const outputFile = join(scratchRoot, 'github_output.txt');
  const failOutputFile = join(scratchRoot, 'fail_output.txt');

  writeFileSync(mixedInput, JSON.stringify({
    items: [
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'topofit',
        dedupe_key: 'knip:apps/topofit/package.json:unused-demo',
        title: 'Remove unused dependency demo in topofit',
        summary: 'Verified unused in apps/topofit.',
        evidence: 'apps/topofit/package.json',
      },
      {
        type: UNUSED_CODE_ITEM_TYPE,
        app: 'qsmbly',
        dedupe_key: 'knip:apps/qsmbly/package.json:bad\n::error::injected%0A',
        title: 'Should be skipped',
        summary: 'Upstream app.',
        evidence: 'apps/qsmbly/package.json',
      },
    ],
  }), 'utf8');

  // 1. --require-clean-detection fails closed when detection_conclusion is warning
  const blocked = spawnSync(process.execPath, [CLI_PATH, '--no-sync', '--require-clean-detection'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_AW_AGENT_OUTPUT: mixedInput,
      GH_AW_SAFE_OUTPUTS_STAGED: 'true',
      GH_AW_DETECTION_CONCLUSION: 'warning',
      GH_AW_DETECTION_SUCCESS: 'false',
      GITHUB_OUTPUT: failOutputFile,
    },
  });
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /Threat detection verdict is not cleanly verified/);
  assert.match(readFileSync(failOutputFile, 'utf8'), /^status=failure$/m);

  // 2. Clean detection passes staged preview and sanitizes warnings + Markdown summary
  const ok = spawnSync(process.execPath, [CLI_PATH, '--no-sync', '--require-clean-detection', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      GH_AW_AGENT_OUTPUT: mixedInput,
      GH_AW_SAFE_OUTPUTS_STAGED: 'true',
      GH_AW_DETECTION_CONCLUSION: 'success',
      GH_AW_DETECTION_SUCCESS: 'true',
      GITHUB_STEP_SUMMARY: summaryFile,
      GITHUB_OUTPUT: outputFile,
      GITHUB_WORKFLOW: 'unused-code-triage',
    },
  });
  assert.equal(ok.status, 0, ok.stderr);
  const parsed = JSON.parse(ok.stdout);
  assert.equal(parsed.status, 'skipped');
  assert.equal(parsed.staged, true);
  assert.equal(parsed.createdIds.length, 1);
  assert.equal(parsed.skipped.length, 1);

  assert.ok(!ok.stderr.includes('\n::error::'), 'warning stderr must not contain injected command line');
  assert.match(ok.stderr, /%250A/, 'warning stderr must percent-escape % sequences');

  const summary = readFileSync(summaryFile, 'utf8');
  assert.match(summary, /staged preview \(no writes\)/);
  assert.match(summary, /Skipped invalid items:\*\* 1/);
  assert.ok(!summary.includes('\n::error::'), 'summary must not contain injected lines');

  const outputs = readFileSync(outputFile, 'utf8');
  assert.match(outputs, /^status=skipped$/m);
  assert.match(outputs, /^created_count=1$/m);
  assert.match(outputs, /^skipped_count=1$/m);
  assert.match(outputs, /^pushed=false$/m);

  // 3. All-invalid batch escapes agent-derived error text in stderr (no raw :: or legacy ##[ workflow commands)
  writeFileSync(allBadInput, JSON.stringify({
    items: [{
      type: UNUSED_CODE_ITEM_TYPE,
      app: 'bad\n::add-mask::secret%0A ##[add-mask]legacy',
      dedupe_key: 'knip:apps/topofit/package.json:x',
      title: 'Bad',
      summary: 'Bad',
      evidence: 'apps/topofit/package.json',
    }],
  }), 'utf8');
  const allBad = spawnSync(process.execPath, [CLI_PATH, '--no-sync'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, GH_AW_AGENT_OUTPUT: allBadInput },
  });
  assert.notEqual(allBad.status, 0);
  assert.ok(!allBad.stderr.includes('\n::add-mask::'), 'fatal error stderr must flatten injected newlines');
  assert.ok(!allBad.stderr.includes('##['), 'fatal error stderr must neutralize legacy ##[ command markers');
  assert.match(allBad.stderr, /%250A/, 'fatal error stderr must escape percent sequences');

  // 4. formatSafeOutputsSummary escapes Markdown metacharacters and HTML tags in rejection reasons
  const formatted = formatSafeOutputsSummary({
    status: 'skipped',
    staged: true,
    pushed: false,
    createdIds: [],
    updatedIds: [],
    untouchedIds: [],
    skipped: [{ index: 0, dedupeKey: 'bad`key\ninject', reason: '[click](https://evil) <img src=x> *bold*' }],
  });
  assert.ok(!formatted.includes('\ninject'));
  assert.ok(!formatted.includes('bad`key'));
  assert.ok(!formatted.includes('[click](https://evil)'));
  assert.ok(!formatted.includes('<img'));
  assert.match(formatted, /\\\[click\\\]\(https:\/\/evil\) &lt;img src=x&gt; \\\*bold\\\*/);
});

test('unused-code-triage gh-aw workflow enforces read-only no-shell agent, zero issue writes, and fail-closed detection gate', () => {
  const lockText = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'unused-code-triage.lock.yml'), 'utf8');
  assert.ok(lockText.startsWith('# gh-aw-metadata:'), 'lockfile must carry gh-aw metadata header');
  const flow = YAML.parse(lockText);

  assert.equal(flow.name, 'unused-code-triage');
  assert.deepEqual(flow.permissions, {}, 'workflow-level permissions must default to empty');
  assert.equal(flow.on?.pull_request, undefined, 'triage workflow must not run on pull_request');
  assert.equal(flow.on?.push, undefined, 'triage workflow must not run on push');
  assert.equal(flow.on?.workflow_run, undefined, 'triage workflow must not listen to workflow_run');

  // Zero jobs anywhere in the workflow may write to GitHub Issues
  for (const [id, job] of Object.entries(flow.jobs)) {
    assert.notEqual(job?.permissions?.issues, 'write', `job ${id} must not hold issues: write`);
  }

  // Agent job: read-only checkout pinned to github.sha with .git stripped before credential step, no shell/file built-ins
  assert.equal(flow.jobs.agent.permissions.contents, 'read', 'agent job must keep contents: read');
  assert.equal(flow.jobs.agent.permissions['copilot-requests'], 'write', 'agent job uses Copilot inference');
  const agentCheckout = flow.jobs.agent.steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  assert.equal(agentCheckout?.with?.ref, '${{ github.sha }}', 'agent checkout must pin to triggering github.sha');
  assert.equal(agentCheckout?.with?.['persist-credentials'], false, 'agent checkout must disable persist-credentials');
  const stripIdx = flow.jobs.agent.steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('rm -rf .git'));
  const credIdx = flow.jobs.agent.steps.findIndex((step) => typeof step.run === 'string' && step.run.includes('configure_git_credentials.sh'));
  assert.ok(stripIdx >= 0 && credIdx > stripIdx, 'agent must strip .git before configure_git_credentials.sh runs');
  const execStep = flow.jobs.agent.steps.find((step) => step.id === 'agentic_execution');
  assert.ok(execStep?.run, 'agentic_execution step must exist');
  assert.doesNotMatch(execStep.run, /--allow-tool ['"]?shell\(/, 'agent must not be granted any shell tools');
  assert.doesNotMatch(execStep.run, /--allow-tool github\b/, 'agent must not be granted GitHub MCP tools');
  assert.match(execStep.run, /--allow-tool mcpscripts\b/);
  assert.match(execStep.run, /--allow-tool safeoutputs\b/);
  assert.match(execStep.run, /--available-tools mcpscripts,safeoutputs\b/);
  assert.match(execStep.run, /--deny-tool shell\b/);
  assert.match(execStep.run, /--deny-tool write\b/);
  assert.match(execStep.run, /--deny-tool url\b/);

  // Threat detection must fail closed (not warn mode)
  const detConclusion = flow.jobs.detection.steps.find((step) => step.id === 'detection_conclusion');
  assert.ok(detConclusion, 'detection_conclusion step must exist');
  assert.notEqual(detConclusion['continue-on-error'], true, 'detection_conclusion must not continue-on-error');
  assert.equal(detConclusion.env?.GH_AW_DETECTION_CONTINUE_ON_ERROR, 'false', 'detection must enforce continue-on-error: false');

  // Conclusion issue-reporting flags must all be disabled
  assert.doesNotMatch(lockText, /GH_AW_NOOP_REPORT_AS_ISSUE:\s*"true"/);
  assert.doesNotMatch(lockText, /GH_AW_FAILURE_REPORT_AS_ISSUE:\s*"true"/);
  assert.doesNotMatch(lockText, /GH_AW_MISSING_TOOL_CREATE_ISSUE:\s*"true"/);
  assert.doesNotMatch(lockText, /GH_AW_REPORT_INCOMPLETE_CREATE_ISSUE:\s*"true"/);

  // Only upsert_unused_code_bead may hold contents: write, gated on default branch + clean detection verdict + same github.sha
  const jobsWithContentsWrite = Object.entries(flow.jobs)
    .filter(([, job]) => job?.permissions?.contents === 'write')
    .map(([id]) => id);
  assert.deepEqual(jobsWithContentsWrite, ['upsert_unused_code_bead'], 'only the deterministic safe-outputs job may hold contents: write');

  const safeJob = flow.jobs.upsert_unused_code_bead;
  assert.ok(safeJob.needs.includes('agent') && safeJob.needs.includes('detection'));
  assert.match(safeJob.if, /github\.ref == format\('refs\/heads\/\{0\}', github\.event\.repository\.default_branch\)/);
  assert.match(safeJob.if, /needs\.detection\.result == 'success'/);
  assert.match(safeJob.if, /needs\.detection\.outputs\.detection_success == 'true'/);
  assert.match(safeJob.if, /needs\.detection\.outputs\.detection_conclusion == 'success'/);
  const checkoutStep = safeJob.steps.find((step) => typeof step.uses === 'string' && step.uses.startsWith('actions/checkout@'));
  assert.equal(checkoutStep?.with?.['persist-credentials'], false, 'checkout must not persist credentials on disk');
  assert.equal(checkoutStep?.with?.ref, '${{ github.sha }}', 'applier checkout must pin to the exact same github.sha as agent');
  const applyStep = safeJob.steps.find((step) => step.id === 'apply');
  assert.match(applyStep?.run ?? '', /if \[ "\$\{GITHUB_REF\}" != "refs\/heads\/\$\{DEFAULT_BRANCH\}" \]/, 'apply step must enforce exact case-sensitive default branch');
  assert.match(applyStep?.run ?? '', /node scripts\/apply-beads-safe-outputs\.mjs/);
  assert.match(applyStep?.run ?? '', /--require-clean-detection/);
  assert.equal(applyStep?.env?.DEFAULT_BRANCH, '${{ github.event.repository.default_branch }}');
  assert.equal(applyStep?.env?.GH_AW_DETECTION_SUCCESS, '${{ needs.detection.outputs.detection_success }}');
  assert.equal(typeof applyStep?.['timeout-minutes'], 'number');
});

test('unused-code-triage mcp-scripts enforce strict file caps, byte caps, and ancestor symlink checks', (t) => {
  const mdText = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'unused-code-triage.md'), 'utf8');
  const fmMatch = mdText.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const fm = YAML.parse(fmMatch[1]);
  const scripts = fm['mcp-scripts'];

  const scratch = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'mcp-scripts-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  mkdirSync(join(scratch, 'apps', 'many', 'dir-a'), { recursive: true });
  mkdirSync(join(scratch, 'apps', 'many', 'dir-b'), { recursive: true });
  for (let i = 0; i < 260; i++) {
    writeFileSync(join(scratch, 'apps', 'many', 'dir-a', `f${String(i).padStart(3, '0')}.js`), 'x\n', 'utf8');
    writeFileSync(join(scratch, 'apps', 'many', 'dir-b', `g${String(i).padStart(3, '0')}.js`), 'y\n', 'utf8');
  }
  writeFileSync(join(scratch, 'apps', 'many', 'huge.js'), `${'😀'.repeat(12000)}TAIL_MARKER\n`, 'utf8');

  const outsideQa = join(scratch, 'outside-qa');
  mkdirSync(join(outsideQa, 'unused-code'), { recursive: true });
  writeFileSync(join(outsideQa, 'unused-code', 'summary.md'), 'leaked\n', 'utf8');
  symlinkSync(outsideQa, join(scratch, 'quality-artifacts'));

  const runTool = (toolName, inputs) => {
    const paramNames = Object.keys(scripts[toolName].inputs);
    const code = `const execute = async (inputs) => { const { ${paramNames.join(', ')} } = inputs || {}; ${scripts[toolName].script} }; execute(${JSON.stringify(inputs)}).then((r) => console.log(JSON.stringify(r)));`;
    return spawnSync(process.execPath, ['-e', code], {
      cwd: scratch,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_WORKSPACE: scratch },
    });
  };

  // list_app_files strictly caps at 500 across two directories
  const listed = runTool('list_app_files', { app: 'many' });
  assert.equal(listed.status, 0, listed.stderr);
  const listOut = JSON.parse(listed.stdout);
  assert.equal(listOut.count, 500);
  assert.equal(listOut.files.length, 500);
  assert.equal(listOut.truncated, true);

  // read_app_file caps output strictly at 32768 UTF-8 bytes even for multi-byte Unicode and supports char_offset paging to the tail
  const readPage1 = runTool('read_app_file', { app: 'many', file: 'apps/many/huge.js' });
  assert.equal(readPage1.status, 0, readPage1.stderr);
  const page1 = JSON.parse(readPage1.stdout);
  assert.equal(page1.truncated, true);
  assert.ok(Buffer.byteLength(page1.content, 'utf8') <= 32768, 'UTF-8 output must never exceed 32768 bytes');
  assert.equal(typeof page1.next_char_offset, 'number');

  const readPage2 = runTool('read_app_file', { app: 'many', file: 'apps/many/huge.js', char_offset: page1.next_char_offset });
  assert.equal(readPage2.status, 0, readPage2.stderr);
  const page2 = JSON.parse(readPage2.stdout);
  assert.equal(page2.truncated, false);
  assert.equal(page2.next_char_offset, null);
  assert.ok(page2.content.endsWith('TAIL_MARKER\n'), 'char_offset paging must recover the tail of a long single-line file');

  // read_triage_artifact rejects symlinked quality-artifacts parent directory
  const symArtifact = runTool('read_triage_artifact', { name: 'summary.md' });
  assert.notEqual(symArtifact.status, 0);
  assert.match(symArtifact.stderr, /Artifact directory invalid/);
});

test('gh-aw triage workflow and safe-outputs bridge select no apps or site builds in app-plan', async () => {
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(REPO_ROOT);
  const plan = createAppPlan(registry, [
    '.github/workflows/unused-code-triage.md',
    '.github/workflows/unused-code-triage.lock.yml',
    '.github/aw/actions-lock.json',
    'scripts/lib/beads-safe-outputs.mjs',
    'scripts/apply-beads-safe-outputs.mjs',
    'test/beads-safe-outputs.test.mjs',
    'test/ci-policy.test.mjs',
    'test/workflow-action-runtimes.test.mjs',
    'scripts/lib/ci-measures.mjs',
    'docs/architecture/beads-memory.md',
  ], graph);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
  assert.equal(plan.reasons.fallback, null);
});
