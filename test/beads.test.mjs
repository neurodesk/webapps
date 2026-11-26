import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
} from '../scripts/lib/beads.mjs';
import { createAppPlan } from '../scripts/lib/app-plan.mjs';
import { loadAppsRegistry, repoRoot } from '../scripts/lib/apps-registry.mjs';
import { loadConservativeWorkspaceGraph } from '../scripts/lib/workspace-graph.mjs';

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

test('schema validation, deterministic dedupe IDs, bounds, and JSONL round-trip', () => {
  assert.equal(SCHEMA_VERSION, 1);
  assert.ok(BEAD_KINDS.includes('maintenance'));
  assert.ok(BEAD_STATUSES.includes('open'));
  assert.ok(SCOPE_TYPES.includes('app'));

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

  // Reject overlong title and invalid scope
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
});

test('dependency graph prevents cycles and readyBeads filters blocked and leased items', () => {
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  const t1 = new Date('2026-11-26T01:00:00.000Z');
  const tExpired = new Date('2026-11-28T00:00:00.000Z');

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

test('safe-outputs applier enforces batch caps, expectedRevision, single-app scope, and idempotent replay', () => {
  const t0 = new Date('2026-11-26T00:00:00.000Z');
  const op = {
    op: 'upsert',
    dedupeKey: 'knip:apps/syncro/src/dead.js:unusedExport',
    title: 'Remove unused export in syncro',
    kind: 'maintenance',
    scope: { type: 'app', targets: ['syncro'] },
    links: { evidence: ['quality-artifacts/unused-code/knip.json'] },
  };

  // First run creates the bead
  const first = applyOperations(new Map(), [op], { actor: 'gh-aw/unused-code', now: t0, maxCreates: 5, maxUpdates: 10, requireExpectedRevision: true, singleAppOnly: true });
  assert.equal(first.createdIds.length, 1);
  const id = first.createdIds[0];

  // Replaying exact same op at same timestamp is a no-op (zero duplicates, zero revision churn)
  const replay = applyOperations(first.beads, [op], { actor: 'gh-aw/unused-code', now: t0, maxCreates: 5, maxUpdates: 10, requireExpectedRevision: true, singleAppOnly: true });
  assert.equal(replay.createdIds.length, 0);
  assert.equal(replay.updatedIds.length, 0);
  assert.equal(replay.untouchedIds.length, 1);
  assert.equal(replay.beads.get(id).revision, 1);

  // Safe mode rejects missing or stale expectedRevision on updates
  assert.throws(() => applyOperations(first.beads, [{ op: 'note', id, note: 'Missing rev' }], { requireExpectedRevision: true }), BeadsValidationError);
  assert.throws(() => applyOperations(first.beads, [{ op: 'note', id, note: 'Stale rev', expectedRevision: 99 }], { requireExpectedRevision: true }), BeadsConflictError);

  // Safe mode rejects shared-scope beads when singleAppOnly is set
  assert.throws(() => applyOperations(first.beads, [{
    op: 'upsert',
    dedupeKey: 'knip:packages/components/src/x.js',
    title: 'Shared change',
    scope: { type: 'shared', targets: ['components'] },
  }], { singleAppOnly: true }), BeadsValidationError);

  // Safe mode enforces maxCreates cap atomically (zero partial mutations)
  const tooMany = Array.from({ length: 3 }, (_, i) => ({
    op: 'create',
    title: `Item ${i}`,
    scope: { type: 'app', targets: ['syncro'] },
  }));
  assert.throws(() => applyOperations(first.beads, tooMany, { maxCreates: 2 }), BeadsValidationError);
  assert.equal(first.beads.size, 1);
});

test('git orphan-branch store coordinates across parallel worktrees with zero main diff and merges remote sync', () => {
  const root = makeTempDir('beads-git-');
  const mainRepo = join(root, 'main');
  const worktreeB = join(root, 'wt-b');
  const bareRemote = join(root, 'remote.git');
  try {
    execFileSync('mkdir', ['-p', mainRepo, bareRemote]);
    execFileSync('git', ['init', '--bare'], { cwd: bareRemote, stdio: 'ignore' });
    initGitRepo(mainRepo);
    execFileSync('git', ['remote', 'add', 'origin', bareRemote], { cwd: mainRepo, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: mainRepo, stdio: 'ignore' });
    execFileSync('git', ['worktree', 'add', '-b', 'feat-b', worktreeB, 'main'], { cwd: mainRepo, stdio: 'ignore' });

    const init = initBeadsRef(mainRepo);
    assert.equal(init.created, true);
    assert.equal(initBeadsRef(worktreeB).created, false);

    // Create in main worktree, claim in parallel worktree B
    const created = mutateBeadsRef(mainRepo, [{
      op: 'upsert',
      dedupeKey: 'pilot:wt-handoff',
      title: 'Cross-worktree handoff bead',
      scope: { type: 'app', targets: ['elastix'] },
    }], { actor: 't3/wt-a' });
    const beadId = created.createdIds[0];

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

    // Push memory/beads to bare remote, then simulate divergent clone sync
    const pushed = syncBeadsRef(mainRepo, { remote: 'origin', push: true });
    assert.equal(pushed.pushed, true);
    assert.equal(pushed.count, 1);

    const cloneC = join(root, 'clone-c');
    execFileSync('git', ['clone', bareRemote, cloneC], { stdio: 'ignore' });
    syncBeadsRef(cloneC, { remote: 'origin', push: false });

    // Diverge: mainRepo adds a note + new bead; cloneC adds another note + another bead
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
    assert.equal(synced.count, 3);

    const { beads } = readBeadsFromRef(cloneC);
    const notes = beads.get(beadId).journal.map((entry) => entry.note);
    assert.ok(notes.includes('Note from host A'));
    assert.ok(notes.includes('Note from host C'));
    assert.equal(mergeBeadsMaps(beads, beads).size, 3);
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
