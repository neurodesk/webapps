import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  BEAD_KINDS,
  BEAD_STATUSES,
  BeadsConflictError,
  BeadsValidationError,
  DEFAULT_BEADS_REF,
  LIMITS,
  SCHEMA_VERSION,
  SCOPE_TYPES,
  applyOperations,
  assertMemoryRef,
  commitBeadsToRef,
  deriveBeadId,
  detectDependencyCycle,
  formatJsonl,
  generateBeadId,
  hasActiveLease,
  initBeadsRef,
  isBlockedByDeps,
  isSingleAppScope,
  listBeads,
  mergeBeadsMaps,
  mutateBeadsRef,
  parseJsonl,
  readBeadsFromRef,
  readyBeads,
  summarizeBeads,
  syncBeadsRef,
  validateBead,
  validateBeadsGraph,
} from '../scripts/lib/beads.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';

const CLI = join(repoRoot, 'scripts', 'beads.mjs');

function makeTempDir(prefix) {
  const base = process.env.TMPDIR || tmpdir();
  return mkdtempSync(join(base, prefix));
}

function initGitRepo(dir) {
  execFileSync('git', ['init', '-b', 'main'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.name', 'Test User'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir, stdio: 'ignore' });
  writeFileSync(join(dir, 'README.md'), '# test\n', 'utf8');
  execFileSync('git', ['add', 'README.md'], { cwd: dir, stdio: 'ignore' });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: dir, stdio: 'ignore' });
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8' });
}

test('schema validation, deterministic dedupe IDs, bounds, ref validation, and JSONL round-trip', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.ok(BEAD_KINDS.includes('maintenance'));
  assert.ok(BEAD_STATUSES.includes('open'));
  assert.ok(SCOPE_TYPES.includes('app'));

  assert.equal(assertMemoryRef(DEFAULT_BEADS_REF), DEFAULT_BEADS_REF);
  assert.equal(assertMemoryRef('refs/heads/memory/pilot-1'), 'refs/heads/memory/pilot-1');
  for (const bad of ['refs/heads/main', 'main', 'refs/heads/memory/../main', 'refs/heads/memory/bad.lock', '--all']) {
    assert.throws(() => assertMemoryRef(bad), BeadsValidationError, bad);
  }

  const id1 = deriveBeadId('knip:apps/zarro/src/foo.js:unusedExport');
  const id2 = deriveBeadId('knip:apps/zarro/src/foo.js:unusedExport');
  assert.equal(id1, id2);
  assert.match(id1, /^bd-[0-9a-f]{8}$/);
  assert.match(generateBeadId(new Set([id1])), /^bd-[0-9a-f]{8}$/);

  const now = new Date('2026-11-26T00:00:00.000Z');
  const applied = applyOperations(new Map(), [{
    op: 'upsert',
    dedupeKey: 'agents:topofit:niimath-stl',
    title: 'Drop direct niimath callMain path in topofit',
    summary: 'Switch to fluent Niimath STL output once >= 1.4.20261114 is adopted.',
    kind: 'maintenance',
    priority: 1,
    scope: { type: 'app', targets: ['topofit'] },
    links: { evidence: ['apps/topofit/AGENTS.md'] },
    note: 'Seeded from AGENTS.md cleanup',
  }], { actor: 'pilot', now });

  assert.equal(applied.createdIds.length, 1);
  const bead = applied.beads.get(applied.createdIds[0]);
  assert.equal(bead.revision, 1);
  assert.equal(isSingleAppScope(bead), true);
  assert.equal(validateBead(bead).id, bead.id);

  // Round-trip through JSONL interchange format
  const jsonl = formatJsonl(applied.beads);
  const parsed = parseJsonl(jsonl);
  assert.deepEqual(parsed.get(bead.id), bead);
  // Duplicate IDs in JSONL are rejected
  assert.throws(() => parseJsonl(`${jsonl}${jsonl}`), BeadsConflictError);

  // Reject overlong title, invalid scope, and unknown fields
  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'x'.repeat(LIMITS.title + 1),
    scope: { type: 'repo', targets: [] },
  }]), BeadsValidationError);

  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'Missing app target',
    scope: { type: 'app', targets: [] },
  }]), BeadsValidationError);

  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'Unknown field',
    scope: { type: 'repo', targets: [] },
    evilField: 123,
  }]), BeadsValidationError);

  // Reject non-array evidence (string must not spread char-by-char)
  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'Bad evidence',
    scope: { type: 'repo', targets: [] },
    links: { evidence: 'apps/topofit/AGENTS.md' },
  }]), BeadsValidationError);
});

