import { createHash, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const SCHEMA_VERSION = 1;
export const DEFAULT_BEADS_REF = 'refs/heads/memory/beads';
export const BEAD_ID_PATTERN = /^bd-[0-9a-f]{8}$/;

export const BEAD_KINDS = Object.freeze(['maintenance', 'rollout', 'followup', 'blocker', 'hardware']);
export const BEAD_STATUSES = Object.freeze(['open', 'in_progress', 'blocked', 'closed']);
export const SCOPE_TYPES = Object.freeze(['app', 'package', 'exe', 'shared', 'repo']);

const MEMORY_REF_PATTERN = /^refs\/heads\/memory\/[a-z0-9][a-z0-9._/-]*$/;
const REMOTE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const RELEASED_LEASE_HASH_PATTERN = /^[0-9a-f]{12}$/;
const ISO_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/;
const ZERO_OID = '0000000000000000000000000000000000000000';

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
  releasedLeases: 50,
});

const ALLOWED_OP_KEYS = Object.freeze({
  create: new Set(['op', 'id', 'title', 'summary', 'kind', 'status', 'priority', 'scope', 'dedupeKey', 'deps', 'links', 'note', 'actor', 'closeReason']),
  upsert: new Set(['op', 'id', 'title', 'summary', 'kind', 'status', 'priority', 'scope', 'dedupeKey', 'deps', 'links', 'note', 'actor', 'closeReason', 'expectedRevision']),
  update: new Set(['op', 'id', 'expectedRevision', 'title', 'summary', 'kind', 'status', 'priority', 'scope', 'links', 'note', 'actor']),
  dep_add: new Set(['op', 'id', 'expectedRevision', 'blockedBy']),
  dep_remove: new Set(['op', 'id', 'expectedRevision', 'blockedBy']),
  claim: new Set(['op', 'id', 'expectedRevision', 'owner', 'branch', 'ttlHours', 'note']),
  release: new Set(['op', 'id', 'expectedRevision', 'owner', 'force', 'note']),
  note: new Set(['op', 'id', 'expectedRevision', 'note', 'actor']),
  close: new Set(['op', 'id', 'expectedRevision', 'reason', 'closeReason', 'pr', 'actor']),
  reopen: new Set(['op', 'id', 'expectedRevision', 'note', 'actor']),
});

const ALLOWED_LINK_KEYS = new Set(['githubIssue', 'pr', 'branch', 'evidence']);
const ALLOWED_DEP_KEYS = new Set(['blockedBy', 'parent', 'discoveredFrom']);
const ALLOWED_SCOPE_KEYS = new Set(['type', 'targets']);
const ALLOWED_LEASE_KEYS = new Set(['owner', 'branch', 'claimedAt', 'expiresAt']);
const ALLOWED_JOURNAL_KEYS = new Set(['at', 'actor', 'note']);
const ALLOWED_BEAD_KEYS = new Set([
  'schemaVersion',
  'id',
  'revision',
  'stateRevision',
  'title',
  'summary',
  'kind',
  'status',
  'priority',
  'scope',
  'dedupeKey',
  'deps',
  'links',
  'lease',
  'releasedLeases',
  'leaseFloorAt',
  'leaseReleasedAt',
  'journal',
  'createdAt',
  'updatedAt',
  'stateUpdatedAt',
  'lastSeenAt',
  'closedAt',
  'reopenedAt',
  'closeReason',
]);

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

function assertAllowedKeys(obj, allowed, label) {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new BeadsValidationError(`Unexpected field "${key}" in ${label}`);
    }
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
  if (typeof value !== 'string') {
    throw new BeadsValidationError(`${field} must be a valid ISO-8601 timestamp`);
  }
  const match = ISO_TIMESTAMP_PATTERN.exec(value);
  if (!match) {
    throw new BeadsValidationError(`${field} must be a valid ISO-8601 timestamp`);
  }
  const [, yStr, mStr, dStr, hStr, minStr, sStr, , tz] = match;
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  const hour = Number(hStr);
  const minute = Number(minStr);
  const second = Number(sStr);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    throw new BeadsValidationError(`${field} must be a valid calendar ISO-8601 timestamp`);
  }
  const checkUtc = new Date(0);
  checkUtc.setUTCFullYear(year, month - 1, day);
  if (checkUtc.getUTCFullYear() !== year || checkUtc.getUTCMonth() !== month - 1 || checkUtc.getUTCDate() !== day) {
    throw new BeadsValidationError(`${field} must be a valid calendar ISO-8601 timestamp`);
  }
  if (tz !== 'Z') {
    const tzHours = Number(tz.slice(1, 3));
    const tzMins = Number(tz.slice(4, 6));
    if (tzHours > 23 || tzMins > 59) {
      throw new BeadsValidationError(`${field} has an invalid timezone offset`);
    }
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new BeadsValidationError(`${field} must be a valid ISO-8601 timestamp`);
  }
  const iso = new Date(ms).toISOString();
  if (!ISO_TIMESTAMP_PATTERN.test(iso)) {
    throw new BeadsValidationError(`${field} normalizes outside 4-digit ISO-8601 range`);
  }
  return iso;
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

export function assertMemoryRef(ref) {
  if (typeof ref !== 'string' || !MEMORY_REF_PATTERN.test(ref)) {
    throw new BeadsValidationError(`Ref must live under refs/heads/memory/: ${ref}`);
  }
  if (ref.includes('..') || ref.includes('//') || ref.includes('@{') || ref.endsWith('/') || ref.endsWith('.') || ref.endsWith('.lock')) {
    throw new BeadsValidationError(`Invalid memory ref name: ${ref}`);
  }
  return ref;
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
  assertAllowedKeys(scope, ALLOWED_SCOPE_KEYS, 'scope');
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
  assertAllowedKeys(deps, ALLOWED_DEP_KEYS, 'deps');
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
  assertAllowedKeys(links, ALLOWED_LINK_KEYS, 'links');
  const out = {};
  if (links.githubIssue !== undefined && links.githubIssue !== null) {
    if (!Number.isSafeInteger(links.githubIssue) || links.githubIssue <= 0) {
      throw new BeadsValidationError('links.githubIssue must be a positive safe integer');
    }
    out.githubIssue = links.githubIssue;
  }
  if (links.pr !== undefined && links.pr !== null) {
    if (!Number.isSafeInteger(links.pr) || links.pr <= 0) {
      throw new BeadsValidationError('links.pr must be a positive safe integer');
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
  assertAllowedKeys(lease, ALLOWED_LEASE_KEYS, 'lease');
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
    assertAllowedKeys(entry, ALLOWED_JOURNAL_KEYS, `journal[${idx}]`);
    return {
      at: assertIsoTimestamp(entry.at, `journal[${idx}].at`),
      actor: assertNonEmptyString(entry.actor, `journal[${idx}].actor`, LIMITS.actor),
      note: assertNonEmptyString(entry.note, `journal[${idx}].note`, LIMITS.note),
    };
  });
  return normalized.slice(-LIMITS.journal);
}

function deterministicHash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function leaseKey(lease) {
  const hash = deterministicHash({
    owner: lease.owner,
    branch: lease.branch ?? null,
    claimedAt: lease.claimedAt,
    expiresAt: lease.expiresAt,
  }).slice(0, 12);
  return `v2:${lease.claimedAt}|${lease.expiresAt}|${hash}`;
}

function stripTombstonePrefix(entry) {
  if (entry.startsWith('v2+:')) return entry.slice(4);
  if (entry.startsWith('v2:')) return entry.slice(3);
  return entry;
}

function tombstoneClaimedAt(entry) {
  const body = stripTombstonePrefix(entry);
  return body.slice(0, body.indexOf('|'));
}

function sortTombstones(entries) {
  const unique = new Set(entries);
  for (const entry of [...unique]) {
    if (entry.startsWith('v2+:')) {
      const body = entry.slice(4);
      unique.delete(`v2:${body}`);
      unique.delete(body);
    } else if (entry.startsWith('v2:')) {
      const body = entry.slice(3);
      if (unique.has(body)) {
        unique.delete(entry);
        unique.delete(body);
        unique.add(`v2+:${body}`);
      }
    }
  }
  return [...unique].sort((a, b) =>
    tombstoneClaimedAt(a).localeCompare(tombstoneClaimedAt(b)) || a.localeCompare(b),
  );
}

function trimReleasedLeases(entries, existingFloorAt = null) {
  const sorted = sortTombstones(entries);
  let floorAt = existingFloorAt;
  if (sorted.length > LIMITS.releasedLeases) {
    const overflowCount = sorted.length - LIMITS.releasedLeases;
    for (let i = 0; i < overflowCount; i++) {
      const evictedClaimedAt = tombstoneClaimedAt(sorted[i]);
      if (!floorAt || evictedClaimedAt > floorAt) {
        floorAt = evictedClaimedAt;
      }
    }
    return {
      releasedLeases: sorted.slice(overflowCount),
      leaseFloorAt: floorAt,
    };
  }
  return { releasedLeases: sorted, leaseFloorAt: floorAt };
}

