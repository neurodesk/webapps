import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SCHEMA_VERSION = 1;
export const DEFAULT_BEADS_REF = 'refs/heads/memory/beads';
export const BEAD_ID_PATTERN = /^bd-[0-9a-f]{8}$/;

export const BEAD_KINDS = Object.freeze(['maintenance', 'rollout', 'followup', 'blocker', 'hardware']);
export const BEAD_STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'closed']);
export const SCOPE_TYPES = Object.freeze(['app', 'package', 'exe', 'shared', 'repo']);

export const LIMITS = Object.freeze({
  title: 140,
  summary: 1000,
  closeReason: 500,
  note: 500,
  dedupeKey: 200,
  actor: 120,
  branch: 200,
  target: 120,
  targets: 20,
  evidence: 20,
  evidenceItem: 240,
  journal: 50,
  blockedBy: 20,
});

export class BeadsValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BeadsValidationError';
  }
}

export class BeadsConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BeadsConflictError';
  }
}

function assertNonEmptyString(value, field, maxLen) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BeadsValidationError(`${field} must be a non-empty string`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLen) {
    throw new BeadsValidationError(`${field} exceeds maximum length of ${maxLen} characters`);
  }
  return trimmed;
}

function assertOptionalString(value, field, maxLen) {
  if (value === undefined || value === null || value === '') return null;
  return assertNonEmptyString(value, field, maxLen);
}

function assertIsoTimestamp(value, field) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) {
    throw new BeadsValidationError(`${field} must be a valid ISO-8601 timestamp`);
  }
  return new Date(value).toISOString();
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function deriveBeadId(dedupeKey) {
  const hash = createHash('sha256').update(dedupeKey, 'utf8').digest('hex').slice(0, 8);
  return `bd-${hash}`;
}

export function generateBeadId(existingIds = new Set()) {
  for (let attempt = 0; attempt < 32; attempt++) {
    const id = `bd-${randomBytes(4).toString('hex')}`;
    if (!existingIds.has(id)) return id;
  }
  throw new BeadsConflictError('Unable to generate a unique bead id');
}

function normalizeScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    throw new BeadsValidationError('scope must be an object with { type, targets }');
  }
  if (!SCOPE_TYPES.includes(scope.type)) {
    throw new BeadsValidationError(`scope.type must be one of: ${SCOPE_TYPES.join(', ')}`);
  }
  const rawTargets = scope.targets ?? [];
  if (!Array.isArray(rawTargets) || rawTargets.length > LIMITS.targets) {
    throw new BeadsValidationError(`scope.targets must be an array of at most ${LIMITS.targets} entries`);
  }
  const targets = uniqueSorted(rawTargets.map((item, idx) => assertNonEmptyString(item, `scope.targets[${idx}]`, LIMITS.target)));
  if ((scope.type === 'app' || scope.type === 'package' || scope.type === 'exe') && targets.length === 0) {
    throw new BeadsValidationError(`scope.targets is required when scope.type is "${scope.type}"`);
  }
  return { type: scope.type, targets };
}

function normalizeDeps(deps = {}) {
  if (!deps || typeof deps !== 'object' || Array.isArray(deps)) {
    throw new BeadsValidationError('deps must be an object');
  }
  const rawBlocked = deps.blockedBy ?? [];
  if (!Array.isArray(rawBlocked) || rawBlocked.length > LIMITS.blockedBy) {
    throw new BeadsValidationError(`deps.blockedBy must be an array of at most ${LIMITS.blockedBy} ids`);
  }
  const blockedBy = uniqueSorted(rawBlocked.map((id) => {
    if (typeof id !== 'string' || !BEAD_ID_PATTERN.test(id)) {
      throw new BeadsValidationError(`Invalid dependency bead id: ${id}`);
    }
    return id;
  }));
  const parent = deps.parent ?? null;
  if (parent !== null && (typeof parent !== 'string' || !BEAD_ID_PATTERN.test(parent))) {
    throw new BeadsValidationError(`Invalid deps.parent bead id: ${parent}`);
  }
  const discoveredFrom = deps.discoveredFrom ?? null;
  if (discoveredFrom !== null && (typeof discoveredFrom !== 'string' || !BEAD_ID_PATTERN.test(discoveredFrom))) {
    throw new BeadsValidationError(`Invalid deps.discoveredFrom bead id: ${discoveredFrom}`);
  }
  return { blockedBy, parent, discoveredFrom };
}