test('dependency graph validates parent/discoveredFrom, prevents cycles, and readyBeads filters blocked and leased items', () => {
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  const t1 = new Date('2026-11-26T01:00:00.000Z');
  const tExpired = new Date('2026-11-28T00:00:00.000Z');

  // Dangling parent or discoveredFrom is rejected
  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'Dangling parent',
    scope: { type: 'repo', targets: [] },
    deps: { parent: 'bd-00000001' },
  }], { now: t0 }), BeadsValidationError);

  let state = applyOperations(new Map(), [
    {
      op: 'create',
      dedupeKey: 'blocker:a',
      title: 'Fix upstream blocker A',
      kind: 'blocker',
      priority: 1,
      scope: { type: 'package', targets: ['runtime-support'] },
    },
    {
      op: 'create',
      dedupeKey: 'task:b',
      title: 'Unpin FreeBrowse in topofit',
      kind: 'maintenance',
      priority: 0,
      scope: { type: 'app', targets: ['topofit'] },
    },
  ], { actor: 'pilot', now: t0 }).beads;

  const idA = deriveBeadId('blocker:a');
  const idB = deriveBeadId('task:b');

  state = applyOperations(state, [{ op: 'dep_add', id: idB, blockedBy: idA }], { actor: 'pilot', now: t0 }).beads;
  assert.equal(isBlockedByDeps(state.get(idB), state), true);
  assert.equal(detectDependencyCycle(state, idA, idB), true);
  validateBeadsGraph(state);

  // Cycle must be rejected
  assert.throws(() => applyOperations(state, [{ op: 'dep_add', id: idA, blockedBy: idB }], { now: t0 }), BeadsValidationError);

  // Only A is ready while A is open
  assert.deepEqual(readyBeads(state, { now: t0 }).map((b) => b.id), [idA]);
  assert.deepEqual(readyBeads(state, { now: t0, singleAppOnly: true }).map((b) => b.id), []);

  // Claim A -> nothing ready at t1; conflicting claim by another owner fails
  state = applyOperations(state, [{ op: 'claim', id: idA, owner: 't3/worktree-a', branch: 'agent/fix-a', ttlHours: 24 }], { now: t0 }).beads;
  assert.equal(hasActiveLease(state.get(idA), t1.getTime()), true);
  assert.deepEqual(readyBeads(state, { now: t1 }).map((b) => b.id), []);
  assert.throws(() => applyOperations(state, [{ op: 'claim', id: idA, owner: 'gh-aw/run-9' }], { now: t1 }), BeadsConflictError);

  // Once lease expires, A becomes ready again
  assert.deepEqual(readyBeads(state, { now: tExpired }).map((b) => b.id), [idA]);

  // Close A -> B unblocks and becomes ready (and matches singleAppOnly)
  state = applyOperations(state, [{ op: 'close', id: idA, reason: 'Published upstream', pr: 999 }], { actor: 'pilot', now: t1 }).beads;
  assert.deepEqual(readyBeads(state, { now: t1, singleAppOnly: true }).map((b) => b.id), [idB]);
  assert.equal(listBeads(state, { status: 'closed' }).length, 1);

  const snapshot = summarizeBeads(state, { now: t1 });
  assert.equal(snapshot.openCount, 1);
  assert.equal(snapshot.items[0].id, idB);
  assert.equal(snapshot.items[0].blocked, false);
});