function normalizeReleasedLeases(raw = []) {
  if (!Array.isArray(raw)) {
    throw new BeadsValidationError('releasedLeases must be an array');
  }
  if (raw.length > LIMITS.releasedLeases) {
    throw new BeadsValidationError(`releasedLeases exceeds maximum length of ${LIMITS.releasedLeases}`);
  }
  const normalized = raw.map((item, idx) => {
    if (typeof item !== 'string') {
      throw new BeadsValidationError(`releasedLeases[${idx}] must be a string`);
    }
    if (item.startsWith('v2:') || item.startsWith('v2+:')) {
      const prefix = item.startsWith('v2+:') ? 'v2+:' : 'v2:';
      const parts = item.slice(prefix.length).split('|');
      if (parts.length !== 3 || !RELEASED_LEASE_HASH_PATTERN.test(parts[2])) {
        throw new BeadsValidationError(`releasedLeases[${idx}] must have format "${prefix}<claimedAt>|<expiresAt>|<hash>"`);
      }
      const claimedAt = assertIsoTimestamp(parts[0], `releasedLeases[${idx}].claimedAt`);
      const expiresAt = assertIsoTimestamp(parts[1], `releasedLeases[${idx}].expiresAt`);
      if (Date.parse(expiresAt) <= Date.parse(claimedAt)) {
        throw new BeadsValidationError(`releasedLeases[${idx}] expiresAt must be after claimedAt`);
      }
      return `${prefix}${claimedAt}|${expiresAt}|${parts[2]}`;
    }
    const firstPipe = item.indexOf('|');
    if (firstPipe <= 0) {
      throw new BeadsValidationError(`releasedLeases[${idx}] must have format "v2:<claimedAt>|<expiresAt>|<hash>"`);
    }
    // Legacy schema-v1 tombstone format: "<claimedAt>|<owner>" (owner is preserved verbatim)
    const claimedAt = assertIsoTimestamp(item.slice(0, firstPipe), `releasedLeases[${idx}].claimedAt`);
    const owner = assertNonEmptyString(item.slice(firstPipe + 1), `releasedLeases[${idx}].owner`, LIMITS.actor);
    return `${claimedAt}|${owner}`;
  });
  return sortTombstones(normalized);
}

export function validateBead(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BeadsValidationError('Bead must be an object');
  }
  assertAllowedKeys(raw, ALLOWED_BEAD_KEYS, 'bead');
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    throw new BeadsValidationError(`Unsupported bead schemaVersion: ${raw.schemaVersion}`);
  }
  if (typeof raw.id !== 'string' || !BEAD_ID_PATTERN.test(raw.id)) {
    throw new BeadsValidationError(`Invalid bead id: ${raw.id}`);
  }
  if (!Number.isSafeInteger(raw.revision) || raw.revision < 1) {
    throw new BeadsValidationError('revision must be a positive safe integer');
  }
  const stateRevision = raw.stateRevision === undefined ? raw.revision : raw.stateRevision;
  if (!Number.isSafeInteger(stateRevision) || stateRevision < 1) {
    throw new BeadsValidationError('stateRevision must be a positive safe integer');
  }
  const title = assertNonEmptyString(raw.title, 'title', LIMITS.title);
  const summary = assertOptionalString(raw.summary, 'summary', LIMITS.summary) ?? '';
  if (!BEAD_KINDS.includes(raw.kind)) {
    throw new BeadsValidationError(`kind must be one of: ${BEAD_KINDS.join(', ')}`);
  }
  if (!BEAD_STATUSES.includes(raw.status)) {
    throw new BeadsValidationError(`status must be one of: ${BEAD_STATUSES.join(', ')}`);
  }
  const priority = raw.priority === undefined ? 2 : raw.priority;
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 3) {
    throw new BeadsValidationError('priority must be an integer 0..3');
  }
  const scope = normalizeScope(raw.scope);
  const dedupeKey = assertOptionalString(raw.dedupeKey, 'dedupeKey', LIMITS.dedupeKey);
  const deps = normalizeDeps(raw.deps);
  if (deps.blockedBy.includes(raw.id)) {
    throw new BeadsValidationError(`Bead ${raw.id} cannot block itself`);
  }
  if (deps.parent === raw.id) {
    throw new BeadsValidationError(`Bead ${raw.id} cannot be its own parent`);
  }
  if (deps.discoveredFrom === raw.id) {
    throw new BeadsValidationError(`Bead ${raw.id} cannot be discoveredFrom itself`);
  }
  const links = normalizeLinks(raw.links);
  const lease = normalizeLease(raw.lease);
  const releasedLeases = normalizeReleasedLeases(raw.releasedLeases);
  const rawLeaseFloorAt = raw.leaseFloorAt === undefined || raw.leaseFloorAt === null ? null : assertIsoTimestamp(raw.leaseFloorAt, 'leaseFloorAt');
  const legacyLeaseReleasedAt = raw.leaseReleasedAt === undefined || raw.leaseReleasedAt === null ? null : assertIsoTimestamp(raw.leaseReleasedAt, 'leaseReleasedAt');
  const leaseFloorAt = [rawLeaseFloorAt, legacyLeaseReleasedAt].filter(Boolean).sort().at(-1) ?? null;
  const journal = normalizeJournal(raw.journal);
  const createdAt = assertIsoTimestamp(raw.createdAt, 'createdAt');
  const updatedAt = assertIsoTimestamp(raw.updatedAt, 'updatedAt');
  const stateUpdatedAt = assertIsoTimestamp(raw.stateUpdatedAt ?? updatedAt, 'stateUpdatedAt');
  const lastSeenAt = assertIsoTimestamp(raw.lastSeenAt ?? updatedAt, 'lastSeenAt');
  const closedAt = raw.closedAt === undefined || raw.closedAt === null ? null : assertIsoTimestamp(raw.closedAt, 'closedAt');
  const reopenedAt = raw.reopenedAt === undefined || raw.reopenedAt === null ? null : assertIsoTimestamp(raw.reopenedAt, 'reopenedAt');
  const closeReason = assertOptionalString(raw.closeReason, 'closeReason', LIMITS.closeReason);

  if (raw.status === 'closed') {
    if (!closedAt || !closeReason) {
      throw new BeadsValidationError(`Closed bead ${raw.id} must have closedAt and closeReason`);
    }
    if (lease !== null) {
      throw new BeadsValidationError(`Closed bead ${raw.id} cannot hold a lease`);
    }
  } else if (closedAt !== null || closeReason !== null) {
    throw new BeadsValidationError(`Non-closed bead ${raw.id} must not set closedAt or closeReason`);
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    id: raw.id,
    revision: raw.revision,
    stateRevision,
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
    releasedLeases,
    leaseFloorAt,
    journal,
    createdAt,
    updatedAt,
    stateUpdatedAt,
    lastSeenAt,
    closedAt,
    reopenedAt,
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

function assertAcyclicRelation(beadsMap, label, getEdges) {
  const color = new Map();
  function visit(id) {
    const state = color.get(id) ?? 0;
    if (state === 1) {
      throw new BeadsConflictError(`${label} cycle detected involving ${id}`);
    }
    if (state === 2) return;
    color.set(id, 1);
    for (const next of getEdges(beadsMap.get(id))) {
      visit(next);
    }
    color.set(id, 2);
  }
  for (const id of [...beadsMap.keys()].sort()) {
    visit(id);
  }
}

export function validateBeadsGraph(beadsMap) {
  const seenDedupeKeys = new Map();
  for (const [id, bead] of beadsMap.entries()) {
    validateBead(bead);
    if (bead.id !== id) {
      throw new BeadsValidationError(`Map key ${id} does not match bead.id ${bead.id}`);
    }
    if (bead.dedupeKey) {
      const priorId = seenDedupeKeys.get(bead.dedupeKey);
      if (priorId && priorId !== id) {
        throw new BeadsConflictError(`Duplicate dedupeKey "${bead.dedupeKey}" on ${priorId} and ${id}`);
      }
      seenDedupeKeys.set(bead.dedupeKey, id);
    }
    for (const depId of bead.deps.blockedBy) {
      if (!beadsMap.has(depId)) {
        throw new BeadsValidationError(`Bead ${id} references unknown blocker ${depId}`);
      }
    }
    if (bead.deps.parent && !beadsMap.has(bead.deps.parent)) {
      throw new BeadsValidationError(`Bead ${id} references unknown parent ${bead.deps.parent}`);
    }
    if (bead.deps.discoveredFrom && !beadsMap.has(bead.deps.discoveredFrom)) {
      throw new BeadsValidationError(`Bead ${id} references unknown discoveredFrom ${bead.deps.discoveredFrom}`);
    }
  }

  assertAcyclicRelation(beadsMap, 'Dependency', (b) => b.deps.blockedBy);
  assertAcyclicRelation(beadsMap, 'Parent', (b) => (b.deps.parent ? [b.deps.parent] : []));
  assertAcyclicRelation(beadsMap, 'DiscoveredFrom', (b) => (b.deps.discoveredFrom ? [b.deps.discoveredFrom] : []));
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
  if (!Number.isSafeInteger(maxItems) || maxItems < 0) {
    throw new BeadsValidationError(`maxItems must be a non-negative safe integer (got ${maxItems})`);
  }
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
  const closedDedupeKeys = listBeads(beadsMap, { status: 'closed' })
    .map((bead) => bead.dedupeKey)
    .filter((key) => typeof key === 'string' && key.length > 0)
    .sort()
    .slice(0, Math.max(maxItems * 2, 200));
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date(nowMs).toISOString(),
    total: beadsMap.size,
    openCount: items.length,
    closedDedupeKeys,
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
    if (map.has(bead.id)) {
      throw new BeadsConflictError(`Duplicate bead id in JSONL: ${bead.id}`);
    }
    map.set(bead.id, bead);
  }
  validateBeadsGraph(map);
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

function nextRevision(current) {
  if (!Number.isSafeInteger(current) || current < 1 || current >= Number.MAX_SAFE_INTEGER) {
    throw new BeadsValidationError(`revision ${current} cannot be safely incremented`);
  }
  return current + 1;
}

function checkExpectedRevision(bead, expectedRevision, requireExpectedRevision) {
  if (expectedRevision === undefined || expectedRevision === null) {
    if (requireExpectedRevision) {
      throw new BeadsValidationError(`Operation on ${bead.id} requires expectedRevision`);
    }
    return;
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new BeadsValidationError(`expectedRevision must be a positive safe integer for ${bead.id}`);
  }
  if (bead.revision !== expectedRevision) {
    throw new BeadsConflictError(`Stale revision for ${bead.id}: expected ${expectedRevision}, actual ${bead.revision}`);
  }
}

function appendJournal(bead, actor, note, nowIso) {
  const cleanActor = assertNonEmptyString(actor, 'actor', LIMITS.actor);
  const cleanNote = assertNonEmptyString(note, 'note', LIMITS.note);
  const exists = bead.journal.some((entry) => entry.actor === cleanActor && entry.note === cleanNote);
  if (exists) return false;
  bead.journal = [...bead.journal, { at: nowIso, actor: cleanActor, note: cleanNote }].slice(-LIMITS.journal);
  return true;
}

function mergeLinks(base, patch, { capEvidence = false } = {}) {
  if (patch === undefined) return base;
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new BeadsValidationError('links must be an object');
  }
  assertAllowedKeys(patch, ALLOWED_LINK_KEYS, 'links');
  const merged = { ...base };
  if (patch.githubIssue !== undefined) merged.githubIssue = patch.githubIssue;
  if (patch.pr !== undefined) merged.pr = patch.pr;
  if (patch.branch !== undefined) merged.branch = patch.branch;
  if (patch.evidence !== undefined) {
    if (!Array.isArray(patch.evidence)) {
      throw new BeadsValidationError('links.evidence must be an array');
    }
    const combined = uniqueSorted([...(base.evidence ?? []), ...patch.evidence]);
    merged.evidence = capEvidence ? combined.slice(0, LIMITS.evidence) : combined;
  }
  return normalizeLinks(merged);
}