function normalizeLinks(links = {}) {
  if (!links || typeof links !== 'object' || Array.isArray(links)) {
    throw new BeadsValidationError('links must be an object');
  }
  const out = {};
  if (links.githubIssue !== undefined && links.githubIssue !== null) {
    if (!Number.isInteger(links.githubIssue) || links.githubIssue <= 0) {
      throw new BeadsValidationError('links.githubIssue must be a positive integer');
    }
    out.githubIssue = links.githubIssue;
  }
  if (links.pr !== undefined && links.pr !== null) {
    if (!Number.isInteger(links.pr) || links.pr <= 0) {
      throw new BeadsValidationError('links.pr must be a positive integer');
    }
    out.pr = links.pr;
  }
  const branch = assertOptionalString(links.branch, 'links.branch', LIMITS.branch);
  if (branch) out.branch = branch;
  const rawEvidence = links.evidence ?? [];
  if (!Array.isArray(rawEvidence) || rawEvidence.length > LIMITS.evidence) {
    throw new BeadsValidationError(`links.evidence must be an array of at most ${LIMITS.evidence} entries`);
  }
  const evidence = uniqueSorted(rawEvidence.map((item, idx) => assertNonEmptyString(item, `links.evidence[${idx}]`, LIMITS.evidenceItem)));
  if (evidence.length) out.evidence = evidence;
  return out;
}

function normalizeLease(lease) {
  if (lease === undefined || lease === null) return null;
  if (typeof lease !== 'object' || Array.isArray(lease)) {
    throw new BeadsValidationError('lease must be null or an object');
  }
  const owner = assertNonEmptyString(lease.owner, 'lease.owner', LIMITS.actor);
  const claimedAt = assertIsoTimestamp(lease.claimedAt, 'lease.claimedAt');
  const expiresAt = assertIsoTimestamp(lease.expiresAt, 'lease.expiresAt');
  if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
    throw new BeadsValidationError('lease.expiresAt must be after lease.claimedAt');
  }
  const branch = assertOptionalString(lease.branch, 'lease.branch', LIMITS.branch);
  return branch ? { owner, branch, claimedAt, expiresAt } : { owner, claimedAt, expiresAt };
}

function normalizeJournal(journal = []) {
  if (!Array.isArray(journal)) {
    throw new BeadsValidationError('journal must be an array');
  }
  const normalized = journal.map((entry, idx) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new BeadsValidationError(`journal[${idx}] must be an object`);
    }
    return {
      at: assertIsoTimestamp(entry.at, `journal[${idx}].at`),
      actor: assertNonEmptyString(entry.actor, `journal[${idx}].actor`, LIMITS.actor),
      note: assertNonEmptyString(entry.note, `journal[${idx}].note`, LIMITS.note),
    };
  });
  return normalized.slice(-LIMITS.journal);
}