test('safe-outputs applier enforces revision checks on upserts, resulting single-app scope, caps, actor lock, and later-time replay', () => {
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  const tLater = new Date('2026-11-26T02:00:00.000Z');
  const safeOpts = {
    actor: 'gh-aw/unused-code',
    maxCreates: 5,
    maxUpdates: 2,
    requireExpectedRevision: true,
    singleAppOnly: true,
    lockActor: true,
  };
  const op = {
    op: 'upsert',
    dedupeKey: 'knip:apps/syncro/src/dead.js:unusedExport',
    title: 'Remove unused export in syncro',
    summary: 'Confirmed dead export.',
    kind: 'maintenance',
    scope: { type: 'app', targets: ['syncro'] },
    links: { evidence: ['quality-artifacts/unused-code/knip.json'] },
    note: 'Detected in weekly Knip scan',
  };

  // First run creates the bead
  const first = applyOperations(new Map(), [op], { ...safeOpts, now: t0 });
  assert.equal(first.createdIds.length, 1);
  const id = first.createdIds[0];

  // Replaying exact same op at a LATER timestamp is still a zero-churn no-op
  const replay = applyOperations(first.beads, [op], { ...safeOpts, now: tLater });
  assert.equal(replay.createdIds.length, 0);
  assert.equal(replay.updatedIds.length, 0);
  assert.equal(replay.untouchedIds.length, 1);
  assert.equal(replay.beads.get(id).revision, 1);
  assert.equal(replay.beads.get(id).journal.length, 1);

  // Modifying an existing bead via upsert in safe mode MUST provide fresh expectedRevision
  const changedUpsert = { ...op, summary: 'Updated summary after second scan' };
  assert.throws(() => applyOperations(first.beads, [changedUpsert], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.throws(() => applyOperations(first.beads, [{ ...changedUpsert, expectedRevision: 99 }], { ...safeOpts, now: tLater }), BeadsConflictError);
  const updated = applyOperations(first.beads, [{ ...changedUpsert, expectedRevision: 1 }], { ...safeOpts, now: tLater });
  assert.equal(updated.beads.get(id).revision, 2);

  // Conflicting id + dedupeKey is rejected
  assert.throws(() => applyOperations(updated.beads, [{ ...op, id: 'bd-00000001', expectedRevision: 2 }], { ...safeOpts, now: tLater }), BeadsConflictError);

  // Single-app update cannot widen scope to shared/repo/multi-app
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'update',
    id,
    expectedRevision: 2,
    scope: { type: 'shared', targets: ['components'] },
  }], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'update',
    id,
    expectedRevision: 2,
    scope: { type: 'app', targets: ['syncro', 'topofit'] },
  }], { ...safeOpts, now: tLater }), BeadsValidationError);

  // Generic update cannot bypass close/claim lifecycle
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'update',
    id,
    expectedRevision: 2,
    status: 'closed',
  }], { ...safeOpts, now: tLater }), BeadsValidationError);

  // Safe mode locks actor and forbids force release / non-boolean force
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'note',
    id,
    expectedRevision: 2,
    actor: 'spoofed-maintainer',
    note: 'Forged actor',
  }], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'release',
    id,
    expectedRevision: 2,
    force: true,
  }], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'release',
    id,
    expectedRevision: 2,
    force: 'yes',
  }], { ...safeOpts, lockActor: false, now: tLater }), BeadsValidationError);

  // Safe mode enforces maxUpdates cap atomically
  assert.throws(() => applyOperations(updated.beads, [
    { op: 'note', id, expectedRevision: 2, note: 'n1' },
    { op: 'note', id, expectedRevision: 3, note: 'n2' },
    { op: 'note', id, expectedRevision: 4, note: 'n3' },
  ], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.equal(updated.beads.get(id).revision, 2);

  // Safe mode enforces maxCreates cap atomically
  const tooMany = Array.from({ length: 3 }, (_, i) => ({
    op: 'create',
    title: `Item ${i}`,
    scope: { type: 'app', targets: ['syncro'] },
  }));
  assert.throws(() => applyOperations(updated.beads, tooMany, { ...safeOpts, maxCreates: 2, now: tLater }), BeadsValidationError);
  assert.equal(updated.beads.size, 1);
});

test('mergeBeadsMaps preserves closed status, bumps revision on merge, caps evidence, and rejects merge cycles', () => {
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  const t1 = new Date('2026-11-26T01:00:00.000Z');
  const t2 = new Date('2026-11-26T02:00:00.000Z');

  const base = applyOperations(new Map(), [
    { op: 'create', dedupeKey: 'm:a', title: 'A', scope: { type: 'app', targets: ['topofit'] } },
    { op: 'create', dedupeKey: 'm:b', title: 'B', scope: { type: 'app', targets: ['elastix'] } },
  ], { actor: 'init', now: t0 }).beads;
  const idA = deriveBeadId('m:a');
  const idB = deriveBeadId('m:b');

  // Side 1 closes A at t1; Side 2 concurrently adds a note to A at t2 (higher timestamp, still open)
  const closedSide = applyOperations(base, [{ op: 'close', id: idA, reason: 'Fixed in PR #10' }], { actor: 'host-1', now: t1 }).beads;
  const noteSide = applyOperations(base, [{ op: 'note', id: idA, note: 'Late comment' }], { actor: 'host-2', now: t2 }).beads;
  const merged = mergeBeadsMaps(noteSide, closedSide);
  assert.equal(merged.get(idA).status, 'closed');
  assert.equal(merged.get(idA).revision, 3);
  assert.ok(merged.get(idA).journal.some((e) => e.note === 'Late comment'));

  // Evidence lists exceeding LIMITS.evidence when combined are capped cleanly instead of aborting
  const ev1 = Array.from({ length: 15 }, (_, i) => `docs/ev-a-${String(i).padStart(2, '0')}.md`);
  const ev2 = Array.from({ length: 15 }, (_, i) => `docs/ev-b-${String(i).padStart(2, '0')}.md`);
  const s1 = applyOperations(base, [{ op: 'update', id: idA, links: { evidence: ev1 } }], { now: t1 }).beads;
  const s2 = applyOperations(base, [{ op: 'update', id: idA, links: { evidence: ev2 } }], { now: t2 }).beads;
  const evMerged = mergeBeadsMaps(s1, s2);
  assert.equal(evMerged.get(idA).links.evidence.length, LIMITS.evidence);

  // Two individually acyclic histories that combine into a cycle must be rejected
  const dep1 = applyOperations(base, [{ op: 'dep_add', id: idA, blockedBy: idB }], { now: t1 }).beads;
  const dep2 = applyOperations(base, [{ op: 'dep_add', id: idB, blockedBy: idA }], { now: t2 }).beads;
  assert.throws(() => mergeBeadsMaps(dep1, dep2), BeadsConflictError);
});