function resolveOpActor(opActor, trustedActor, lockActor) {
  if (lockActor) {
    if (opActor !== undefined && opActor !== trustedActor) {
      throw new BeadsValidationError(`Payload actor "${opActor}" cannot override trusted actor "${trustedActor}" in safe mode`);
    }
    return trustedActor;
  }
  return opActor ?? trustedActor;
}

function validateRefsExist(beadsMap, bead) {
  for (const depId of bead.deps.blockedBy) {
    if (!beadsMap.has(depId)) {
      throw new BeadsValidationError(`Unknown dependency bead: ${depId}`);
    }
  }
  if (bead.deps.parent && !beadsMap.has(bead.deps.parent)) {
    throw new BeadsValidationError(`Unknown parent bead: ${bead.deps.parent}`);
  }
  if (bead.deps.discoveredFrom && !beadsMap.has(bead.deps.discoveredFrom)) {
    throw new BeadsValidationError(`Unknown discoveredFrom bead: ${bead.deps.discoveredFrom}`);
  }
}

function validateUpsertOptionalFields(op, beadsMap, existingId) {
  if (op.title !== undefined) assertNonEmptyString(op.title, 'title', LIMITS.title);
  if (op.summary !== undefined) assertOptionalString(op.summary, 'summary', LIMITS.summary);
  if (op.kind !== undefined && !BEAD_KINDS.includes(op.kind)) {
    throw new BeadsValidationError(`kind must be one of: ${BEAD_KINDS.join(', ')}`);
  }
  if (op.status !== undefined && !BEAD_STATUSES.includes(op.status)) {
    throw new BeadsValidationError(`status must be one of: ${BEAD_STATUSES.join(', ')}`);
  }
  if (op.priority !== undefined && (!Number.isSafeInteger(op.priority) || op.priority < 0 || op.priority > 3)) {
    throw new BeadsValidationError('priority must be an integer 0..3');
  }
  if (op.scope !== undefined) normalizeScope(op.scope);
  if (op.deps !== undefined) {
    const deps = normalizeDeps(op.deps);
    if (deps.blockedBy.includes(existingId) || deps.parent === existingId || deps.discoveredFrom === existingId) {
      throw new BeadsValidationError(`Bead ${existingId} cannot reference itself in deps`);
    }
    validateRefsExist(beadsMap, { deps });
  }
  if (op.links !== undefined) normalizeLinks(op.links);
  if (op.note !== undefined) assertOptionalString(op.note, 'note', LIMITS.note);
  if (op.closeReason !== undefined) assertOptionalString(op.closeReason, 'closeReason', LIMITS.closeReason);
}