export function validateBead(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BeadsValidationError('Bead must be an object');
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new BeadsValidationError(`Unsupported bead schemaVersion: ${raw.schemaVersion}`);
  }
  if (typeof raw.id !== 'string' || !BEAD_ID_PATTERN.test(raw.id)) {
    throw new BeadsValidationError(`Invalid bead id: ${raw.id}`);
  }
  if (!Number.isInteger(raw.revision) || raw.revision < 1) {
    throw new BeadsValidationError('revision must be a positive integer');
  }
  const title = assertNonEmptyString(raw.title, 'title', LIMITS.title);
  const summary = assertOptionalString(raw.summary, 'summary', LIMITS.summary) ?? '';
  if (!BEAD_KINDS.includes(raw.kind)) {
    throw new BeadsValidationError(`kind must be one of: ${BEAD_KINDS.join(', ')}`);
  }
  if (!BEAD_STATUSES.includes(raw.status)) {
    throw new BeadsValidationError(`status must be one of: ${BEAD_STATUSES.join(', ')}`);
  }
  const priority = raw.priority ?? 2;
  if (!Number.isInteger(priority) || priority < 0 || priority > 3) {
    throw new BeadsValidationError('priority must be an integer 0..3');
  }
  const scope = normalizeScope(raw.scope);
  const dedupeKey = assertOptionalString(raw.dedupeKey, 'dedupeKey', LIMITS.dedupeKey);
  const deps = normalizeDeps(raw.deps);
  if (deps.blockedBy.includes(raw.id)) {
    throw new BeadsValidationError(`Bead ${raw.id} cannot block itself`);
  }
  const links = normalizeLinks(raw.links);
  const lease = normalizeLease(raw.lease);
  const journal = normalizeJournal(raw.journal);
  const createdAt = assertIsoTimestamp(raw.createdAt, 'createdAt');
  const updatedAt = assertIsoTimestamp(raw.updatedAt, 'updatedAt');
  const lastSeenAt = assertIsoTimestamp(raw.lastSeenAt ?? updatedAt, 'lastSeenAt');
  const closedAt = raw.closedAt === undefined || raw.closedAt === null ? null : assertIsoTimestamp(raw.closedAt, 'closedAt');
  const closeReason = assertOptionalString(raw.closeReason, 'closeReason', LIMITS.closeReason);

  return {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    revision: raw.revision,
    title,
    summary,
    kind: raw.kind,
    status: raw.status,
    priority,
    scope,
    dedupeKey,
    deps,
    links,
    lease,
    journal,
    createdAt,
    updatedAt,
    lastSeenAt,
    closedAt,
    closeReason,
  };
}

export function hasActiveLease(bead, nowMs = Date.now()) {
  if (!bead.lease) return false;
  return Date.parse(bead.lease.expiresAt) > nowMs;
}

export function isSingleAppScope(bead) {
  return bead.scope.type === 'app' && bead.scope.targets.length === 1;
}

export function isBlockedByDeps(bead, beadsMap) {
  for (const depId of bead.deps.blockedBy) {
    const dep = beadsMap.get(depId);
    if (!dep || dep.status !== 'closed') return true;
  }
  return false;
}

export function detectDependencyCycle(beadsMap, startId, newBlockerId) {
  if (startId === newBlockerId) return true;
  const visited = new Set();
  const stack = [newBlockerId];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === startId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const node = beadsMap.get(current);
    if (!node) continue;
    for (const next of node.deps.blockedBy) {
      if (!visited.has(next)) stack.push(next);
    }
  }
  return false;
}

function compareBeadOrder(a, b) {
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt.localeCompare(b.createdAt);
  return a.id.localeCompare(b.id);
}

export function readyBeads(beadsMap, { now = new Date(), target = null, kind = null, singleAppOnly = false } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const out = [];
  for (const bead of beadsMap.values()) {
    if (bead.status === 'closed' || bead.status === 'blocked') continue;
    if (bead.status === 'in_progress' && hasActiveLease(bead, nowMs)) continue;
    if (hasActiveLease(bead, nowMs)) continue;
    if (isBlockedByDeps(bead, beadsMap)) continue;
    if (kind && bead.kind !== kind) continue;
    if (target && !bead.scope.targets.includes(target)) continue;
    if (singleAppOnly && !isSingleAppScope(bead)) continue;
    out.push(bead);
  }
  return out.sort(compareBeadOrder);
}

export function listBeads(beadsMap, { status = null, kind = null, target = null, singleAppOnly = false } = {}) {
  const out = [];
  for (const bead of beadsMap.values()) {
    if (status && bead.status !== status) continue;
    if (kind && bead.kind !== kind) continue;
    if (target && !bead.scope.targets.includes(target)) continue;
    if (singleAppOnly && !isSingleAppScope(bead)) continue;
    out.push(bead);
  }
  return out.sort(compareBeadOrder);
}