test('git orphan-branch store handles subdirectories, CAS bootstrap, fast-forward sync, error propagation, and CLI safe mode', () => {
  const root = makeTempDir('beads-git-');
  const mainRepo = join(root, 'main');
  const worktreeB = join(root, 'wt-b');
  const bareRemote = join(root, 'remote.git');
  try {
    mkdirSync(mainRepo, { recursive: true });
    mkdirSync(bareRemote, { recursive: true });
    execFileSync('git', ['init', '--bare'], { cwd: bareRemote, stdio: 'ignore' });
    initGitRepo(mainRepo);
    execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: mainRepo, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: mainRepo, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-b', 'feat-b', worktreeB, 'main'], { cwd: mainRepo, stdio: 'ignore' });

    const subDir = join(mainRepo, 'nested', 'deep');
    mkdirSync(subDir, { recursive: true });

    const init = initBeadsRef(mainRepo);
    assert.equal(init.created, true);
    assert.equal(initBeadsRef(worktreeB).created, false);

    // Create bead at repo root, then mutate from a nested subdirectory -> MUST preserve existing bead
    const created = mutateBeadsRef(mainRepo, [{
      op: 'upsert',
      dedupeKey: 'pilot:wt-handoff',
      title: 'Cross-worktree handoff bead',
      scope: { type: 'app', targets: ['elastix'] },
    }], { actor: 't3/wt-a' });
    const beadId = created.createdIds[0];

    const fromSub = mutateBeadsRef(subDir, [{
      op: 'upsert',
      dedupeKey: 'pilot:from-subdir',
      title: 'Added from nested directory',
      scope: { type: 'app', targets: ['topofit'] },
    }], { actor: 't3/sub' });
    assert.equal(fromSub.beads.size, 2);
    assert.ok(fromSub.beads.has(beadId));
    assert.equal(readBeadsFromRef(subDir).beads.size, 2);

    // Claim in parallel worktree B
    const claimed = mutateBeadsRef(worktreeB, [{
      op: 'claim',
      id: beadId,
      owner: 't3/wt-b',
      branch: 'feat-b',
      expectedRevision: 1,
    }], { actor: 't3/wt-b' });
    assert.equal(claimed.beads.get(beadId).revision, 2);

    // Both worktrees remain 100% clean with zero diff against main
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: mainRepo, encoding: 'utf8' }), '');
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: worktreeB, encoding: 'utf8' }), '');
    assert.equal(execFileSync('git', ['diff', 'main'], { cwd: worktreeB, encoding: 'utf8' }), '');

    // Direct CAS failure throws BeadsConflictError when parent SHA is stale
    assert.throws(() => commitBeadsToRef(mainRepo, created.beads, {
      ref: DEFAULT_BEADS_REF,
      expectedParentSha: init.sha,
      message: 'stale write',
    }), BeadsConflictError);

    // Push memory/beads to bare remote
    const pushed = syncBeadsRef(mainRepo, { remote: 'origin', push: true });
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.count, 2);

    // Clone C syncs (bootstrap), then fast-forwards when mainRepo advances (NO merge commit!)
    const cloneC = join(root, 'clone-c');
    execFileSync('git', ['clone', bareRemote, cloneC], { stdio: 'ignore' });
    const boot = syncBeadsRef(cloneC, { remote: 'origin', push: false });
    assert.equal(boot.count, 2);

    mutateBeadsRef(mainRepo, [{ op: 'note', id: beadId, note: 'Ahead on host A' }], { actor: 'host-a' });
    const aheadSha = syncBeadsRef(mainRepo, { remote: 'origin', push: true }).sha;
    const ff = syncBeadsRef(cloneC, { remote: 'origin', push: false });
    assert.equal(ff.sha, aheadSha, 'fast-forward should not create a merge commit');

    // Divergent sync merges both sides cleanly
    mutateBeadsRef(mainRepo, [
      { op: 'note', id: beadId, note: 'Note from host A' },
      { op: 'upsert', dedupeKey: 'pilot:from-a', title: 'From A', scope: { type: 'repo', targets: [] } },
    ], { actor: 'host-a' });
    syncBeadsRef(mainRepo, { remote: 'origin', push: true });

    mutateBeadsRef(cloneC, [
      { op: 'note', id: beadId, note: 'Note from host C' },
      { op: 'upsert', dedupeKey: 'pilot:from-c', title: 'From C', scope: { type: 'repo', targets: [] } },
    ], { actor: 'host-c' });
    const synced = syncBeadsRef(cloneC, { remote: 'origin', push: true });
    assert.equal(synced.count, 4);

    const { beads } = readBeadsFromRef(cloneC);
    const notes = beads.get(beadId).journal.map((entry) => entry.note);
    assert.ok(notes.includes('Note from host A'));
    assert.ok(notes.includes('Note from host C'));

    // Broken remote transport must throw, not succeed silently
    execFileSync('git', ['remote', 'add', 'broken', join(root, 'does-not-exist.git')], { cwd: cloneC, stdio: 'ignore' });
    assert.throws(() => syncBeadsRef(cloneC, { remote: 'broken', push: false }), /Failed to query remote/);
    // Unconfigured / flag-like remote rejected
    assert.throws(() => syncBeadsRef(cloneC, { remote: '--upload-pack=evil', push: false }), BeadsValidationError);

    // CLI-level validation & safe apply tests
    assert.notEqual(runCli(cloneC, ['list', '--ref', 'refs/heads/main']).status, 0);
    assert.notEqual(runCli(cloneC, ['export', '--format', 'xml']).status, 0);
    assert.notEqual(runCli(cloneC, ['create', '--title', 'Bad int', '--scope', 'repo', '--priority', '1abc']).status, 0);
    assert.notEqual(runCli(cloneC, ['create', '--title', 'Bad scope', '--scope', 'app:a:b']).status, 0);
    assert.notEqual(runCli(cloneC, ['claim', beadId, '--ttl-hours', '24h']).status, 0);

    const badEnvelope = join(root, 'bad.json');
    writeFileSync(badEnvelope, 'null\n', 'utf8');
    assert.notEqual(runCli(cloneC, ['apply', badEnvelope, '--safe']).status, 0);

    const safeOpsFile = join(root, 'safe-ops.json');
    writeFileSync(safeOpsFile, JSON.stringify({
      operations: [{
        op: 'upsert',
        dedupeKey: 'cli:safe-test',
        title: 'CLI safe upsert',
        scope: { type: 'app', targets: ['zarro'] },
      }],
    }), 'utf8');
    const safeRes = runCli(cloneC, ['apply', safeOpsFile, '--safe', '--single-app', '--actor', 'gh-aw/test', '--json']);
    assert.equal(safeRes.status, 0, safeRes.stderr);
    assert.equal(JSON.parse(safeRes.stdout).createdIds.length, 1);

    // Upsert CLI forwards --expected-revision and rejects stale revision
    const staleUpsert = runCli(cloneC, [
      'upsert',
      '--dedupe-key', 'cli:safe-test',
      '--summary', 'Changed summary',
      '--expected-revision', '99',
    ]);
    assert.notEqual(staleUpsert.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('beads tooling and docs never trigger app selection or site builds in app-plan', async () => {
  const registry = await loadAppsRegistry();
  const graph = await loadConservativeWorkspaceGraph(repoRoot);
  const plan = createAppPlan(registry, [
    'scripts/beads.mjs',
    'scripts/lib/beads.mjs',
    'test/beads.test.mjs',
    'docs/architecture/beads-memory.md',
  ], graph);
  assert.deepEqual(plan.selected, []);
  assert.equal(plan.site, false);
  assert.equal(plan.reasons.fallback, null);
});