function recordReleasedLease(bead) {
  if (!bead.lease) return;
  const trimmed = trimReleasedLeases([...(bead.releasedLeases ?? []), leaseKey(bead.lease)], bead.leaseFloorAt ?? null);
  bead.releasedLeases = trimmed.releasedLeases;
  bead.leaseFloorAt = trimmed.leaseFloorAt;
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
    lockActor = false,
  } = options;
  const nowDate = now instanceof Date ? now : new Date(now);
  const baseNowMs = nowDate.getTime();
  const next = cloneMap(beadsMap);
  const changedIds = new Set();
  const createdIds = [];
  const updatedIds = [];
  const untouchedIds = [];
  let creates = 0;
  let updates = 0;

  for (let index = 0; index < operations.length; index++) {
    const opNowMs = baseNowMs + index;
    const opNowIso = new Date(opNowMs).toISOString();
    const op = operations[index];
    if (!op || typeof op !== 'object' || Array.isArray(op) || typeof op.op !== 'string') {
      throw new BeadsValidationError(`operations[${index}] must be an object with an "op" field`);
    }
    const allowedKeys = ALLOWED_OP_KEYS[op.op];
    if (!allowedKeys) {
      throw new BeadsValidationError(`Unsupported operation: ${op.op}`);
    }
    assertAllowedKeys(op, allowedKeys, `operations[${index}] (${op.op})`);

    if (op.op === 'create' || op.op === 'upsert') {
      const opActor = resolveOpActor(op.actor, actor, lockActor);
      const dedupeKey = assertOptionalString(op.dedupeKey, 'dedupeKey', LIMITS.dedupeKey);
      if (op.id !== undefined && (typeof op.id !== 'string' || !BEAD_ID_PATTERN.test(op.id))) {
        throw new BeadsValidationError(`Invalid bead id: ${op.id}`);
      }
      if (requireExpectedRevision && !dedupeKey && !op.id) {
        throw new BeadsValidationError(`Safe ${op.op} requires dedupeKey or id for idempotent identity`);
      }

      const byKey = dedupeKey ? findByDedupeKey(next, dedupeKey) : null;
      const byId = op.id ? next.get(op.id) : null;
      if (op.id && byKey && byKey.id !== op.id) {
        throw new BeadsConflictError(`id ${op.id} conflicts with existing dedupeKey match ${byKey.id}`);
      }
      if (byKey && byId && byKey.id !== byId.id) {
        throw new BeadsConflictError(`id ${op.id} and dedupeKey ${dedupeKey} match different beads (${byId.id} vs ${byKey.id})`);
      }
      if (op.id && dedupeKey && !byKey && !byId && op.id !== deriveBeadId(dedupeKey)) {
        throw new BeadsConflictError(`Supplied id ${op.id} does not match derived id ${deriveBeadId(dedupeKey)} for dedupeKey "${dedupeKey}"`);
      }

      const existing = byKey ?? byId;
      if (existing && op.op === 'create') {
        throw new BeadsConflictError(`Bead already exists: ${existing.id}`);
      }
      if (existing) {
        validateUpsertOptionalFields(op, next, existing.id);
        if (dedupeKey && existing.dedupeKey !== dedupeKey) {
          throw new BeadsConflictError(
            existing.dedupeKey
              ? `Bead ${existing.id} has dedupeKey "${existing.dedupeKey}", not "${dedupeKey}"`
              : `Bead ${existing.id} has no dedupeKey and cannot match dedupeKey "${dedupeKey}"`,
          );
        }
        if (singleAppOnly && !isSingleAppScope(existing)) {
          throw new BeadsValidationError(`Bead ${existing.id} is outside single-app scope`);
        }
        if (op.scope !== undefined) {
          const nextScope = normalizeScope(op.scope);
          if (singleAppOnly && !(nextScope.type === 'app' && nextScope.targets.length === 1)) {
            throw new BeadsValidationError(`Updated scope for ${existing.id} must target a single app`);
          }
        }
        const mergedLinks = mergeLinks(existing.links, op.links);
        const linksChanged = JSON.stringify(mergedLinks) !== JSON.stringify(existing.links);
        const nextSummary = op.summary !== undefined ? (assertOptionalString(op.summary, 'summary', LIMITS.summary) ?? '') : existing.summary;
        const summaryChanged = nextSummary !== existing.summary;
        const noteText = assertOptionalString(op.note, 'note', LIMITS.note);
        const noteIsNew = Boolean(noteText) && !existing.journal.some((entry) => entry.actor === opActor && entry.note === noteText);

        if (!linksChanged && !summaryChanged && !noteIsNew) {
          if (op.expectedRevision !== undefined && op.expectedRevision !== null) {
            checkExpectedRevision(existing, op.expectedRevision, false);
          }
          untouchedIds.push(existing.id);
          continue;
        }

        checkExpectedRevision(existing, op.expectedRevision, requireExpectedRevision);
        updates++;
        if (updates > maxUpdates) {
          throw new BeadsValidationError(`Operation batch exceeds maxUpdates (${maxUpdates})`);
        }
        const prevStateSig = stateSignature(existing);
        existing.links = mergedLinks;
        existing.summary = nextSummary;
        if (noteText) appendJournal(existing, opActor, noteText, opNowIso);
        existing.lastSeenAt = opNowIso;
        existing.updatedAt = opNowIso;
        if (stateSignature(existing) !== prevStateSig) {
          existing.stateRevision = nextRevision(existing.stateRevision);
          existing.stateUpdatedAt = opNowIso;
        }
        existing.revision = nextRevision(existing.revision);
        next.set(existing.id, validateBead(existing));
        changedIds.add(existing.id);
        updatedIds.push(existing.id);
        continue;
      }

      if (op.expectedRevision !== undefined && op.expectedRevision !== null) {
        throw new BeadsConflictError('Cannot create a new bead when expectedRevision is specified');
      }
      creates++;
      if (creates > maxCreates) {
        throw new BeadsValidationError(`Operation batch exceeds maxCreates (${maxCreates})`);
      }
      const id = op.id ?? (dedupeKey ? deriveBeadId(dedupeKey) : generateBeadId(new Set(next.keys())));
      if (next.has(id)) {
        throw new BeadsConflictError(`Bead id collision for ${id}`);
      }
      const createNote = assertOptionalString(op.note, 'note', LIMITS.note);
      const createCloseReason = assertOptionalString(op.closeReason, 'closeReason', LIMITS.closeReason);
      const initial = validateBead({
        schemaVersion: SCHEMA_VERSION,
        id,
        revision: 1,
        stateRevision: 1,
        title: op.title,
        summary: op.summary ?? '',
        kind: op.kind === undefined ? 'maintenance' : op.kind,
        status: op.status === undefined ? 'open' : op.status,
        priority: op.priority === undefined ? 2 : op.priority,
        scope: op.scope,
        dedupeKey,
        deps: op.deps === undefined ? {} : op.deps,
        links: op.links === undefined ? {} : op.links,
        lease: null,
        releasedLeases: [],
        journal: createNote ? [{ at: opNowIso, actor: opActor, note: createNote }] : [],
        createdAt: opNowIso,
        updatedAt: opNowIso,
        stateUpdatedAt: opNowIso,
        lastSeenAt: opNowIso,
        closedAt: op.status === 'closed' ? opNowIso : null,
        reopenedAt: null,
        closeReason: createCloseReason,
      });
      if (singleAppOnly && !isSingleAppScope(initial)) {
        throw new BeadsValidationError(`New bead ${initial.id} must target a single app`);
      }
      validateRefsExist(next, initial);
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

    const prevStateSig = stateSignature(bead);
    if (op.op === 'update') {
      const opActor = resolveOpActor(op.actor, actor, lockActor);
      if (op.title !== undefined) bead.title = assertNonEmptyString(op.title, 'title', LIMITS.title);
      if (op.summary !== undefined) bead.summary = assertOptionalString(op.summary, 'summary', LIMITS.summary) ?? '';
      if (op.kind !== undefined) bead.kind = op.kind;
      if (op.status !== undefined) {
        if (op.status === 'closed' || op.status === 'in_progress') {
          throw new BeadsValidationError(`Use explicit "${op.status === 'closed' ? 'close' : 'claim'}" operation instead of generic update status`);
        }
        if (bead.status === 'closed') {
          throw new BeadsValidationError(`Use explicit "reopen" operation before updating closed bead ${bead.id}`);
        }
        if (hasActiveLease(bead, opNowMs) && bead.lease.owner !== opActor) {
          throw new BeadsConflictError(`Cannot change status of ${bead.id}: actively claimed by ${bead.lease.owner}`);
        }
        bead.status = op.status;
        if (op.status === 'blocked' || op.status === 'open') {
          recordReleasedLease(bead);
          bead.lease = null;
        }
      }
      if (op.priority !== undefined) {
        if (!Number.isSafeInteger(op.priority) || op.priority < 0 || op.priority > 3) {
          throw new BeadsValidationError('priority must be an integer 0..3');
        }
        bead.priority = op.priority;
      }
      if (op.scope !== undefined) {
        bead.scope = normalizeScope(op.scope);
        if (singleAppOnly && !isSingleAppScope(bead)) {
          throw new BeadsValidationError(`Updated scope for ${bead.id} must target a single app`);
        }
      }
      if (op.links !== undefined) bead.links = mergeLinks(bead.links, op.links);
      if (op.note !== undefined) {
        const updateNote = assertOptionalString(op.note, 'note', LIMITS.note);
        if (updateNote) appendJournal(bead, opActor, updateNote, opNowIso);
      }
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
      if (typeof op.blockedBy !== 'string' || !BEAD_ID_PATTERN.test(op.blockedBy)) {
        throw new BeadsValidationError(`Invalid dependency bead id: ${op.blockedBy}`);
      }
      bead.deps.blockedBy = bead.deps.blockedBy.filter((id) => id !== op.blockedBy);
    } else if (op.op === 'claim') {
      const owner = resolveOpActor(op.owner, actor, lockActor);
      if (bead.status === 'closed') {
        throw new BeadsConflictError(`Cannot claim closed bead ${bead.id}`);
      }
      if (hasActiveLease(bead, opNowMs) && bead.lease.owner !== owner) {
        throw new BeadsConflictError(`Bead ${bead.id} is actively claimed by ${bead.lease.owner} until ${bead.lease.expiresAt}`);
      }
      const ttlHours = op.ttlHours === undefined ? 24 : op.ttlHours;
      if (typeof ttlHours !== 'number' || !Number.isFinite(ttlHours) || ttlHours <= 0 || ttlHours > 168) {
        throw new BeadsValidationError('ttlHours must be between 0 and 168');
      }
      const lastReleasedIso = bead.releasedLeases?.length ? tombstoneClaimedAt(bead.releasedLeases.at(-1)) : null;
      const minClaimMs = Math.max(
        opNowMs,
        bead.reopenedAt ? Date.parse(bead.reopenedAt) + 1 : -Infinity,
        bead.lease ? Date.parse(bead.lease.claimedAt) + 1 : -Infinity,
        lastReleasedIso ? Date.parse(lastReleasedIso) + 1 : -Infinity,
        bead.leaseFloorAt ? Date.parse(bead.leaseFloorAt) + 1 : -Infinity,
      );
      const claimedAt = new Date(minClaimMs).toISOString();
      const expiresAt = new Date(minClaimMs + ttlHours * 3600 * 1000).toISOString();
      const cleanBranch = assertOptionalString(op.branch, 'branch', LIMITS.branch);
      const claimNote = op.note === undefined ? `Claimed until ${expiresAt}` : assertNonEmptyString(op.note, 'note', LIMITS.note);
      recordReleasedLease(bead);
      bead.lease = normalizeLease({ owner, branch: cleanBranch, claimedAt, expiresAt });
      bead.status = 'in_progress';
      if (cleanBranch) bead.links = mergeLinks(bead.links, { branch: cleanBranch });
      appendJournal(bead, owner, claimNote, opNowIso);
    } else if (op.op === 'release') {
      const owner = resolveOpActor(op.owner, actor, lockActor);
      if (op.force !== undefined && typeof op.force !== 'boolean') {
        throw new BeadsValidationError('release.force must be a boolean');
      }
      const force = op.force ?? false;
      if (force && lockActor) {
        throw new BeadsValidationError('Force release is not permitted in safe mode');
      }
      if (hasActiveLease(bead, opNowMs) && bead.lease.owner !== owner && !force) {
        throw new BeadsConflictError(`Cannot release ${bead.id}: actively claimed by ${bead.lease.owner}`);
      }
      const releaseNote = op.note === undefined ? 'Released claim' : assertNonEmptyString(op.note, 'note', LIMITS.note);
      if (bead.lease !== null || bead.status === 'in_progress') {
        recordReleasedLease(bead);
        bead.lease = null;
        if (bead.status === 'in_progress') bead.status = 'open';
      }
      appendJournal(bead, owner, releaseNote, opNowIso);
    } else if (op.op === 'note') {
      const opActor = resolveOpActor(op.actor, actor, lockActor);
      appendJournal(bead, opActor, op.note, opNowIso);
    } else if (op.op === 'close') {
      const opActor = resolveOpActor(op.actor, actor, lockActor);
      if (lockActor && hasActiveLease(bead, opNowMs) && bead.lease.owner !== opActor) {
        throw new BeadsConflictError(`Cannot close ${bead.id} in safe mode: actively claimed by ${bead.lease.owner}`);
      }
      const rawReason = op.reason !== undefined ? op.reason : op.closeReason;
      const reason = assertNonEmptyString(rawReason, 'reason', LIMITS.closeReason);
      if (op.reason !== undefined && op.closeReason !== undefined) {
        assertNonEmptyString(op.closeReason, 'closeReason', LIMITS.closeReason);
      }
      const minCloseMs = Math.max(opNowMs, bead.reopenedAt ? Date.parse(bead.reopenedAt) + 1 : -Infinity);
      recordReleasedLease(bead);
      bead.status = 'closed';
      bead.lease = null;
      bead.closedAt = new Date(minCloseMs).toISOString();
      bead.closeReason = reason;
      if (op.pr !== undefined) bead.links = mergeLinks(bead.links, { pr: op.pr });
      const journalNote = `Closed: ${reason}`.slice(0, LIMITS.note);
      appendJournal(bead, opActor, journalNote, opNowIso);
    } else if (op.op === 'reopen') {
      const opActor = resolveOpActor(op.actor, actor, lockActor);
      if (bead.status !== 'closed') {
        throw new BeadsConflictError(`Cannot reopen non-closed bead ${bead.id} (status: ${bead.status})`);
      }
      const reopenNote = op.note === undefined ? 'Reopened' : assertNonEmptyString(op.note, 'note', LIMITS.note);
      const minReopenMs = Math.max(opNowMs, bead.closedAt ? Date.parse(bead.closedAt) + 1 : -Infinity);
      bead.status = 'open';
      bead.lease = null;
      bead.closedAt = null;
      bead.closeReason = null;
      bead.reopenedAt = new Date(minReopenMs).toISOString();
      appendJournal(bead, opActor, reopenNote, opNowIso);
    }

    bead.updatedAt = opNowIso;
    bead.revision = nextRevision(bead.revision);
    const validated = validateBead(bead);
    if (stateSignature(validated) !== prevStateSig) {
      validated.stateRevision = nextRevision(validated.stateRevision);
      validated.stateUpdatedAt = opNowIso;
    }
    next.set(validated.id, validated);
    changedIds.add(validated.id);
    updatedIds.push(validated.id);
  }

  validateBeadsGraph(next);
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

function reopenedAfterClose(openBead, closedBead) {
  return Boolean(openBead.reopenedAt && closedBead.closedAt && openBead.reopenedAt > closedBead.closedAt);
}

function stateSignature(bead) {
  return JSON.stringify({
    title: bead.title,
    summary: bead.summary,
    kind: bead.kind,
    status: bead.status,
    priority: bead.priority,
    scope: bead.scope,
    dedupeKey: bead.dedupeKey,
    deps: bead.deps,
    links: {
      githubIssue: bead.links?.githubIssue ?? null,
      pr: bead.links?.pr ?? null,
      branch: bead.links?.branch ?? null,
    },
    lease: bead.lease,
    closedAt: bead.closedAt,
    reopenedAt: bead.reopenedAt,
    closeReason: bead.closeReason,
  });
}

function pickHigherState(local, remote) {
  const localStateRev = local.stateRevision ?? local.revision;
  const remoteStateRev = remote.stateRevision ?? remote.revision;
  if (localStateRev !== remoteStateRev) {
    const localWins = localStateRev > remoteStateRev;
    return [structuredClone(localWins ? local : remote), localWins ? remote : local];
  }
  const localStateAt = local.stateUpdatedAt ?? local.updatedAt;
  const remoteStateAt = remote.stateUpdatedAt ?? remote.updatedAt;
  if (localStateAt !== remoteStateAt) {
    const localWins = localStateAt > remoteStateAt;
    return [structuredClone(localWins ? local : remote), localWins ? remote : local];
  }
  const localFirst = deterministicHash(stateSignature(local)) >= deterministicHash(stateSignature(remote));
  return [structuredClone(localFirst ? local : remote), localFirst ? remote : local];
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
    if ((local.dedupeKey ?? null) !== (remote.dedupeKey ?? null)) {
      throw new BeadsConflictError(
        `Merge collision on ${id}: mismatched dedupeKeys (${JSON.stringify(local.dedupeKey ?? null)} vs ${JSON.stringify(remote.dedupeKey ?? null)})`,
      );
    }
    if (JSON.stringify(local) === JSON.stringify(remote)) {
      merged.set(id, structuredClone(local));
      continue;
    }

    // Closed status wins over concurrent non-reopen mutations (e.g. notes),
    // while an explicit reopen with reopenedAt > closedAt wins cleanly.
    // When both sides are closed, preserve the newest close event first so
    // note revisions on an older close cannot roll back closedAt.
    // Non-journal state comparisons use (stateRevision, stateUpdatedAt) so
    // pure audit notes never outrank scheduling/dependency transitions.
    let winner;
    let other;
    if (local.status === 'closed' && remote.status === 'closed') {
      if (local.closedAt !== remote.closedAt) {
        const localNewer = local.closedAt > remote.closedAt;
        winner = structuredClone(localNewer ? local : remote);
        other = localNewer ? remote : local;
      } else {
        [winner, other] = pickHigherState(local, remote);
      }
    } else if (local.status === 'closed' && remote.status !== 'closed') {
      const remoteReopened = reopenedAfterClose(remote, local);
      winner = structuredClone(remoteReopened ? remote : local);
      other = remoteReopened ? local : remote;
    } else if (remote.status === 'closed' && local.status !== 'closed') {
      const localReopened = reopenedAfterClose(local, remote);
      winner = structuredClone(localReopened ? local : remote);
      other = localReopened ? remote : local;
    } else {
      [winner, other] = pickHigherState(local, remote);
    }

    const initialLeaseFloorAt = [local.leaseFloorAt, remote.leaseFloorAt]
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;
    const preTrimmed = trimReleasedLeases([
      ...(local.releasedLeases ?? []),
      ...(remote.releasedLeases ?? []),
    ], initialLeaseFloorAt);
    const combinedReleased = [...preTrimmed.releasedLeases];
    let effectiveLeaseFloorAt = preTrimmed.leaseFloorAt;
    const releasedSet = new Set(combinedReleased);
    const maxReopenedAt = [local.reopenedAt, remote.reopenedAt]
      .filter(Boolean)
      .sort()
      .at(-1) ?? null;

    if (winner.status === 'closed') {
      if (other.lease) combinedReleased.push(leaseKey(other.lease));
    } else {
      const isSuperseded = (lease) => {
        const key = leaseKey(lease);
        const body = key.slice(3);
        const legacyOwnerKey = `${lease.claimedAt}|${lease.owner}`;
        return releasedSet.has(key)
          || releasedSet.has(`v2+:${body}`)
          || releasedSet.has(body)
          || releasedSet.has(legacyOwnerKey)
          || releasedSet.has(`v2+:${legacyOwnerKey}`)
          || Boolean(effectiveLeaseFloorAt && lease.claimedAt <= effectiveLeaseFloorAt)
          || Boolean(maxReopenedAt && lease.claimedAt < maxReopenedAt);
      };
      const survivingByKey = new Map();
      for (const lease of [local.lease, remote.lease]) {
        if (!lease || isSuperseded(lease)) continue;
        const key = leaseKey(lease);
        if (!survivingByKey.has(key)) survivingByKey.set(key, lease);
      }
      const survivingLeases = [...survivingByKey.values()];
      if (survivingLeases.length === 0) {
        if (winner.lease !== null && winner.status === 'in_progress') {
          winner.status = other.status === 'blocked' ? 'blocked' : 'open';
        }
        winner.lease = null;
      } else if (survivingLeases.length === 1) {
        winner.lease = structuredClone(survivingLeases[0]);
        winner.status = 'in_progress';
      } else {
        survivingLeases.sort((a, b) =>
          b.claimedAt.localeCompare(a.claimedAt)
          || b.expiresAt.localeCompare(a.expiresAt)
          || deterministicHash(b).localeCompare(deterministicHash(a)),
        );
        winner.lease = structuredClone(survivingLeases[0]);
        winner.status = 'in_progress';
        for (const loser of survivingLeases.slice(1)) {
          combinedReleased.push(leaseKey(loser));
        }
      }
    }

    const trimmedLeases = trimReleasedLeases(combinedReleased, effectiveLeaseFloorAt);
    winner.releasedLeases = trimmedLeases.releasedLeases;
    winner.leaseFloorAt = trimmedLeases.leaseFloorAt;
    if (winner.lease && winner.leaseFloorAt && winner.lease.claimedAt <= winner.leaseFloorAt) {
      winner.lease = null;
      if (winner.status === 'in_progress') {
        winner.status = other.status === 'blocked' ? 'blocked' : 'open';
      }
    }
    winner.reopenedAt = maxReopenedAt;
    winner.journal = mergeJournalEntries(winner.journal, other.journal);
    winner.links = mergeLinks(winner.links, { evidence: other.links.evidence ?? [] }, { capEvidence: true });
    if (other.lastSeenAt > winner.lastSeenAt) winner.lastSeenAt = other.lastSeenAt;
    if (other.updatedAt > winner.updatedAt) winner.updatedAt = other.updatedAt;
    const localStateRev = local.stateRevision ?? local.revision;
    const remoteStateRev = remote.stateRevision ?? remote.revision;
    const maxStateRev = Math.max(localStateRev, remoteStateRev);
    winner.stateRevision = localStateRev === remoteStateRev && stateSignature(local) !== stateSignature(remote)
      ? nextRevision(maxStateRev)
      : maxStateRev;
    // Any divergent merge issues a strictly newer safe revision so neither pre-merge
    // expectedRevision token can silently overwrite the merged winner.
    winner.revision = nextRevision(Math.max(local.revision, remote.revision));
    merged.set(id, validateBead(winner));
  }
  validateBeadsGraph(merged);
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

function resolveGitRoot(cwd) {
  return git(['rev-parse', '--show-toplevel'], { cwd }).trim();
}

function assertNotSymbolicRef(repoTop, ref) {
  let isSymbolic = false;
  try {
    git(['symbolic-ref', '--quiet', ref], { cwd: repoTop });
    isSymbolic = true;
  } catch (error) {
    if (error.status !== 1) throw error;
  }
  if (isSymbolic) {
    throw new BeadsValidationError(`Ref must not be a symbolic ref: ${ref}`);
  }
}

function assertRefNotCheckedOut(repoTop, ref) {
  const output = git(['worktree', 'list', '--porcelain'], { cwd: repoTop });
  let currentWorktree = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) {
      currentWorktree = line.slice('worktree '.length);
    } else if (line === `branch ${ref}`) {
      throw new BeadsConflictError(
        `Ref ${ref} is checked out in worktree ${currentWorktree ?? '(unknown)'}; detach or switch branches before writing via beads plumbing`,
      );
    } else if (line === '') {
      currentWorktree = null;
    }
  }
}