export function summarizeBeads(beadsMap, { now = new Date(), maxItems = 100 } = {}) {
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const items = listBeads(beadsMap)
    .filter((bead) => bead.status !== 'closed')
    .slice(0, maxItems)
    .map((bead) => ({
      id: bead.id,
      revision: bead.revision,
      title: bead.title,
      kind: bead.kind,
      status: bead.status,
      priority: bead.priority,
      scope: bead.scope,
      dedupeKey: bead.dedupeKey,
      blockedBy: bead.deps.blockedBy,
      blocked: bead.status === 'blocked' || isBlockedByDeps(bead, beadsMap),
      leased: hasActiveLease(bead, nowMs) ? { owner: bead.lease.owner, expiresAt: bead.lease.expiresAt } : null,
      links: bead.links,
      lastSeenAt: bead.lastSeenAt,
    }));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    total: beadsMap.size,
    openCount: items.length,
    items,
  };
}

export function formatJsonl(beadsMap) {
  return [...beadsMap.values()]
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((bead) => JSON.stringify(bead))
    .join('\n') + (beadsMap.size ? '\n' : '');
}

export function parseJsonl(text) {
  const map = new Map();
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const bead = validateBead(JSON.parse(trimmed));
    map.set(bead.id, bead);
  }
  return map;
}

function cloneMap(beadsMap) {
  const copy = new Map();
  for (const [id, bead] of beadsMap.entries()) {
    copy.set(id, structuredClone(bead));
  }
  return copy;
}

function findByDedupeKey(beadsMap, dedupeKey) {
  if (!dedupeKey) return null;
  for (const bead of beadsMap.values()) {
    if (bead.dedupeKey === dedupeKey) return bead;
  }
  return null;
}

function checkExpectedRevision(bead, expectedRevision, requireExpectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) {
    if (requireExpectedRevision) {
      throw new BeadsValidationError(`Operation on ${bead.id} requires expectedRevision`);
    }
    return;
  }
  if (bead.revision !== expectedRevision) {
    throw new BeadsConflictError(`Stale revision for ${bead.id}: expected ${expectedRevision}, actual ${bead.revision}`);
  }
}

function appendJournal(bead, actor, note, nowIso) {
  const cleanActor = assertNonEmptyString(actor, 'actor', LIMITS.actor);
  const cleanNote = assertNonEmptyString(note, 'note', LIMITS.note);
  const exists = bead.journal.some((entry) => entry.at === nowIso && entry.actor === cleanActor && entry.note === cleanNote);
  if (exists) return;
  bead.journal = [...bead.journal, { at: nowIso, actor: cleanActor, note: cleanNote }].slice(-LIMITS.journal);
}

function mergeLinks(base, patch) {
  if (!patch) return base;
  const merged = { ...base };
  if (patch.githubIssue !== undefined) merged.githubIssue = patch.githubIssue;
  if (patch.pr !== undefined) merged.pr = patch.pr;
  if (patch.branch !== undefined) merged.branch = patch.branch;
  if (patch.evidence !== undefined) {
    merged.evidence = uniqueSorted([...(base.evidence ?? []), ...patch.evidence]);
  }
  return normalizeLinks(merged);
}

