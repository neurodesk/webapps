import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
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

  // Reject non-array evidence (string must not spread char-by-char), note: false, and unsafe integer revisions
  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'Bad evidence',
    scope: { type: 'repo', targets: [] },
    links: { evidence: 'apps/topofit/AGENTS.md' },
  }]), BeadsValidationError);
  assert.throws(() => applyOperations(new Map(), [{
    op: 'create',
    title: 'Bad boolean note',
    scope: { type: 'repo', targets: [] },
    note: false,
  }]), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, revision: 2 ** 53 }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, priority: null }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, createdAt: 'November 26, 2026' }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, createdAt: '2026-02-30T12:00:00+01:00' }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, createdAt: '9999-12-31T23:30:00-02:00' }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, releasedLeases: ['junk'] }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, releasedLeases: ['v2:November 26, 2026|November 27, 2026|abcdef123456'] }), BeadsValidationError);
  assert.throws(() => validateBead({ ...bead, releasedLeases: ['v2:2026-11-26T00:00:00.000Z|2026-11-25T00:00:00.000Z|abcdef123456'] }), BeadsValidationError);
  assert.throws(() => applyOperations(new Map(), [{ op: 'create', title: 'Null prio', scope: { type: 'repo', targets: [] }, priority: null }]), BeadsValidationError);
  assert.throws(() => applyOperations(new Map(), [{ op: 'upsert', dedupeKey: 'k:null', title: 'Null prio', scope: { type: 'repo', targets: [] }, priority: null }]), BeadsValidationError);
  // Legacy schema-v1 records carrying leaseReleasedAt or "<claimedAt>|<owner>" tombstones survive repeated validation
  const legacyNull = validateBead({ ...bead, leaseReleasedAt: null });
  assert.equal(legacyNull.leaseFloorAt, null);
  const legacyTs = validateBead({ ...bead, leaseReleasedAt: '2026-11-26T00:30:00.000Z' });
  assert.equal(legacyTs.leaseFloorAt, '2026-11-26T00:30:00.000Z');
  const legacyTombstone = validateBead({ ...bead, releasedLeases: ['2026-11-26T00:00:00.000Z|worker|lane'] });
  assert.deepEqual(validateBead(legacyTombstone).releasedLeases, ['2026-11-26T00:00:00.000Z|worker|lane']);
  const legacyIsoLikeOwner = validateBead({ ...bead, releasedLeases: ['2026-11-26T00:00:00+00:00|2026-11-25T23:00:00.000Z|abcdef123456'] });
  assert.deepEqual(validateBead(legacyIsoLikeOwner).releasedLeases, ['2026-11-26T00:00:00.000Z|2026-11-25T23:00:00.000Z|abcdef123456']);
  const legacyOffsetOwner = validateBead({ ...bead, releasedLeases: ['2026-11-26T00:00:00.000Z|2026-11-26T06:00:00+01:00|abcdef123456'] });
  assert.deepEqual(validateBead(legacyOffsetOwner).releasedLeases, ['2026-11-26T00:00:00.000Z|2026-11-26T06:00:00+01:00|abcdef123456']);
  // Valid calendar ISO dates in years 0000-0099 (e.g. leap year 0000-02-29) are accepted
  assert.equal(validateBead({ ...bead, createdAt: '0000-02-29T12:00:00Z' }).createdAt, '0000-02-29T12:00:00.000Z');
  const maxSafeMap = new Map([[bead.id, { ...bead, revision: Number.MAX_SAFE_INTEGER }]]);
  assert.throws(() => applyOperations(maxSafeMap, [{ op: 'note', id: bead.id, note: 'overflow' }], { now }), BeadsValidationError);
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

  // Parent and discoveredFrom cycles must be rejected by validateBeadsGraph
  const parentCycle = new Map([
    [idA, { ...structuredClone(state.get(idA)), deps: { blockedBy: [], parent: idB, discoveredFrom: null } }],
    [idB, { ...structuredClone(state.get(idB)), deps: { blockedBy: [], parent: idA, discoveredFrom: null } }],
  ]);
  assert.throws(() => validateBeadsGraph(parentCycle), BeadsConflictError);
  const discoveredCycle = new Map([
    [idA, { ...structuredClone(state.get(idA)), deps: { blockedBy: [], parent: null, discoveredFrom: idB } }],
    [idB, { ...structuredClone(state.get(idB)), deps: { blockedBy: [], parent: null, discoveredFrom: idA } }],
  ]);
  assert.throws(() => validateBeadsGraph(discoveredCycle), BeadsConflictError);

  // Only A is ready while A is open
  assert.deepEqual(readyBeads(state, { now: t0 }).map((b) => b.id), [idA]);
  assert.deepEqual(readyBeads(state, { now: t0, singleAppOnly: true }).map((b) => b.id), []);

  // Claim A -> nothing ready at t1; conflicting claim by another owner fails
  state = applyOperations(state, [{ op: 'claim', id: idA, owner: 't3/worktree-a', branch: 'agent/fix-a', ttlHours: 24 }], { now: t0 }).beads;
  assert.equal(hasActiveLease(state.get(idA), t1.getTime()), true);
  assert.deepEqual(readyBeads(state, { now: t1 }).map((b) => b.id), []);
  assert.throws(() => applyOperations(state, [{ op: 'claim', id: idA, owner: 'gh-aw/run-9' }], { now: t1 }), BeadsConflictError);

  // Another actor cannot clear an active lease via update, reopen, or safe close
  assert.throws(() => applyOperations(state, [{ op: 'update', id: idA, status: 'open' }], { actor: 'other-actor', now: t1 }), BeadsConflictError);
  assert.throws(() => applyOperations(state, [{ op: 'update', id: idA, status: 'blocked' }], { actor: 'other-actor', now: t1 }), BeadsConflictError);
  assert.throws(() => applyOperations(state, [{ op: 'reopen', id: idA }], { actor: 'other-actor', now: t1 }), BeadsConflictError);
  assert.throws(() => applyOperations(state, [{ op: 'close', id: idA, reason: 'Try to steal lease' }], { actor: 'other-actor', lockActor: true, now: t1 }), BeadsConflictError);

  // Once lease expires, A becomes ready again
  assert.deepEqual(readyBeads(state, { now: tExpired }).map((b) => b.id), [idA]);

  // Close A with a max-length (500-char) reason succeeds cleanly -> B unblocks and becomes ready
  const maxReason = 'r'.repeat(LIMITS.closeReason);
  state = applyOperations(state, [{ op: 'close', id: idA, reason: maxReason, pr: 999 }], { actor: 'pilot', now: t1 }).beads;
  assert.equal(state.get(idA).closeReason.length, LIMITS.closeReason);
  assert.ok(state.get(idA).journal.at(-1).note.length <= LIMITS.note);
  assert.deepEqual(readyBeads(state, { now: t1, singleAppOnly: true }).map((b) => b.id), [idB]);
  assert.equal(listBeads(state, { status: 'closed' }).length, 1);

  const snapshot = summarizeBeads(state, { now: t1 });
  assert.equal(snapshot.openCount, 1);
  assert.equal(snapshot.items[0].id, idB);
  assert.equal(snapshot.items[0].blocked, false);
  assert.throws(() => summarizeBeads(state, { now: t1, maxItems: -1 }), BeadsValidationError);
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

  // Conflicting id + dedupeKey is rejected (including derived id vs legacy id)
  assert.throws(() => applyOperations(updated.beads, [{ ...op, id: 'bd-00000001', expectedRevision: 2 }], { ...safeOpts, now: tLater }), BeadsConflictError);
  const legacyBead = applyOperations(new Map(), [{
    op: 'create',
    id: 'bd-11111111',
    title: 'Legacy item',
    scope: { type: 'app', targets: ['syncro'] },
  }], { now: t0 }).beads;
  legacyBead.get('bd-11111111').dedupeKey = 'legacy:key';
  assert.throws(() => applyOperations(legacyBead, [{
    op: 'upsert',
    id: deriveBeadId('legacy:key'),
    dedupeKey: 'legacy:key',
    title: 'Legacy item',
    scope: { type: 'app', targets: ['syncro'] },
  }], { now: tLater }), BeadsConflictError);

  // Safe create and upsert require identity (dedupeKey or id), and upsert with expectedRevision must not create
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'create',
    title: 'No identity safe create',
    scope: { type: 'app', targets: ['syncro'] },
  }], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'upsert',
    title: 'No identity safe upsert',
    scope: { type: 'app', targets: ['syncro'] },
  }], { ...safeOpts, now: tLater }), BeadsValidationError);
  assert.throws(() => applyOperations(updated.beads, [{
    op: 'upsert',
    dedupeKey: 'knip:missing:item',
    title: 'Missing target with expectedRevision',
    scope: { type: 'app', targets: ['syncro'] },
    expectedRevision: 1,
  }], { ...safeOpts, now: tLater }), BeadsConflictError);

  // Existing unkeyed bead must reject an upsert that supplies a new dedupeKey
  const unkeyedMap = applyOperations(new Map(), [{
    op: 'create',
    id: 'bd-33333333',
    title: 'Unkeyed item',
    scope: { type: 'app', targets: ['syncro'] },
  }], { now: t0 }).beads;
  assert.throws(() => applyOperations(unkeyedMap, [{
    op: 'upsert',
    id: 'bd-33333333',
    dedupeKey: 'knip:cannot-attach',
    title: 'Unkeyed item',
    scope: { type: 'app', targets: ['syncro'] },
  }], { ...safeOpts, now: tLater }), BeadsConflictError);

  // Existing upserts must validate all supplied optional fields (including dangling deps) even when they would be a no-op
  for (const badPatch of [
    { title: 42 },
    { kind: 'not-a-kind' },
    { deps: { unknownDep: 'bd-00000001' } },
    { deps: { parent: 'bd-99999999' } },
    { links: false },
  ]) {
    assert.throws(() => applyOperations(updated.beads, [{
      op: 'upsert',
      dedupeKey: op.dedupeKey,
      ...badPatch,
    }], { ...safeOpts, now: tLater }), BeadsValidationError);
  }

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
    dedupeKey: `knip:cap:${i}`,
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

  // Side 1 closes A at t1; Side 2 concurrently adds a note reading "Reopened" at t2 (free text must NOT resurrect)
  const closedSide = applyOperations(base, [{ op: 'close', id: idA, reason: 'Fixed in PR #10' }], { actor: 'host-1', now: t1 }).beads;
  const noteSide = applyOperations(base, [{ op: 'note', id: idA, note: 'Reopened' }], { actor: 'host-2', now: t2 }).beads;
  const merged = mergeBeadsMaps(noteSide, closedSide);
  assert.equal(merged.get(idA).status, 'closed');
  assert.equal(merged.get(idA).revision, 3);
  assert.ok(merged.get(idA).journal.some((e) => e.note === 'Reopened'));

  // Explicit reopen with a custom note at t2 wins over a concurrent note at t3 on the closed branch
  const t3 = new Date('2026-11-26T03:00:00.000Z');
  const reopenedSide = applyOperations(closedSide, [{ op: 'reopen', id: idA, note: 'Regression reproduced on macOS' }], { actor: 'host-2', now: t2 }).beads;
  const closedWithLateNote = applyOperations(closedSide, [{ op: 'note', id: idA, note: 'Post-close audit note' }], { actor: 'host-1', now: t3 }).beads;
  const mergedReopen = mergeBeadsMaps(closedWithLateNote, reopenedSide);
  assert.equal(mergedReopen.get(idA).status, 'open');
  assert.equal(mergedReopen.get(idA).reopenedAt, t2.toISOString());
  assert.ok(mergedReopen.get(idA).journal.some((e) => e.note === 'Regression reproduced on macOS'));
  assert.ok(mergedReopen.get(idA).journal.some((e) => e.note === 'Post-close audit note'));

  // Divergent edits at the same revision MUST bump merged revision so stale expectedRevision fails
  const titleA = applyOperations(base, [{ op: 'update', id: idA, title: 'Title from host 1' }], { actor: 'host-1', now: t1 }).beads;
  const titleB = applyOperations(base, [{ op: 'update', id: idA, title: 'Title from host 2' }], { actor: 'host-2', now: t2 }).beads;
  const mergedTitles = mergeBeadsMaps(titleA, titleB);
  assert.equal(mergedTitles.get(idA).revision, 3);
  assert.throws(() => applyOperations(mergedTitles, [{
    op: 'update',
    id: idA,
    expectedRevision: 2,
    title: 'Stale overwrite attempt',
  }], { requireExpectedRevision: true, now: t3 }), BeadsConflictError);

  // 3-clone close/audit-notes/reopen: newer closedAt must survive audit notes so a stale reopen cannot undo it
  const closedWithManyNotes = applyOperations(closedSide, [
    { op: 'note', id: idA, note: 'Audit note 1' },
    { op: 'note', id: idA, note: 'Audit note 2' },
    { op: 'note', id: idA, note: 'Audit note 3' },
  ], { actor: 'host-1', now: t2 }).beads; // rev 5, closedAt = t1
  const reclosedNewer = applyOperations(reopenedSide, [
    { op: 'close', id: idA, reason: 'Fixed for real in PR #20' },
  ], { actor: 'host-3', now: t3 }).beads; // rev 4, closedAt = t3
  const mergedClosed = mergeBeadsMaps(closedWithManyNotes, reclosedNewer);
  assert.equal(mergedClosed.get(idA).status, 'closed');
  assert.equal(mergedClosed.get(idA).closedAt, t3.toISOString());
  const afterStaleReopen = mergeBeadsMaps(mergedClosed, reopenedSide);
  assert.equal(afterStaleReopen.get(idA).status, 'closed');
  assert.equal(afterStaleReopen.get(idA).closedAt, t3.toISOString());

  // Concurrent notes must NOT erase an active lease, whereas an explicit release after claim DOES clear it
  const claimedBranch = applyOperations(base, [
    { op: 'claim', id: idA, owner: 'worker-a', ttlHours: 24 },
  ], { actor: 'worker-a', now: t1 }).beads;
  const noisyNotesBranch = applyOperations(base, [
    { op: 'note', id: idA, note: 'Concurrent note 1' },
    { op: 'note', id: idA, note: 'Concurrent note 2' },
  ], { actor: 'triage-bot', now: t2 }).beads;
  const mergedClaimAndNotes = mergeBeadsMaps(noisyNotesBranch, claimedBranch);
  assert.equal(mergedClaimAndNotes.get(idA).status, 'in_progress');
  assert.equal(mergedClaimAndNotes.get(idA).lease?.owner, 'worker-a');
  assert.ok(!readyBeads(mergedClaimAndNotes, { now: t2 }).some((b) => b.id === idA));
  assert.ok(mergedClaimAndNotes.get(idA).journal.some((e) => e.note === 'Concurrent note 2'));

  const releasedBranch = applyOperations(claimedBranch, [
    { op: 'release', id: idA, owner: 'worker-a' },
  ], { actor: 'worker-a', now: t2 }).beads;
  const claimedWithLateNote = applyOperations(claimedBranch, [
    { op: 'note', id: idA, note: 'Late status ping' },
  ], { actor: 'worker-a', now: t3 }).beads;
  const mergedRelease = mergeBeadsMaps(claimedWithLateNote, releasedBranch);
  assert.equal(mergedRelease.get(idA).status, 'open');
  assert.equal(mergedRelease.get(idA).lease, null);

  // Stale release on an unleased snapshot must NOT clear another actor's active claim
  const staleUnleasedRelease = applyOperations(base, [
    { op: 'release', id: idA, owner: 'worker-b' },
  ], { actor: 'worker-b', lockActor: true, now: t2 }).beads;
  const mergedStaleRelease = mergeBeadsMaps(staleUnleasedRelease, claimedBranch);
  assert.equal(mergedStaleRelease.get(idA).status, 'in_progress');
  assert.equal(mergedStaleRelease.get(idA).lease?.owner, 'worker-a');

  // Single-batch ordered transitions (release->claim, close->reopen) survive merges with notes
  const releaseThenClaim = applyOperations(claimedBranch, [
    { op: 'release', id: idA, owner: 'worker-a' },
    { op: 'claim', id: idA, owner: 'worker-b', ttlHours: 24 },
  ], { actor: 'worker-b', now: t2 }).beads;
  const mergedReclaim = mergeBeadsMaps(claimedWithLateNote, releaseThenClaim);
  assert.equal(mergedReclaim.get(idA).status, 'in_progress');
  assert.equal(mergedReclaim.get(idA).lease?.owner, 'worker-b');

  const closeThenReopen = applyOperations(base, [
    { op: 'close', id: idA, reason: 'Temporary close' },
    { op: 'reopen', id: idA, note: 'Reopened in same batch' },
  ], { actor: 'host-2', now: t1 }).beads;
  const mergedBatchReopen = mergeBeadsMaps(closedWithLateNote, closeThenReopen);
  assert.equal(mergedBatchReopen.get(idA).status, 'open');

  // Audit notes must NOT discard concurrent dep_add or explicit status: blocked
  const depBlockedBranch = applyOperations(base, [
    { op: 'dep_add', id: idA, blockedBy: idB },
  ], { actor: 'triage', now: t1 }).beads;
  const mergedDepAndNotes = mergeBeadsMaps(noisyNotesBranch, depBlockedBranch);
  assert.deepEqual(mergedDepAndNotes.get(idA).deps.blockedBy, [idB]);
  assert.ok(!readyBeads(mergedDepAndNotes, { now: t2 }).some((b) => b.id === idA));

  const statusBlockedBranch = applyOperations(base, [
    { op: 'update', id: idA, status: 'blocked' },
  ], { actor: 'triage', now: t1 }).beads;
  const mergedBlockedAndNotes = mergeBeadsMaps(noisyNotesBranch, statusBlockedBranch);
  assert.equal(mergedBlockedAndNotes.get(idA).status, 'blocked');
  assert.ok(!readyBeads(mergedBlockedAndNotes, { now: t2 }).some((b) => b.id === idA));

  // No-op update (sending existing title back) must NOT bump stateRevision or defeat concurrent dep_add; priority: null is rejected
  assert.throws(() => applyOperations(base, [{ op: 'update', id: idA, priority: null }], { actor: 'triage', now: t2 }), BeadsValidationError);
  const noopTitleBranch = applyOperations(base, [
    { op: 'update', id: idA, title: 'A' },
  ], { actor: 'triage', now: t2 }).beads;
  const mergedNoopAndDep = mergeBeadsMaps(noopTitleBranch, depBlockedBranch);
  assert.deepEqual(mergedNoopAndDep.get(idA).deps.blockedBy, [idB]);

  // Three clones inheriting the SAME active lease and adding different notes must NEVER release that lease
  const sameLeaseNote1 = applyOperations(claimedBranch, [{ op: 'note', id: idA, note: 'Same-lease note 1' }], { actor: 'n1', now: t2 }).beads;
  const sameLeaseNote2 = applyOperations(claimedBranch, [{ op: 'note', id: idA, note: 'Same-lease note 2' }], { actor: 'n2', now: t2 }).beads;
  const sameLeaseNote3 = applyOperations(claimedBranch, [{ op: 'note', id: idA, note: 'Same-lease note 3' }], { actor: 'n3', now: t3 }).beads;
  const m12 = mergeBeadsMaps(sameLeaseNote1, sameLeaseNote2);
  assert.equal(m12.get(idA).status, 'in_progress');
  assert.equal(m12.get(idA).releasedLeases.length, 0);
  const m123 = mergeBeadsMaps(m12, sameLeaseNote3);
  assert.equal(m123.get(idA).status, 'in_progress');
  assert.equal(m123.get(idA).lease?.owner, 'worker-a');

  // Legacy "<claimedAt>|<owner>" and unprefixed "<claimedAt>|<expiresAt>|<hash>" tombstones both suppress the released claim on merge
  const legacyReleasedMap = new Map([[idA, validateBead({
    ...structuredClone(base.get(idA)),
    revision: 3,
    stateRevision: 3,
    releasedLeases: [`${claimedBranch.get(idA).lease.claimedAt}|worker-a`],
  })]]);
  const mergedLegacyTombstone = mergeBeadsMaps(legacyReleasedMap, claimedBranch);
  assert.equal(mergedLegacyTombstone.get(idA).status, 'open');
  assert.equal(mergedLegacyTombstone.get(idA).lease, null);

  const v2Key = releasedBranch.get(idA).releasedLeases[0];
  assert.ok(v2Key.startsWith('v2:'));
  const unprefixedReleasedMap = new Map([[idA, validateBead({
    ...structuredClone(base.get(idA)),
    revision: 3,
    stateRevision: 3,
    releasedLeases: [v2Key.slice(3)],
  })]]);
  const mergedUnprefixedTombstone = mergeBeadsMaps(unprefixedReleasedMap, claimedBranch);
  assert.equal(mergedUnprefixedTombstone.get(idA).status, 'open');
  assert.equal(mergedUnprefixedTombstone.get(idA).lease, null);

  // Mixed-version sync deduplicates equivalent v2:<x> and <x> tombstones so 26 releases never overflow the 50-entry cap
  let mixed26 = base;
  for (let i = 0; i < 26; i++) {
    const stepMs = t1.getTime() + 5000 + i * 20;
    mixed26 = applyOperations(mixed26, [
      { op: 'claim', id: idA, owner: `mv-${i}`, ttlHours: 1 },
      { op: 'release', id: idA, owner: `mv-${i}` },
    ], { actor: `mv-${i}`, now: new Date(stepMs) }).beads;
  }
  const unprefixed26 = new Map([[idA, validateBead({
    ...structuredClone(mixed26.get(idA)),
    releasedLeases: mixed26.get(idA).releasedLeases.map((k) => k.slice(3)),
  })]]);
  const activeWith26 = mergeBeadsMaps(mixed26, applyOperations(base, [
    { op: 'claim', id: idA, owner: 'still-active', ttlHours: 48 },
  ], { actor: 'still-active', now: t1 }).beads);
  const mergedMixedVersions = mergeBeadsMaps(activeWith26, unprefixed26);
  assert.equal(mergedMixedVersions.get(idA).releasedLeases.length, 26);
  assert.equal(mergedMixedVersions.get(idA).leaseFloorAt, null);
  assert.equal(mergedMixedVersions.get(idA).lease?.owner, 'still-active');

  // Deduplicating v2:<x> and <x> must NOT revive a released legacy claim whose owner equals "<expiresAt>|<hash>"
  const collidingOwner = v2Key.slice(3 + claimedBranch.get(idA).lease.claimedAt.length + 1);
  const legacyCollidingClaim = applyOperations(base, [
    { op: 'claim', id: idA, owner: collidingOwner, ttlHours: 24 },
  ], { actor: collidingOwner, now: t1 }).beads;
  const bothTombstones = new Map([[idA, validateBead({
    ...structuredClone(base.get(idA)),
    revision: 4,
    stateRevision: 4,
    releasedLeases: [v2Key, `${t1.toISOString()}|${collidingOwner}`],
  })]]);
  const mergedCollidingLegacy = mergeBeadsMaps(bothTombstones, legacyCollidingClaim);
  assert.equal(mergedCollidingLegacy.get(idA).status, 'open');
  assert.equal(mergedCollidingLegacy.get(idA).lease, null);

  // Conversely, a pure v2: release (without any legacy tombstone) must NOT clear a DIFFERENT active claim whose owner matches "<expiresAt>|<hash>"
  const mergedV2OnlyVsCollidingOwner = mergeBeadsMaps(releasedBranch, legacyCollidingClaim);
  assert.equal(mergedV2OnlyVsCollidingOwner.get(idA).status, 'in_progress');
  assert.equal(mergedV2OnlyVsCollidingOwner.get(idA).lease?.owner, collidingOwner);
  const mergedV2OnlyReverse = mergeBeadsMaps(legacyCollidingClaim, releasedBranch);
  assert.equal(mergedV2OnlyReverse.get(idA).status, 'in_progress');
  assert.equal(mergedV2OnlyReverse.get(idA).lease?.owner, collidingOwner);

  // Adding audit notes to a tied branch must NEVER flip which scheduling edit wins
  const tiedTitle = applyOperations(base, [{ op: 'update', id: idA, title: 'Tied title' }], { actor: 'host-1', now: t1 }).beads;
  const tiedDep = applyOperations(base, [{ op: 'dep_add', id: idA, blockedBy: idB }], { actor: 'host-2', now: t1 }).beads;
  const tiedWinnerBefore = mergeBeadsMaps(tiedDep, tiedTitle).get(idA);
  const tiedTitleWithNotes = applyOperations(tiedTitle, [
    { op: 'note', id: idA, note: 'Tie breaker probe 1' },
    { op: 'note', id: idA, note: 'Tie breaker probe 2' },
  ], { actor: 'host-1', now: t3 }).beads;
  const tiedWinnerAfter = mergeBeadsMaps(tiedDep, tiedTitleWithNotes).get(idA);
  assert.equal(tiedWinnerAfter.title, tiedWinnerBefore.title);
  assert.deepEqual(tiedWinnerAfter.deps.blockedBy, tiedWinnerBefore.deps.blockedBy);

  // Losing concurrent claim is tombstoned on merge so stale clones cannot resurrect it after winner releases
  const aliceClaim = applyOperations(base, [{ op: 'claim', id: idA, owner: 'alice', ttlHours: 24 }], { actor: 'alice', now: t1 }).beads;
  const bobClaim = applyOperations(base, [{ op: 'claim', id: idA, owner: 'bob', ttlHours: 24 }], { actor: 'bob', now: t2 }).beads;
  const mergedClaims = mergeBeadsMaps(aliceClaim, bobClaim);
  assert.equal(mergedClaims.get(idA).lease?.owner, 'bob');
  const bobReleased = applyOperations(mergedClaims, [{ op: 'release', id: idA, owner: 'bob' }], { actor: 'bob', now: t3 }).beads;
  const aliceStaleNote = applyOperations(aliceClaim, [{ op: 'note', id: idA, note: 'Stale ping' }], { actor: 'alice', now: t3 }).beads;
  const afterStaleAlice = mergeBeadsMaps(bobReleased, aliceStaleNote);
  assert.equal(afterStaleAlice.get(idA).status, 'open');
  assert.equal(afterStaleAlice.get(idA).lease, null);

  // >50 claim/release cycles advance leaseFloorAt so an evicted unexpired claim cannot resurrect
  let churn = applyOperations(base, [{ op: 'claim', id: idA, owner: 'early', ttlHours: 24 }], { actor: 'early', now: t1 }).beads;
  const staleEarlyClaim = churn;
  churn = applyOperations(churn, [{ op: 'release', id: idA, owner: 'early' }], { actor: 'early', now: new Date(t1.getTime() + 1000) }).beads;
  for (let i = 0; i < LIMITS.releasedLeases + 5; i++) {
    const stepMs = t1.getTime() + 2000 + i * 20;
    churn = applyOperations(churn, [
      { op: 'claim', id: idA, owner: `w-${i}`, ttlHours: 1 },
      { op: 'release', id: idA, owner: `w-${i}` },
    ], { actor: `w-${i}`, now: new Date(stepMs) }).beads;
  }
  assert.ok(churn.get(idA).leaseFloorAt !== null);
  const afterOverflowMerge = mergeBeadsMaps(churn, staleEarlyClaim);
  assert.equal(afterOverflowMerge.get(idA).status, 'open');
  assert.equal(afterOverflowMerge.get(idA).lease, null);

  // Compacting 51 tombstones across two branches must never leave an active lease <= leaseFloorAt (idempotent under note merges)
  const makeHalf = (startMs, count, prefix) => {
    let cur = base;
    for (let i = 0; i < count; i++) {
      cur = applyOperations(cur, [
        { op: 'claim', id: idA, owner: `${prefix}-${i}`, ttlHours: 1 },
        { op: 'release', id: idA, owner: `${prefix}-${i}` },
      ], { actor: `${prefix}-${i}`, now: new Date(startMs + i * 20) }).beads;
    }
    return cur;
  };
  const branchA26 = makeHalf(t1.getTime() + 5000, 26, 'a');
  const olderActive = applyOperations(base, [
    { op: 'claim', id: idA, owner: 'older-active', ttlHours: 48 },
  ], { actor: 'older-active', now: t1 }).beads;
  // Combine 25 newer tombstones with an active claim whose claimedAt (t1) genuinely precedes all 51 tombstones
  const branchB25WithOlderActive = mergeBeadsMaps(makeHalf(t1.getTime() + 20000, 25, 'b'), olderActive);
  assert.equal(branchB25WithOlderActive.get(idA).lease?.claimedAt, t1.toISOString());
  const compacted = mergeBeadsMaps(branchA26, branchB25WithOlderActive);
  const compactedBead = compacted.get(idA);
  assert.ok(compactedBead.leaseFloorAt > t1.toISOString());
  assert.equal(compactedBead.lease, null);
  assert.equal(compactedBead.status, 'open');
  const compactedNote = applyOperations(compacted, [{ op: 'note', id: idA, note: 'Idempotence check' }], { actor: 'obs', now: t3 }).beads;
  const remerged = mergeBeadsMaps(compacted, compactedNote);
  assert.equal(remerged.get(idA).status, compactedBead.status);
  assert.deepEqual(remerged.get(idA).lease, compactedBead.lease);

  // Same-millisecond, same-owner claims with different TTLs have distinct tombstones
  const shortClaim = applyOperations(base, [{ op: 'claim', id: idA, owner: 'alice', ttlHours: 1 }], { actor: 'alice', now: t1 }).beads;
  const longClaim = applyOperations(base, [{ op: 'claim', id: idA, owner: 'alice', ttlHours: 24 }], { actor: 'alice', now: t1 }).beads;
  const shortReleased = applyOperations(shortClaim, [{ op: 'release', id: idA, owner: 'alice' }], { actor: 'alice', now: t2 }).beads;
  const mergedDistinctTtl = mergeBeadsMaps(shortReleased, longClaim);
  assert.equal(mergedDistinctTtl.get(idA).status, 'in_progress');
  assert.equal(mergedDistinctTtl.get(idA).lease?.expiresAt, longClaim.get(idA).lease.expiresAt);

  // Divergent merge rejects overflowing MAX_SAFE_INTEGER revision
  const maxLeft = new Map([[idA, { ...structuredClone(titleA.get(idA)), revision: Number.MAX_SAFE_INTEGER }]]);
  const maxRight = new Map([[idA, { ...structuredClone(titleB.get(idA)), revision: Number.MAX_SAFE_INTEGER }]]);
  assert.throws(() => mergeBeadsMaps(maxLeft, maxRight), BeadsValidationError);

  // Merge must reject duplicate dedupeKey across two distinct bead IDs AND keyed-vs-unkeyed ID collision
  const dupKeyLeft = applyOperations(new Map(), [{ op: 'create', id: 'bd-11111111', title: 'Left', scope: { type: 'repo', targets: [] } }], { now: t0 }).beads;
  const dupKeyRight = applyOperations(new Map(), [{ op: 'create', id: 'bd-22222222', title: 'Right', scope: { type: 'repo', targets: [] } }], { now: t0 }).beads;
  dupKeyLeft.get('bd-11111111').dedupeKey = 'shared:key';
  dupKeyRight.get('bd-22222222').dedupeKey = 'shared:key';
  assert.throws(() => mergeBeadsMaps(dupKeyLeft, dupKeyRight), BeadsConflictError);

  const keyedSide = applyOperations(new Map(), [{ op: 'create', id: 'bd-44444444', title: 'Keyed', scope: { type: 'repo', targets: [] } }], { now: t0 }).beads;
  const unkeyedSide = applyOperations(new Map(), [{ op: 'create', id: 'bd-44444444', title: 'Unkeyed', scope: { type: 'repo', targets: [] } }], { now: t0 }).beads;
  keyedSide.get('bd-44444444').dedupeKey = 'knip:unique';
  assert.throws(() => mergeBeadsMaps(keyedSide, unkeyedSide), BeadsConflictError);

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
    execFileSync('git', ['init', '--bare', '-b', 'main'], { cwd: bareRemote, stdio: 'ignore' });
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

    // Exported reader enforces memory/ namespace and rejects symbolic refs
    assert.throws(() => readBeadsFromRef(cloneC, 'refs/heads/main'), BeadsValidationError);
    const mainShaBefore = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: cloneC, encoding: 'utf8' }).trim();
    execFileSync('git', ['symbolic-ref', 'refs/heads/memory/sym', 'refs/heads/main'], { cwd: cloneC, stdio: 'ignore' });
    assert.throws(() => readBeadsFromRef(cloneC, 'refs/heads/memory/sym'), BeadsValidationError);
    assert.throws(() => initBeadsRef(cloneC, { ref: 'refs/heads/memory/sym' }), BeadsValidationError);
    assert.throws(() => commitBeadsToRef(cloneC, beads, { ref: 'refs/heads/memory/sym', expectedParentSha: mainShaBefore }), BeadsValidationError);
    assert.throws(() => mutateBeadsRef(cloneC, [{ op: 'note', id: beadId, note: 'x' }], { ref: 'refs/heads/memory/sym' }), BeadsValidationError);
    assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: cloneC, encoding: 'utf8' }).trim(), mainShaBefore);

    // Malformed store trees (blob named "beads", unexpected root entry, tab in filename) are rejected
    const schemaBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: cloneC,
      input: JSON.stringify({ schemaVersion: SCHEMA_VERSION, format: 'neurodesk-beads' }),
      encoding: 'utf8',
    }).trim();
    const dummyBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: cloneC,
      input: 'not-a-tree',
      encoding: 'utf8',
    }).trim();
    const badBeadsBlobTree = execFileSync('git', ['mktree'], {
      cwd: cloneC,
      input: `100644 blob ${schemaBlob}\tschema.json\n100644 blob ${dummyBlob}\tbeads\n`,
      encoding: 'utf8',
    }).trim();
    const badBeadsCommit = execFileSync('git', ['commit-tree', badBeadsBlobTree, '-m', 'malformed'], { cwd: cloneC, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/memory/malformed-blob', badBeadsCommit], { cwd: cloneC, stdio: 'ignore' });
    assert.throws(() => readBeadsFromRef(cloneC, 'refs/heads/memory/malformed-blob'), BeadsValidationError);

    const sampleBeadJson = `${JSON.stringify(beads.get(beadId), null, 2)}\n`;
    const sampleBeadBlob = execFileSync('git', ['hash-object', '-w', '--stdin'], {
      cwd: cloneC,
      input: sampleBeadJson,
      encoding: 'utf8',
    }).trim();
    const tabBeadsTree = execFileSync('git', ['mktree', '-z'], {
      cwd: cloneC,
      input: `100644 blob ${sampleBeadBlob}\t${beadId}.json\tsuffix.json\0`,
      encoding: 'utf8',
    }).trim();
    const tabRootTree = execFileSync('git', ['mktree'], {
      cwd: cloneC,
      input: `100644 blob ${schemaBlob}\tschema.json\n040000 tree ${tabBeadsTree}\tbeads\n`,
      encoding: 'utf8',
    }).trim();
    const tabCommit = execFileSync('git', ['commit-tree', tabRootTree, '-m', 'tab path'], { cwd: cloneC, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/memory/malformed-tab', tabCommit], { cwd: cloneC, stdio: 'ignore' });
    assert.throws(() => readBeadsFromRef(cloneC, 'refs/heads/memory/malformed-tab'), BeadsValidationError);

    // Empty subdirectory under beads/ and symlink (120000) schema/bead entries must be rejected
    const emptyTree = execFileSync('git', ['mktree'], { cwd: cloneC, input: '', encoding: 'utf8' }).trim();
    const nestedBeadsTree = execFileSync('git', ['mktree'], {
      cwd: cloneC,
      input: `040000 tree ${emptyTree}\tempty-subdir\n`,
      encoding: 'utf8',
    }).trim();
    const nestedRootTree = execFileSync('git', ['mktree'], {
      cwd: cloneC,
      input: `100644 blob ${schemaBlob}\tschema.json\n040000 tree ${nestedBeadsTree}\tbeads\n`,
      encoding: 'utf8',
    }).trim();
    const nestedCommit = execFileSync('git', ['commit-tree', nestedRootTree, '-m', 'empty subdir'], { cwd: cloneC, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/memory/malformed-subdir', nestedCommit], { cwd: cloneC, stdio: 'ignore' });
    assert.throws(() => readBeadsFromRef(cloneC, 'refs/heads/memory/malformed-subdir'), BeadsValidationError);

    const symlinkSchemaTree = execFileSync('git', ['mktree'], {
      cwd: cloneC,
      input: `120000 blob ${schemaBlob}\tschema.json\n`,
      encoding: 'utf8',
    }).trim();
    const symlinkSchemaCommit = execFileSync('git', ['commit-tree', symlinkSchemaTree, '-m', 'symlink schema'], { cwd: cloneC, encoding: 'utf8' }).trim();
    execFileSync('git', ['update-ref', 'refs/heads/memory/malformed-symlink', symlinkSchemaCommit], { cwd: cloneC, stdio: 'ignore' });
    assert.throws(() => readBeadsFromRef(cloneC, 'refs/heads/memory/malformed-symlink'), BeadsValidationError);

    // sync --push must ignore push.followTags=true AND remote.<name>.fetch mappings (never touch main or tags)
    execFileSync('git', ['tag', '-a', 'hmc-v0.0.1', '-m', 'unrelated tag', 'refs/heads/main'], { cwd: mainRepo, stdio: 'ignore' });
    execFileSync('git', ['config', 'push.followTags', 'true'], { cwd: mainRepo, stdio: 'ignore' });
    execFileSync('git', ['config', '--add', 'remote.origin.fetch', '+refs/heads/memory/beads:refs/heads/main'], { cwd: mainRepo, stdio: 'ignore' });
    const mainRepoHeadBefore = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: mainRepo, encoding: 'utf8' }).trim();
    mutateBeadsRef(mainRepo, [{ op: 'note', id: beadId, note: 'Push isolation check' }], { actor: 'host-a' });
    syncBeadsRef(mainRepo, { remote: 'origin', push: true });
    assert.equal(execFileSync('git', ['ls-remote', '--tags', 'origin'], { cwd: mainRepo, encoding: 'utf8' }).trim(), '');
    assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: mainRepo, encoding: 'utf8' }).trim(), mainRepoHeadBefore);

    // Relative push URL colliding with another configured remote name must push to the local path, not the other remote
    const relRepo = join(root, 'rel-repo');
    const relTargetBare = join(relRepo, 'backup');
    const unrelatedBare = join(root, 'unrelated-backup.git');
    mkdirSync(relRepo, { recursive: true });
    mkdirSync(relTargetBare, { recursive: true });
    mkdirSync(unrelatedBare, { recursive: true });
    initGitRepo(relRepo);
    execFileSync('git', ['init', '--bare', '-b', 'main', relTargetBare], { stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', '-b', 'main', unrelatedBare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'origin', 'backup'], { cwd: relRepo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'backup', unrelatedBare], { cwd: relRepo, stdio: 'ignore' });
    mutateBeadsRef(relRepo, [{ op: 'create', title: 'Relative remote test', scope: { type: 'repo', targets: [] } }], { actor: 'rel' });
    syncBeadsRef(relRepo, { remote: 'origin', push: true });
    assert.ok(execFileSync('git', ['rev-parse', '--verify', 'refs/heads/memory/beads'], { cwd: relTargetBare, encoding: 'utf8' }).trim());
    assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/memory/beads'], { cwd: unrelatedBare, encoding: 'utf8' }).trim(), '');

    // Symlinked relative remote path and single-pass insteadOf rewrite must target the exact configured remote
    const symRepo = join(root, 'sym-repo');
    const nestedDir = join(symRepo, 'sub', 'nested');
    const symlinkRealBare = join(symRepo, 'sub', 'target.git');
    const lexicalWrongBare = join(symRepo, 'target.git');
    mkdirSync(nestedDir, { recursive: true });
    mkdirSync(symlinkRealBare, { recursive: true });
    mkdirSync(lexicalWrongBare, { recursive: true });
    initGitRepo(symRepo);
    execFileSync('git', ['init', '--bare', '-b', 'main', symlinkRealBare], { stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', '-b', 'main', lexicalWrongBare], { stdio: 'ignore' });
    symlinkSync(nestedDir, join(symRepo, 'link'));
    execFileSync('git', ['remote', 'add', 'origin', 'link/../target.git'], { cwd: symRepo, stdio: 'ignore' });
    mutateBeadsRef(symRepo, [{ op: 'create', title: 'Symlink remote test', scope: { type: 'repo', targets: [] } }], { actor: 'sym' });
    syncBeadsRef(symRepo, { remote: 'origin', push: true });
    assert.ok(execFileSync('git', ['rev-parse', '--verify', 'refs/heads/memory/beads'], { cwd: symlinkRealBare, encoding: 'utf8' }).trim());
    assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/memory/beads'], { cwd: lexicalWrongBare, encoding: 'utf8' }).trim(), '');

    const insteadRealBare = join(root, 'instead-real.git');
    const insteadWrongBare = join(root, 'instead-wrong.git');
    mkdirSync(insteadRealBare, { recursive: true });
    mkdirSync(insteadWrongBare, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', insteadRealBare], { stdio: 'ignore' });
    execFileSync('git', ['init', '--bare', '-b', 'main', insteadWrongBare], { stdio: 'ignore' });
    execFileSync('git', ['remote', 'add', 'aliased', 'alias://repo'], { cwd: symRepo, stdio: 'ignore' });
    execFileSync('git', ['config', `url.${insteadRealBare}.insteadOf`, 'alias://repo'], { cwd: symRepo, stdio: 'ignore' });
    execFileSync('git', ['config', `url.${insteadWrongBare}.insteadOf`, insteadRealBare], { cwd: symRepo, stdio: 'ignore' });
    syncBeadsRef(symRepo, { remote: 'aliased', push: true });
    assert.ok(execFileSync('git', ['rev-parse', '--verify', 'refs/heads/memory/beads'], { cwd: insteadRealBare, encoding: 'utf8' }).trim());
    assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/memory/beads'], { cwd: insteadWrongBare, encoding: 'utf8' }).trim(), '');

    // remote.<name>.mirror=true still allows single-ref beads push, while multiple push URLs (including whitespace paths) fail before any local ref writes
    execFileSync('git', ['config', 'remote.aliased.mirror', 'true'], { cwd: symRepo, stdio: 'ignore' });
    mutateBeadsRef(symRepo, [{ op: 'create', title: 'Mirror config push', scope: { type: 'repo', targets: [] } }], { actor: 'sym' });
    syncBeadsRef(symRepo, { remote: 'aliased', push: true });
    const multiPushRepo = join(root, 'multi-push-repo');
    mkdirSync(multiPushRepo, { recursive: true });
    initGitRepo(multiPushRepo);
    execFileSync('git', ['remote', 'add', 'origin', insteadRealBare], { cwd: multiPushRepo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'set-url', '--add', '--push', 'origin', insteadRealBare], { cwd: multiPushRepo, stdio: 'ignore' });
    execFileSync('git', ['remote', 'set-url', '--add', '--push', 'origin', ' '], { cwd: multiPushRepo, stdio: 'ignore' });
    assert.throws(() => syncBeadsRef(multiPushRepo, { remote: 'origin', push: true }), BeadsValidationError);
    assert.equal(execFileSync('git', ['for-each-ref', 'refs/heads/memory/'], { cwd: multiPushRepo, encoding: 'utf8' }).trim(), '');

    // Writing to a memory ref currently checked out in a linked worktree is rejected so no worktree is dirtied
    const checkedOutWt = join(root, 'checked-out-memory');
    execFileSync('git', ['worktree', 'add', checkedOutWt, 'memory/beads'], { cwd: symRepo, stdio: 'ignore' });
    assert.throws(
      () => mutateBeadsRef(symRepo, [{ op: 'create', title: 'Should not dirty worktree', scope: { type: 'repo', targets: [] } }], { actor: 'sym' }),
      BeadsConflictError,
    );
    assert.equal(execFileSync('git', ['status', '--porcelain'], { cwd: checkedOutWt, encoding: 'utf8' }), '');
    execFileSync('git', ['worktree', 'remove', checkedOutWt], { cwd: symRepo, stdio: 'ignore' });

    // Pull-only sync must ignore configured remote refmaps and fetch.recurseSubmodules=true
    const subUpstream = join(root, 'sub-upstream.git');
    const subSeed = join(root, 'sub-seed');
    mkdirSync(subUpstream, { recursive: true });
    mkdirSync(subSeed, { recursive: true });
    execFileSync('git', ['init', '--bare', '-b', 'main', subUpstream], { stdio: 'ignore' });
    initGitRepo(subSeed);
    execFileSync('git', ['remote', 'add', 'origin', subUpstream], { cwd: subSeed, stdio: 'ignore' });
    execFileSync('git', ['push', '-u', 'origin', 'main'], { cwd: subSeed, stdio: 'ignore' });

    const detachedClone = join(root, 'detached-clone');
    execFileSync('git', ['clone', bareRemote, detachedClone], { stdio: 'ignore' });
    execFileSync('git', ['-c', 'protocol.file.allow=always', 'submodule', 'add', subUpstream, 'ext-sub'], { cwd: detachedClone, stdio: 'ignore' });
    const subOriginBefore = execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: join(detachedClone, 'ext-sub'), encoding: 'utf8' }).trim();
    // Advance submodule upstream after adding it
    writeFileSync(join(subSeed, 'README.md'), '# updated\n', 'utf8');
    execFileSync('git', ['add', 'README.md'], { cwd: subSeed, stdio: 'ignore' });
    execFileSync('git', ['commit', '-m', 'advance sub'], { cwd: subSeed, stdio: 'ignore' });
    execFileSync('git', ['push', 'origin', 'main'], { cwd: subSeed, stdio: 'ignore' });

    execFileSync('git', ['checkout', '--detach'], { cwd: detachedClone, stdio: 'ignore' });
    const detachedMainBefore = execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: detachedClone, encoding: 'utf8' }).trim();
    execFileSync('git', ['config', '--add', 'remote.origin.fetch', '+refs/heads/memory/beads:refs/heads/main'], { cwd: detachedClone, stdio: 'ignore' });
    execFileSync('git', ['config', 'fetch.recurseSubmodules', 'true'], { cwd: detachedClone, stdio: 'ignore' });
    const isolatedSync = syncBeadsRef(detachedClone, { remote: 'origin', push: false });
    assert.equal(isolatedSync.count, 4);
    assert.equal(execFileSync('git', ['rev-parse', 'refs/heads/main'], { cwd: detachedClone, encoding: 'utf8' }).trim(), detachedMainBefore);
    assert.equal(execFileSync('git', ['rev-parse', 'refs/remotes/origin/main'], { cwd: join(detachedClone, 'ext-sub'), encoding: 'utf8' }).trim(), subOriginBefore);

    // CLI-level validation & safe apply tests
    assert.notEqual(runCli(cloneC, ['list', '--ref', 'refs/heads/main']).status, 0);
    assert.notEqual(runCli(cloneC, ['export', '--format', 'xml']).status, 0);
    assert.notEqual(runCli(cloneC, ['export', '--format', 'snapshot', '--max-items', '-1']).status, 0);
    assert.notEqual(runCli(cloneC, ['create', '--title', 'Bad int', '--scope', 'repo', '--priority', '1abc']).status, 0);
    assert.notEqual(runCli(cloneC, ['create', '--title', 'Bad scope', '--scope', 'app:a:b']).status, 0);
    assert.notEqual(runCli(cloneC, ['claim', beadId, '--ttl-hours', '24h']).status, 0);

    const badEnvelope = join(root, 'bad.json');
    writeFileSync(badEnvelope, 'null\n', 'utf8');
    assert.notEqual(runCli(cloneC, ['apply', badEnvelope, '--safe']).status, 0);
    const extraKeyEnvelope = join(root, 'extra-key.json');
    writeFileSync(extraKeyEnvelope, JSON.stringify({ operations: [], unexpected: true }), 'utf8');
    assert.notEqual(runCli(cloneC, ['apply', extraKeyEnvelope, '--safe']).status, 0);

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