function gitRefSha(repoTop, ref) {
  try {
    return git(['rev-parse', '--verify', '--quiet', ref], { cwd: repoTop }).trim() || null;
  } catch {
    return null;
  }
}

function isAncestor(repoTop, ancestorSha, descendantSha) {
  try {
    git(['merge-base', '--is-ancestor', ancestorSha, descendantSha], { cwd: repoTop });
    return true;
  } catch (error) {
    if (error.status === 1) return false;
    throw error;
  }
}

function assertConfiguredRemote(repoTop, remote) {
  if (typeof remote !== 'string' || !REMOTE_NAME_PATTERN.test(remote)) {
    throw new BeadsValidationError(`Invalid git remote name: ${remote}`);
  }
  const remotes = git(['remote'], { cwd: repoTop }).split('\n').map((r) => r.trim()).filter(Boolean);
  if (!remotes.includes(remote)) {
    throw new BeadsValidationError(`Unconfigured git remote: ${remote}`);
  }
  return remote;
}

function hashBlob(repoTop, content) {
  return git(['hash-object', '-w', '--stdin'], { cwd: repoTop, input: content }).trim();
}

function buildTreeFromMap(repoTop, beadsMap) {
  validateBeadsGraph(beadsMap);
  const schemaContent = `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, format: 'neurodesk-beads' }, null, 2)}\n`;
  const schemaBlob = hashBlob(repoTop, schemaContent);
  const beadEntries = [];
  for (const id of [...beadsMap.keys()].sort()) {
    const json = `${JSON.stringify(beadsMap.get(id), null, 2)}\n`;
    const blob = hashBlob(repoTop, json);
    beadEntries.push(`100644 blob ${blob}\t${id}.json`);
  }
  const rootEntries = [`100644 blob ${schemaBlob}\tschema.json`];
  if (beadEntries.length > 0) {
    const beadsTree = git(['mktree'], { cwd: repoTop, input: `${beadEntries.join('\n')}\n` }).trim();
    rootEntries.push(`040000 tree ${beadsTree}\tbeads`);
  }
  return git(['mktree'], { cwd: repoTop, input: `${rootEntries.join('\n')}\n` }).trim();
}