export function applyOperations(beadsMap, operations, options = {}) {
  if (!Array.isArray(operations)) {
    throw new BeadsValidationError('operations must be an array');
  }
  const {
    actor = 'unknown',
    now = new Date(),
    maxCreates = Infinity,
    maxUpdates = Infinity,
    requireExpectedRevision = false,
    singleAppOnly = false,
  } = options;
  const nowDate = now instanceof Date ? now : new Date(now);
  const nowIso = nowDate.toISOString();
  const nowMs = nowDate.getTime();
  const next = cloneMap(beadsMap);
  const changedIds = new Set();
  const createdIds = [];
  const updatedIds = [];
  const untouchedIds = [];
  let creates = 0;
  let updates = 0;

  for (let index = 0; index < operations.length; index++) {
    const op = operations[index];
    if (!op || typeof op !== 'object' || typeof op.op !== 'string') {
      throw new BeadsValidationError(`operations[${index}] must be an object with an "op" field`);
    }

    if (op.op === 'create' || op.op === 'upsert') {
      const dedupeKey = assertOptionalString(op.dedupeKey, 'dedupeKey', LIMITS.dedupeKey);
      const existing = dedupeKey ? findByDedupeKey(next, dedupeKey) : (op.id ? next.get(op.id) : null);
      if (existing && op.op === 'create') {
        throw new BeadsConflictError(`Bead already exists: ${existing.id}`);
      }
      if (existing) {
        if (singleAppOnly && !isSingleAppScope(existing)) {
          throw new BeadsValidationError(`Bead ${existing.id} is outside single-app scope`);
        }
        const mergedLinks = mergeLinks(existing.links, op.links);
        const evidenceChanged = JSON.stringify(mergedLinks) !== JSON.stringify(existing.links);
        const noteText = assertOptionalString(op.note, 'note', LIMITS.note);
        const summaryChanged = op.summary !== undefined && op.summary.trim() !== existing.summary;
        const alreadySeenSameRun = existing.lastSeenAt === nowIso && !evidenceChanged && !noteText && !summaryChanged;
        if (alreadySeenSameRun) {
          untouchedIds.push(existing.id);
          continue;
        }
        updates++;
        if (updates > maxUpdates) {
          throw new BeadsValidationError(`Operation batch exceeds maxUpdates (${maxUpdates})`);
        }
        existing.links = mergedLinks;
        if (op.summary !== undefined) existing.summary = assertOptionalString(op.summary, 'summary', LIMITS.summary) ?? '';
        if (noteText) appendJournal(existing, op.actor ?? actor, noteText, nowIso);
        existing.lastSeenAt = nowIso;
        existing.updatedAt = nowIso;
        existing.revision += 1;
        next.set(existing.id, validateBead(existing));
        changedIds.add(existing.id);
        updatedIds.push(existing.id);
        continue;
      }

      creates++;
      if (creates > maxCreates) {
        throw new BeadsValidationError(`Operation batch exceeds maxCreates (${maxCreates})`);
      }
      const id = op.id ?? (dedupeKey ? deriveBeadId(dedupeKey) : generateBeadId(new Set(next.keys())));
      if (next.has(id)) {
        throw new BeadsConflictError(`Bead id collision for ${id}`);
      }
      const initial = validateBead({
        schemaVersion: SCHEMA_VERSION,
        id,
        revision: 1,
        title: op.title,
        summary: op.summary ?? '',
        kind: op.kind ?? 'maintenance',
        status: op.status ?? 'open',
        priority: op.priority ?? 2,
        scope: op.scope,
        dedupeKey,
        deps: op.deps ?? {},
        links: op.links ?? {},
        lease: null,
        journal: op.note ? [{ at: nowIso, actor: op.actor ?? actor, note: op.note }] : [],
        createdAt: nowIso,
        updatedAt: nowIso,
        lastSeenAt: nowIso,
        closedAt: op.status === 'closed' ? nowIso : null,
        closeReason: op.closeReason ?? null,
      });
      if (singleAppOnly && !isSingleAppScope(initial)) {
        throw new BeadsValidationError(`New bead ${initial.id} must target a single app`);
      }
      for (const depId of initial.deps.blockedBy) {
        if (!next.has(depId)) {
          throw new BeadsValidationError(`Unknown dependency bead: ${depId}`);
        }
      }
      next.set(initial.id, initial);
      changedIds.add(initial.id);
      createdIds.push(initial.id);
      continue;
    }

    const bead = next.get(op.id);
    if (!bead) {
      throw new BeadsValidationError(`Unknown bead id: ${op.id}`);
    }
    if (singleAppOnly && !isSingleAppScope(bead)) {
      throw new BeadsValidationError(`Bead ${bead.id} is outside single-app scope`);
    }
    checkExpectedRevision(bead, op.expectedRevision, requireExpectedRevision);
    updates++;
    if (updates > maxUpdates) {
      throw new BeadsValidationError(`Operation batch exceeds maxUpdates (${maxUpdates})`);
    }

    if (op.op === 'update') {
      if (op.title !== undefined) bead.title = assertNonEmptyString(op.title, 'title', LIMITS.title);
      if (op.summary !== undefined) bead.summary = assertOptionalString(op.summary, 'summary', LIMITS.summary) ?? '';
      if (op.kind !== undefined) bead.kind = op.kind;
      if (op.status !== undefined) bead.status = op.status;
      if (op.priority !== undefined) bead.priority = op.priority;
      if (op.scope !== undefined) bead.scope = normalizeScope(op.scope);
      if (op.links !== undefined) bead.links = mergeLinks(bead.links, op.links);
      if (op.note) appendJournal(bead, op.actor ?? actor, op.note, nowIso);
    } else if (op.op === 'dep_add') {
      const blockerId = op.blockedBy;
      if (!next.has(blockerId)) {
        throw new BeadsValidationError(`Unknown blocker bead: ${blockerId}`);
      }
      if (detectDependencyCycle(next, bead.id, blockerId)) {
        throw new BeadsValidationError(`Adding ${blockerId} as blocker of ${bead.id} would create a cycle`);
      }
      bead.deps.blockedBy = uniqueSorted([...bead.deps.blockedBy, blockerId]);
    } else if (op.op === 'dep_remove') {
      bead.deps.blockedBy = bead.deps.blockedBy.filter((id) => id !== op.blockedBy);
    } else if (op.op === 'claim') {
      const owner = assertNonEmptyString(op.owner ?? actor, 'owner', LIMITS.actor);
      if (bead.status === 'closed') {
        throw new BeadsConflictError(`Cannot claim closed bead ${bead.id}`);
      }
      if (hasActiveLease(bead, nowMs) && bead.lease.owner !== owner) {
        throw new BeadsConflictError(`Bead ${bead.id} is actively claimed by ${bead.lease.owner} until ${bead.lease.expiresAt}`);
      }
      const ttlHours = op.ttlHours ?? 24;
      if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
        throw new BeadsValidationError('ttlHours must be between 0 and 168');
      }
      const expiresAt = new Date(nowMs + ttlHours * 3600 * 1000).toISOString();
      bead.lease = normalizeLease({ owner, branch: op.branch, claimedAt: nowIso, expiresAt });
      bead.status = 'in_progress';
      if (op.branch) bead.links = mergeLinks(bead.links, { branch: op.branch });
      appendJournal(bead, owner, op.note ?? `Claimed until ${expiresAt}`, nowIso);
    } else if (op.op === 'release') {
      const owner = assertNonEmptyString(op.owner ?? actor, 'owner', LIMITS.actor);
      if (hasActiveLease(bead, nowMs) && bead.lease.owner !== owner && !op.force) {
        throw new BeadsConflictError(`Cannot release ${bead.id}: actively claimed by ${bead.lease.owner}`);
      }
      bead.lease = null;
      if (bead.status === 'in_progress') bead.status = 'open';
      appendJournal(bead, owner, op.note ?? 'Released claim', nowIso);
    } else if (op.op === 'note') {
      appendJournal(bead, op.actor ?? actor, op.note, nowIso);
    } else if (op.op === 'close') {
      const reason = assertNonEmptyString(op.reason ?? op.closeReason, 'reason', LIMITS.closeReason);
      bead.status = 'closed';
      bead.lease = null;
      bead.closedAt = nowIso;
      bead.closeReason = reason;
      if (op.pr !== undefined) bead.links = mergeLinks(bead.links, { pr: op.pr });
      appendJournal(bead, op.actor ?? actor, `Closed: ${reason}`, nowIso);
    } else if (op.op === 'reopen') {
      bead.status = 'open';
      bead.closedAt = null;
      bead.closeReason = null;
      appendJournal(bead, op.actor ?? actor, op.note ?? 'Reopened', nowIso);
    } else {
      throw new BeadsValidationError(`Unsupported operation: ${op.op}`);
    }

    bead.updatedAt = nowIso;
    bead.revision += 1;
    next.set(bead.id, validateBead(bead));
    changedIds.add(bead.id);
    updatedIds.push(bead.id);
  }

  return {
    beads: next,
    changedIds: [...changedIds].sort(),
    createdIds,
    updatedIds,
    untouchedIds,
  };
}