function parseLsTreeRecord(record) {
  const tabIndex = record.indexOf('\t');
  if (tabIndex === -1) {
    throw new BeadsValidationError(`Malformed ls-tree record: ${record}`);
  }
  const meta = record.slice(0, tabIndex);
  const filePath = record.slice(tabIndex + 1);
  const [mode, type, oid] = meta.split(' ');
  return { mode, type, oid, filePath };
}

function readBeadsTree(repoTop, ref) {
  assertNotSymbolicRef(repoTop, ref);
  const sha = gitRefSha(repoTop, ref);
  if (!sha) return { sha: null, beads: new Map() };

  const rootRecords = git(['ls-tree', '-z', sha], { cwd: repoTop }).split('\0').filter(Boolean);
  let schemaBlob = null;
  let hasBeadsDir = false;
  for (const record of rootRecords) {
    const { mode, type, oid, filePath } = parseLsTreeRecord(record);
    if (filePath === 'schema.json') {
      if (mode !== '100644' || type !== 'blob') {
        throw new BeadsValidationError(`Ref ${ref} schema.json must be a regular file blob`);
      }
      schemaBlob = oid;
    } else if (filePath === 'beads') {
      if (mode !== '040000' || type !== 'tree') {
        throw new BeadsValidationError(`Ref ${ref} beads entry must be a tree`);
      }
      hasBeadsDir = true;
    } else {
      throw new BeadsValidationError(`Unexpected root entry in ${ref}: ${filePath}`);
    }
  }
  if (!schemaBlob) {
    throw new BeadsValidationError(`Ref ${ref} is missing schema.json`);
  }
  const schema = JSON.parse(git(['cat-file', '-p', schemaBlob], { cwd: repoTop }));
  if (schema.schemaVersion !== SCHEMA_VERSION || schema.format !== 'neurodesk-beads') {
    throw new BeadsValidationError(`Ref ${ref} has unsupported schema metadata`);
  }

  const beads = new Map();
  if (!hasBeadsDir) return { sha, beads };

  const listing = git(['ls-tree', '-r', '-t', '-z', sha, '--', 'beads'], { cwd: repoTop });
  for (const record of listing.split('\0')) {
    if (!record) continue;
    const { mode, type, oid, filePath } = parseLsTreeRecord(record);
    if (filePath === 'beads' && mode === '040000' && type === 'tree') continue;
    if (mode !== '100644' || type !== 'blob' || !filePath.endsWith('.json')) {
      throw new BeadsValidationError(`Unexpected entry in beads tree: ${filePath}`);
    }
    const raw = git(['cat-file', '-p', oid], { cwd: repoTop });
    const bead = validateBead(JSON.parse(raw));
    const expectedPath = `beads/${bead.id}.json`;
    if (filePath !== expectedPath) {
      throw new BeadsValidationError(`Bead file path mismatch: ${filePath} contains id ${bead.id}`);
    }
    if (beads.has(bead.id)) {
      throw new BeadsConflictError(`Duplicate bead id in store: ${bead.id}`);
    }
    beads.set(bead.id, bead);
  }
  validateBeadsGraph(beads);
  return { sha, beads };
}