function mergeJournalEntries(a, b) {
  const seen = new Set();
  const merged = [];
  for (const entry of [...a, ...b]) {
    const key = `${entry.at}\0${entry.actor}\0${entry.note}`;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  merged.sort((x, y) => x.at.localeCompare(y.at) || x.actor.localeCompare(y.actor) || x.note.localeCompare(y.note));
  return merged.slice(-LIMITS.journal);
}

export function mergeBeadsMaps(localMap, remoteMap) {
  const merged = new Map();
  const allIds = uniqueSorted([...localMap.keys(), ...remoteMap.keys()]);
  for (const id of allIds) {
    const local = localMap.get(id);
    const remote = remoteMap.get(id);
    if (!local) {
      merged.set(id, structuredClone(remote));
      continue;
    }
    if (!remote) {
      merged.set(id, structuredClone(local));
      continue;
    }
    const localWins = local.revision > remote.revision
      || (local.revision === remote.revision && local.updatedAt >= remote.updatedAt);
    const winner = structuredClone(localWins ? local : remote);
    const other = localWins ? remote : local;
    winner.journal = mergeJournalEntries(winner.journal, other.journal);
    winner.links = mergeLinks(winner.links, { evidence: other.links.evidence ?? [] });
    if (other.lastSeenAt > winner.lastSeenAt) winner.lastSeenAt = other.lastSeenAt;
    merged.set(id, validateBead(winner));
  }
  return merged;
}

function git(args, { cwd, input } = {}) {
  return execFileSync('git', args, {
    cwd,
    input,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

function gitRefSha(cwd, ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref], { cwd }).trim() || null;
  } catch {
    return null;
  }
}

function hashBlob(cwd, content) {
  return git(['hash-object', '-w', '--stdin'], { cwd, input: content }).trim();
}

function buildTreeFromMap(cwd, beadsMap) {
  const schemaContent = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, format: 'neurodesk-beads' }, null, 2)}\n`;
  const schemaBlob = hashBlob(cwd, schemaContent);
  const beadEntries = [];
  for (const id of [...beadsMap.keys()].sort()) {
    const json = `${JSON.stringify(beadsMap.get(id), null, 2)}\n`;
    const blob = hashBlob(cwd, json);
    beadEntries.push(`100644 blob ${blob}\t${id}.json`);
  }
  const rootEntries = [`100644 blob ${schemaBlob}\tschema.json`];
  if (beadEntries.length > 0) {
    const beadsTree = git(['mktree'], { cwd, input: `${beadEntries.join('\n')}\n` }).trim();
    rootEntries.push(`040000 tree ${beadsTree}\tbeads`);
  }
  return git(['mktree'], { cwd, input: `${rootEntries.join('\n')}\n` }).trim();
}

export function readBeadsFromRef(cwd, ref = DEFAULT_BEADS_REF) {
  const sha = gitRefSha(cwd, ref);
  if (!sha) return { sha: null, beads: new Map() };
  let listing = '';
  try {
    listing = git(['ls-tree', '-r', '-z', sha, '--', 'beads'], { cwd });
  } catch {
    return { sha, beads: new Map() };
  }
  const beads = new Map();
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const [meta, filePath] = record.split('\t');
    if (!filePath || !filePath.endsWith('.json')) continue;
    const blobSha = meta.split(' ')[2];
    const raw = git(['cat-file', '-p', blobSha], { cwd });
    const bead = validateBead(JSON.parse(raw));
    beads.set(bead.id, bead);
  }
  return { sha, beads };
}

export function commitBeadsToRef(cwd, beadsMap, { ref = DEFAULT_BEADS_REF, expectedParentSha = null, message = 'beads: update work graph', authorName = 'neurodesk-beads', authorEmail = 'beads@neurodesk.local' } = {}) {
  const treeSha = buildTreeFromMap(cwd, beadsMap);
  const args = ['commit-tree', treeSha, '-m', message];
  if (expectedParentSha) {
    args.push('-p', expectedParentSha);
  }
  const commitSha = execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || authorName,
      GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || authorEmail,
      GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || authorName,
      GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || authorEmail,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();

  const oldArg = expectedParentSha ?? '0000000000000000000000000000000000000000';
  try {
    git(['update-ref', ref, commitSha, oldArg], { cwd });
  } catch (error) {
    throw new BeadsConflictError(`Concurrent update detected on ${ref}: ${error.message}`);
  }
  return commitSha;
}

export function mutateBeadsRef(cwd, operations, { ref = DEFAULT_BEADS_REF, message = 'beads: apply operations', maxRetries = 5, ...applyOptions } = {}) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { sha, beads } = readBeadsFromRef(cwd, ref);
    const result = applyOperations(beads, operations, applyOptions);
    if (result.changedIds.length === 0 && sha !== null) {
      return { ...result, commitSha: sha, changed: false };
    }
    try {
      const commitSha = commitBeadsToRef(cwd, result.beads, { ref, expectedParentSha: sha, message });
      return { ...result, commitSha, changed: true };
    } catch (error) {
      if (error instanceof BeadsConflictError && attempt + 1 < maxRetries) continue;
      throw error;
    }
  }
  throw new BeadsConflictError(`Failed to update ${ref} after ${maxRetries} attempts`);
}

export function initBeadsRef(cwd, { ref = DEFAULT_BEADS_REF } = {}) {
  const existing = gitRefSha(cwd, ref);
  if (existing) return { sha: existing, created: false };
  const sha = commitBeadsToRef(cwd, new Map(), {
    ref,
    expectedParentSha: null,
    message: 'beads: initialize orphan memory branch',
  });
  return { sha, created: true };
}

export function syncBeadsRef(cwd, { ref = DEFAULT_BEADS_REF, remote = 'origin', push = false } = {}) {
  const shortBranch = ref.replace(/^refs\/heads\//, '');
  const trackingRef = `refs/remotes/${remote}/${shortBranch}`;
  let remoteFetched = false;
  try {
    git(['fetch', remote, `${ref}:${trackingRef}`], { cwd });
    remoteFetched = true;
  } catch {
    remoteFetched = false;
  }

  const localState = readBeadsFromRef(cwd, ref);
  const remoteState = remoteFetched ? readBeadsFromRef(cwd, trackingRef) : { sha: null, beads: new Map() };
  let finalSha = localState.sha;
  let mergedCount = localState.beads.size;

  if (remoteState.sha && !localState.sha) {
    git(['update-ref', ref, remoteState.sha], { cwd });
    finalSha = remoteState.sha;
    mergedCount = remoteState.beads.size;
  } else if (remoteState.sha && localState.sha && remoteState.sha !== localState.sha) {
    const merged = mergeBeadsMaps(localState.beads, remoteState.beads);
    mergedCount = merged.size;
    const treeSha = buildTreeFromMap(cwd, merged);
    const commitSha = execFileSync('git', ['commit-tree', treeSha, '-p', localState.sha, '-p', remoteState.sha, '-m', `beads: sync with ${remote}/${shortBranch}`], {
      cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: process.env.GIT_AUTHOR_NAME || 'neurodesk-beads',
        GIT_AUTHOR_EMAIL: process.env.GIT_AUTHOR_EMAIL || 'beads@neurodesk.local',
        GIT_COMMITTER_NAME: process.env.GIT_COMMITTER_NAME || 'neurodesk-beads',
        GIT_COMMITTER_EMAIL: process.env.GIT_COMMITTER_EMAIL || 'beads@neurodesk.local',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
    git(['update-ref', ref, commitSha, localState.sha], { cwd });
    finalSha = commitSha;
  } else if (!localState.sha && !remoteState.sha) {
    finalSha = initBeadsRef(cwd, { ref }).sha;
    mergedCount = 0;
  }

  let pushed = false;
  if (push && finalSha) {
    const leaseArg = remoteState.sha ? `--force-with-lease=${ref}:${remoteState.sha}` : `--force-with-lease=${ref}:`;
    git(['push', leaseArg, remote, `${ref}:${ref}`], { cwd });
    pushed = true;
  }

  return { ref, remote, remoteFetched, sha: finalSha, count: mergedCount, pushed };
}