export function readBeadsFromRef(cwd, ref = DEFAULT_BEADS_REF) {
  assertMemoryRef(ref);
  const repoTop = resolveGitRoot(cwd);
  return readBeadsTree(repoTop, ref);
}

function commitTree(repoTop, treeSha, parents, message, authorName, authorEmail) {
  const args = ['commit-tree', treeSha, '-m', message];
  for (const parent of parents) {
    args.push('-p', parent);
  }
  return execFileSync('git', args, {
    cwd: repoTop,
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
}

function updateMemoryRefCas(repoTop, ref, newSha, oldSha) {
  assertNotSymbolicRef(repoTop, ref);
  assertRefNotCheckedOut(repoTop, ref);
  git(['update-ref', '--no-deref', ref, newSha, oldSha], { cwd: repoTop });
}

export function commitBeadsToRef(cwd, beadsMap, { ref = DEFAULT_BEADS_REF, expectedParentSha = null, message = 'beads: update work graph', authorName = 'neurodesk-beads', authorEmail = 'beads@neurodesk.local' } = {}) {
  assertMemoryRef(ref);
  const repoTop = resolveGitRoot(cwd);
  assertNotSymbolicRef(repoTop, ref);
  assertRefNotCheckedOut(repoTop, ref);
  const treeSha = buildTreeFromMap(repoTop, beadsMap);
  const parents = expectedParentSha ? [expectedParentSha] : [];
  const commitSha = commitTree(repoTop, treeSha, parents, message, authorName, authorEmail);
  const oldArg = expectedParentSha ?? ZERO_OID;
  try {
    updateMemoryRefCas(repoTop, ref, commitSha, oldArg);
  } catch (error) {
    if (error instanceof BeadsConflictError || error instanceof BeadsValidationError) throw error;
    throw new BeadsConflictError(`Concurrent update detected on ${ref}: ${error.message}`);
  }
  return commitSha;
}

export function mutateBeadsRef(cwd, operations, { ref = DEFAULT_BEADS_REF, message = 'beads: apply operations', maxRetries = 5, ...applyOptions } = {}) {
  assertMemoryRef(ref);
  const repoTop = resolveGitRoot(cwd);
  assertNotSymbolicRef(repoTop, ref);
  assertRefNotCheckedOut(repoTop, ref);
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { sha, beads } = readBeadsTree(repoTop, ref);
    const result = applyOperations(beads, operations, applyOptions);
    if (result.changedIds.length === 0 && sha !== null) {
      return { ...result, commitSha: sha, changed: false };
    }
    try {
      const commitSha = commitBeadsToRef(repoTop, result.beads, { ref, expectedParentSha: sha, message });
      return { ...result, commitSha, changed: true };
    } catch (error) {
      if (error instanceof BeadsConflictError && attempt + 1 < maxRetries) continue;
      throw error;
    }
  }
  throw new BeadsConflictError(`Failed to update ${ref} after ${maxRetries} attempts`);
}

export function initBeadsRef(cwd, { ref = DEFAULT_BEADS_REF } = {}) {
  assertMemoryRef(ref);
  const repoTop = resolveGitRoot(cwd);
  assertNotSymbolicRef(repoTop, ref);
  assertRefNotCheckedOut(repoTop, ref);
  const existing = gitRefSha(repoTop, ref);
  if (existing) return { sha: existing, created: false };
  try {
    const sha = commitBeadsToRef(repoTop, new Map(), {
      ref,
      expectedParentSha: null,
      message: 'beads: initialize orphan memory branch',
    });
    return { sha, created: true };
  } catch (error) {
    if (error instanceof BeadsConflictError) {
      const raced = gitRefSha(repoTop, ref);
      if (raced) return { sha: raced, created: false };
    }
    throw error;
  }
}

function remoteBranchSha(repoTop, remote, ref) {
  try {
    const out = git(['ls-remote', '--exit-code', '--refs', '--', remote, ref], { cwd: repoTop }).trim();
    if (!out) return null;
    for (const line of out.split(/\r?\n/)) {
      const [sha, name] = line.split('\t');
      if (name === ref && /^[0-9a-f]{40}$/i.test(sha || '')) return sha;
    }
    return null;
  } catch (error) {
    if (error.status === 2) return null;
    throw new Error(`Failed to query remote "${remote}" for ${ref}: ${error.stderr || error.message}`);
  }
}

function remoteBranchExists(repoTop, remote, ref) {
  return Boolean(remoteBranchSha(repoTop, remote, ref));
}

export function syncBeadsRef(cwd, { ref = DEFAULT_BEADS_REF, remote = 'origin', push = false, maxRetries = 5 } = {}) {
  assertMemoryRef(ref);
  const repoTop = resolveGitRoot(cwd);
  assertNotSymbolicRef(repoTop, ref);
  assertRefNotCheckedOut(repoTop, ref);
  assertConfiguredRemote(repoTop, remote);

  if (push) {
    const rawPushUrls = git(['remote', 'get-url', '--push', '--all', '--', remote], { cwd: repoTop });
    const pushUrls = rawPushUrls.length === 0 ? [] : rawPushUrls.replace(/\r?\n$/, '').split('\n');
    if (pushUrls.length !== 1) {
      throw new BeadsValidationError(`Remote "${remote}" has ${pushUrls.length} push URLs; beads sync requires a single push destination for atomic --force-with-lease`);
    }
  }

  const shortBranch = ref.replace(/^refs\/heads\//, '');
  const trackingRef = `refs/remotes/${remote}/${shortBranch}`;
  assertNotSymbolicRef(repoTop, trackingRef);
  const remoteExists = remoteBranchExists(repoTop, remote, ref);
  if (remoteExists) {
    git(['-c', `remote.${remote}.fetch=`, 'fetch', '--no-tags', '--no-prune', '--no-recurse-submodules', '--no-write-fetch-head', '--refmap=', '--', remote, `+${ref}:${trackingRef}`], { cwd: repoTop });
  }
  const remoteState = remoteExists ? readBeadsTree(repoTop, trackingRef) : { sha: null, beads: new Map() };

  let finalSha = null;
  let mergedCount = 0;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const localState = readBeadsTree(repoTop, ref);

    if (remoteState.sha && !localState.sha) {
      try {
        updateMemoryRefCas(repoTop, ref, remoteState.sha, ZERO_OID);
        finalSha = remoteState.sha;
        mergedCount = remoteState.beads.size;
        break;
      } catch (error) {
        if (error instanceof BeadsConflictError || error instanceof BeadsValidationError) throw error;
        if (attempt + 1 < maxRetries) continue;
        throw new BeadsConflictError(`Concurrent initialization conflict on ${ref}`);
      }
    } else if (remoteState.sha && localState.sha) {
      if (localState.sha === remoteState.sha) {
        finalSha = localState.sha;
        mergedCount = localState.beads.size;
        break;
      }
      if (isAncestor(repoTop, localState.sha, remoteState.sha)) {
        try {
          updateMemoryRefCas(repoTop, ref, remoteState.sha, localState.sha);
          finalSha = remoteState.sha;
          mergedCount = remoteState.beads.size;
          break;
        } catch (error) {
          if (error instanceof BeadsConflictError || error instanceof BeadsValidationError) throw error;
          if (attempt + 1 < maxRetries) continue;
          throw new BeadsConflictError(`Concurrent fast-forward conflict on ${ref}`);
        }
      }
      if (isAncestor(repoTop, remoteState.sha, localState.sha)) {
        finalSha = localState.sha;
        mergedCount = localState.beads.size;
        break;
      }
      const merged = mergeBeadsMaps(localState.beads, remoteState.beads);
      const treeSha = buildTreeFromMap(repoTop, merged);
      const commitSha = commitTree(
        repoTop,
        treeSha,
        [localState.sha, remoteState.sha],
        `beads: sync with ${remote}/${shortBranch}`,
        'neurodesk-beads',
        'beads@neurodesk.local',
      );
      try {
        updateMemoryRefCas(repoTop, ref, commitSha, localState.sha);
        finalSha = commitSha;
        mergedCount = merged.size;
        break;
      } catch (error) {
        if (error instanceof BeadsConflictError || error instanceof BeadsValidationError) throw error;
        if (attempt + 1 < maxRetries) continue;
        throw new BeadsConflictError(`Concurrent merge conflict on ${ref}`);
      }
    } else if (!localState.sha && !remoteState.sha) {
      const initialized = initBeadsRef(repoTop, { ref });
      finalSha = initialized.sha;
      mergedCount = readBeadsTree(repoTop, ref).beads.size;
      break;
    } else {
      finalSha = localState.sha;
      mergedCount = localState.beads.size;
      break;
    }
  }

  let pushed = false;
  if (push && finalSha) {
    const leaseArg = remoteState.sha ? `--force-with-lease=${ref}:${remoteState.sha}` : `--force-with-lease=${ref}:`;
    git(['-c', `remote.${remote}.fetch=`, '-c', `remote.${remote}.mirror=false`, 'push', '--no-follow-tags', '--recurse-submodules=no', leaseArg, '--', remote, `${finalSha}:${ref}`], { cwd: repoTop });
    git(['update-ref', '--no-deref', trackingRef, finalSha], { cwd: repoTop });
    pushed = true;
  }

  return { ref, remote, remoteFetched: remoteExists, sha: finalSha, count: mergedCount, pushed };
}

function isLeasePushRejection(error) {
  const detail = `${error?.stderr || ''}\n${error?.message || ''}`;
  return /stale info|non-fast-forward|fetch first|\[rejected\]|failed to update ref|remote ref updated|cannot lock ref|expected [0-9a-f]{7,40}/i.test(detail);
}

function fetchRemoteBeadsTreeNoRef(repoTop, remote, ref, maxFetchAttempts = 3) {
  for (let i = 0; i < maxFetchAttempts; i++) {
    const remoteSha = remoteBranchSha(repoTop, remote, ref);
    if (!remoteSha) return { sha: null, beads: new Map() };
    git([
      '-c', `remote.${remote}.fetch=`,
      'fetch',
      '--no-tags',
      '--no-prune',
      '--no-recurse-submodules',
      '--no-write-fetch-head',
      '--refmap=',
      '--',
      remote,
      ref,
    ], { cwd: repoTop });
    if (gitRefSha(repoTop, remoteSha) === remoteSha) {
      return readBeadsTree(repoTop, remoteSha);
    }
  }
  throw new BeadsConflictError(`Remote ${remote} ${ref} moved concurrently during fetch`);
}

export function filterClosedUpsertOperations(beadsMap, operations) {
  const closedByKey = new Map();
  for (const bead of beadsMap.values()) {
    if (bead.status === 'closed' && bead.dedupeKey) {
      closedByKey.set(bead.dedupeKey, bead.id);
    }
  }
  const activeOperations = [];
  const skippedClosed = [];
  for (const op of operations) {
    if (op?.op === 'upsert' && typeof op.dedupeKey === 'string' && closedByKey.has(op.dedupeKey)) {
      const beadId = closedByKey.get(op.dedupeKey);
      skippedClosed.push({
        dedupeKey: op.dedupeKey,
        beadId,
        reason: `bead ${beadId} is already closed; skipping to respect maintainer disposition`,
      });
      continue;
    }
    activeOperations.push(op);
  }
  return { activeOperations, skippedClosed };
}

export function applyRemoteBeadsRef(cwd, operations, {
  ref = DEFAULT_BEADS_REF,
  remote = 'origin',
  message = 'beads: update',
  dryRun = false,
  skipClosedUpserts = false,
  maxRetries = 5,
  beforePush = null,
  ...applyOpts
} = {}) {
  assertMemoryRef(ref);
  const repoTop = resolveGitRoot(cwd);
  assertNotSymbolicRef(repoTop, ref);
  assertRefNotCheckedOut(repoTop, ref);
  assertConfiguredRemote(repoTop, remote);

  if (!dryRun) {
    const rawPushUrls = git(['remote', 'get-url', '--push', '--all', '--', remote], { cwd: repoTop });
    const pushUrls = rawPushUrls.length === 0 ? [] : rawPushUrls.replace(/\r?\n$/, '').split('\n');
    if (pushUrls.length !== 1) {
      throw new BeadsValidationError(`Remote "${remote}" has ${pushUrls.length} push URLs; beads remote apply requires a single push destination for atomic --force-with-lease`);
    }
  }

  const shortBranch = ref.replace(/^refs\/heads\//, '');
  const trackingRef = `refs/remotes/${remote}/${shortBranch}`;
  assertNotSymbolicRef(repoTop, trackingRef);

  const attempts = dryRun ? 1 : Math.max(1, maxRetries);
  for (let attempt = 0; attempt < attempts; attempt++) {
    const remoteState = fetchRemoteBeadsTreeNoRef(repoTop, remote, ref);

    let effectiveOps = operations;
    let skippedClosed = [];
    if (skipClosedUpserts) {
      const filtered = filterClosedUpsertOperations(remoteState.beads, operations);
      effectiveOps = filtered.activeOperations;
      skippedClosed = filtered.skippedClosed;
    }

    if (effectiveOps.length === 0) {
      return {
        ref,
        remote,
        dryRun: Boolean(dryRun),
        changed: false,
        pushed: false,
        commitSha: remoteState.sha,
        createdIds: [],
        updatedIds: [],
        untouchedIds: [],
        skippedClosed,
        count: remoteState.beads.size,
      };
    }

    const applied = applyOperations(remoteState.beads, effectiveOps, applyOpts);
    const changed = applied.changedIds.length > 0;
    if (dryRun || !changed) {
      return {
        ref,
        remote,
        dryRun: Boolean(dryRun),
        changed,
        pushed: false,
        commitSha: remoteState.sha,
        createdIds: applied.createdIds,
        updatedIds: applied.updatedIds,
        untouchedIds: applied.untouchedIds,
        skippedClosed,
        count: applied.beads.size,
      };
    }

    const treeSha = buildTreeFromMap(repoTop, applied.beads);
    const parents = remoteState.sha ? [remoteState.sha] : [];
    const commitSha = commitTree(repoTop, treeSha, parents, message);

    if (typeof beforePush === 'function') {
      beforePush({ attempt, expectedSha: remoteState.sha, commitSha });
    }

    const leaseArg = remoteState.sha ? `--force-with-lease=${ref}:${remoteState.sha}` : `--force-with-lease=${ref}:`;
    try {
      git(['-c', `remote.${remote}.fetch=`, '-c', `remote.${remote}.mirror=false`, 'push', '--no-follow-tags', '--recurse-submodules=no', leaseArg, '--', remote, `${commitSha}:${ref}`], { cwd: repoTop });
    } catch (error) {
      if (isLeasePushRejection(error)) {
        if (attempt + 1 < attempts) continue;
        throw new BeadsConflictError(`Concurrent remote update conflict on ${remote}/${shortBranch} after ${attempts} attempt(s)`);
      }
      throw error;
    }

    // Remote push succeeded; local tracking/mirror ref updates are strictly best-effort so a local
    // ref lock error never turns a published push into a reported failure.
    try {
      git(['update-ref', '--no-deref', trackingRef, commitSha], { cwd: repoTop });
    } catch {
      // Best-effort tracking ref mirror update.
    }
    const localSha = gitRefSha(repoTop, ref);
    if (!localSha) {
      try {
        updateMemoryRefCas(repoTop, ref, commitSha, ZERO_OID);
      } catch {
        // Best-effort local mirror update; remote push already succeeded.
      }
    } else if (localSha === remoteState.sha || isAncestor(repoTop, localSha, commitSha)) {
      try {
        updateMemoryRefCas(repoTop, ref, commitSha, localSha);
      } catch {
        // Best-effort local mirror update; remote push already succeeded.
      }
    }

    return {
      ref,
      remote,
      dryRun: false,
      changed: true,
      pushed: true,
      commitSha,
      createdIds: applied.createdIds,
      updatedIds: applied.updatedIds,
      untouchedIds: applied.untouchedIds,
      skippedClosed,
      count: applied.beads.size,
    };
  }

  throw new BeadsConflictError(`Failed to apply remote update on ${remote}/${shortBranch}`);
}
