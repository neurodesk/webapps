import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import {
  BEAD_ID_PATTERN,
  DEFAULT_BEADS_REF,
  LIMITS,
  applyOperations,
  applyRemoteBeadsRef,
  hasActiveLease,
  isBlockedByDeps,
  readBeadsFromRef,
  syncBeadsRef,
} from './beads.mjs';
import { assertCleanThreatDetection } from './beads-safe-outputs.mjs';

export const BEADS_PR_BRANCH_PREFIX = 'beads/';
export const DEFAULT_WORKER_ACTOR = 'gh-aw/beads-pr-worker';
export const DEFAULT_MAX_OPEN_WORKER_PRS = 2;
export const DEFAULT_RECENT_CLOSED_DAYS = 30;
export const RECORD_BEAD_PR_ITEM_TYPE = 'record_bead_pr';

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const WORKER_BRANCH_PATTERN = /^beads\/(bd-[0-9a-f]{8})-([a-z][a-z0-9-]*)(?:-[a-z0-9-]+)?$/;

function isStrictlyContained(parentReal, childReal) {
  const rel = relative(parentReal, childReal);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

export function assertTrustedAppDir(cwd, app) {
  if (typeof app !== 'string' || !APP_ID_PATTERN.test(app)) {
    throw new Error(`Invalid app id "${app}"`);
  }
  const appsDir = resolve(cwd, 'apps');
  if (!existsSync(appsDir)) {
    throw new Error('apps directory does not exist');
  }
  const appsStat = lstatSync(appsDir);
  if (appsStat.isSymbolicLink() || !appsStat.isDirectory()) {
    throw new Error('apps directory must be a real directory');
  }
  const appDir = resolve(appsDir, app);
  if (!existsSync(appDir)) {
    throw new Error(`app directory apps/${app} does not exist`);
  }
  const appStat = lstatSync(appDir);
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw new Error(`app directory apps/${app} must be a real directory`);
  }
  const appsReal = realpathSync(appsDir);
  const appDirReal = realpathSync(appDir);
  if (!isStrictlyContained(appsReal, appDirReal)) {
    throw new Error(`app directory apps/${app} escapes apps/`);
  }
  return appDirReal;
}

export function buildWorkerBranchName(beadId, app) {
  if (typeof beadId !== 'string' || !BEAD_ID_PATTERN.test(beadId)) {
    throw new Error(`Invalid bead id "${beadId}"`);
  }
  if (typeof app !== 'string' || !APP_ID_PATTERN.test(app)) {
    throw new Error(`Invalid app id "${app}"`);
  }
  return `${BEADS_PR_BRANCH_PREFIX}${beadId}-${app}`;
}

export function extractBeadIdFromBranch(branchName) {
  if (typeof branchName !== 'string') return null;
  const match = branchName.match(WORKER_BRANCH_PATTERN);
  return match ? match[1] : null;
}

export function matchesWorkerBranchForBead(branchName, beadId, app) {
  if (typeof branchName !== 'string') return false;
  const expectedPrefix = buildWorkerBranchName(beadId, app);
  if (branchName === expectedPrefix) return true;
  if (!branchName.startsWith(`${expectedPrefix}-`)) return false;
  const suffix = branchName.slice(expectedPrefix.length + 1);
  return /^[a-z0-9-]+$/.test(suffix);
}

function normalizePullRequestRecord(pr) {
  const headRef = pr?.headRef ?? pr?.head?.ref ?? '';
  const baseRef = pr?.baseRef ?? pr?.base?.ref ?? '';
  const state = String(pr?.state ?? '').toLowerCase();
  const closedAt = pr?.closedAt ?? pr?.closed_at ?? null;
  const mergedAt = pr?.mergedAt ?? pr?.merged_at ?? null;
  const draft = Boolean(pr?.draft ?? pr?.isDraft ?? false);
  const userLogin = pr?.userLogin ?? pr?.user?.login ?? '';
  const number = Number(pr?.number);
  const url = pr?.url ?? pr?.html_url ?? '';
  return { headRef, baseRef, state, closedAt, mergedAt, draft, userLogin, number, url };
}

function summarizeExistingWorkerPrs(existingPullRequests = [], { nowMs, recentClosedDays }) {
  const openWorkerPrs = [];
  const openBeadIds = new Set();
  const recentlyClosedUnmergedBeadIds = new Set();
  const cutoffMs = nowMs - recentClosedDays * 24 * 60 * 60 * 1000;

  for (const rawPr of existingPullRequests) {
    const pr = normalizePullRequestRecord(rawPr);
    if (!pr.headRef.startsWith(BEADS_PR_BRANCH_PREFIX)) continue;
    const beadId = extractBeadIdFromBranch(pr.headRef);
    if (pr.state === 'open') {
      openWorkerPrs.push(pr);
      if (beadId) openBeadIds.add(beadId);
      continue;
    }
    if (pr.state === 'closed' && !pr.mergedAt && beadId) {
      const closedMs = pr.closedAt ? Date.parse(pr.closedAt) : NaN;
      if (Number.isFinite(closedMs) && closedMs >= cutoffMs) {
        recentlyClosedUnmergedBeadIds.add(beadId);
      }
    }
  }

  return { openWorkerPrs, openBeadIds, recentlyClosedUnmergedBeadIds };
}

function checkBeadEligibility(bead, { byId, allowedApps, openBeadIds, recentlyClosedUnmergedBeadIds, explicit, nowMs }) {
  if (bead.status !== 'open') {
    return `bead ${bead.id} has status "${bead.status}" (must be "open")`;
  }
  if (bead.kind !== 'maintenance') {
    return `bead ${bead.id} has kind "${bead.kind}" (only "maintenance" beads are eligible)`;
  }
  if (isBlockedByDeps(bead, byId)) {
    return `bead ${bead.id} is blocked by unresolved dependencies`;
  }
  if (hasActiveLease(bead, nowMs)) {
    return `bead ${bead.id} has an active claim lease owned by "${bead.lease.owner}"`;
  }
  if (bead.scope?.type !== 'app' || !Array.isArray(bead.scope.targets) || bead.scope.targets.length !== 1) {
    return `bead ${bead.id} is not single-app scoped`;
  }
  const app = bead.scope.targets[0];
  if (!APP_ID_PATTERN.test(app) || !allowedApps.has(app)) {
    return `app "${app}" is not a registered first-party non-upstream app`;
  }
  if (openBeadIds.has(bead.id)) {
    return `bead ${bead.id} already has an open worker PR`;
  }
  if (!explicit && recentlyClosedUnmergedBeadIds.has(bead.id)) {
    return `bead ${bead.id} had a recently closed unmerged worker PR`;
  }
  return null;
}

export function selectBeadForPullRequest({
  beads,
  allowedApps,
  existingPullRequests = [],
  beadId = '',
  maxOpenPrs = DEFAULT_MAX_OPEN_WORKER_PRS,
  recentClosedDays = DEFAULT_RECENT_CLOSED_DAYS,
  now = new Date(),
}) {
  const nowIso = now instanceof Date ? now.toISOString() : String(now);
  const nowMs = Date.parse(nowIso);
  const trimmedId = typeof beadId === 'string' ? beadId.trim() : '';
  const explicit = trimmedId.length > 0;
  const beadList = beads instanceof Map ? [...beads.values()] : [...beads];
  const byId = beads instanceof Map ? beads : new Map(beadList.map((bead) => [bead.id, bead]));

  const { openWorkerPrs, openBeadIds, recentlyClosedUnmergedBeadIds } = summarizeExistingWorkerPrs(existingPullRequests, {
    nowMs,
    recentClosedDays,
  });

  if (!explicit && openWorkerPrs.length >= maxOpenPrs) {
    return {
      selected: false,
      reason: `Open worker PR cap reached (${openWorkerPrs.length}/${maxOpenPrs})`,
      openWorkerPrCount: openWorkerPrs.length,
      maxOpenPrs,
      bead: null,
      app: null,
      branch: null,
    };
  }

  if (explicit) {
    if (!BEAD_ID_PATTERN.test(trimmedId)) {
      return {
        selected: false,
        reason: `Invalid bead_id "${trimmedId}" (expected bd-<8 hex chars>)`,
        openWorkerPrCount: openWorkerPrs.length,
        maxOpenPrs,
        bead: null,
        app: null,
        branch: null,
      };
    }
    const target = byId.get(trimmedId);
    if (!target) {
      return {
        selected: false,
        reason: `Bead ${trimmedId} was not found on memory/beads`,
        openWorkerPrCount: openWorkerPrs.length,
        maxOpenPrs,
        bead: null,
        app: null,
        branch: null,
      };
    }
    const rejection = checkBeadEligibility(target, {
      byId,
      allowedApps,
      openBeadIds,
      recentlyClosedUnmergedBeadIds,
      explicit: true,
      nowMs,
    });
    if (rejection) {
      return {
        selected: false,
        reason: rejection,
        openWorkerPrCount: openWorkerPrs.length,
        maxOpenPrs,
        bead: null,
        app: null,
        branch: null,
      };
    }
    const app = target.scope.targets[0];
    return {
      selected: true,
      reason: null,
      openWorkerPrCount: openWorkerPrs.length,
      maxOpenPrs,
      bead: target,
      app,
      branch: buildWorkerBranchName(target.id, app),
    };
  }

  const eligible = beadList
    .filter(
      (bead) =>
        checkBeadEligibility(bead, {
          byId,
          allowedApps,
          openBeadIds,
          recentlyClosedUnmergedBeadIds,
          explicit: false,
          nowMs,
        }) === null,
    )
    .sort((a, b) => a.priority - b.priority || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

  if (eligible.length === 0) {
    return {
      selected: false,
      reason: 'No eligible ready single-app maintenance beads found',
      openWorkerPrCount: openWorkerPrs.length,
      maxOpenPrs,
      bead: null,
      app: null,
      branch: null,
    };
  }

  const chosen = eligible[0];
  const app = chosen.scope.targets[0];
  return {
    selected: true,
    reason: null,
    openWorkerPrCount: openWorkerPrs.length,
    maxOpenPrs,
    bead: chosen,
    app,
    branch: buildWorkerBranchName(chosen.id, app),
  };
}

export function validateWorkerChangedFiles(files, { app, maxFiles = 20, allowLockfile = true } = {}) {
  if (typeof app !== 'string' || !APP_ID_PATTERN.test(app)) {
    return { valid: false, files: [], violations: [`Invalid target app id "${app}"`] };
  }
  if (!Array.isArray(files) || files.length === 0) {
    return { valid: false, files: [], violations: ['Diff is empty; at least one file under the target app must change'] };
  }

  const normalized = [];
  const violations = [];
  const seen = new Set();

  for (const rawFile of files) {
    if (typeof rawFile !== 'string') {
      violations.push('Non-string file path in diff');
      continue;
    }
    const file = rawFile.trim();
    if (!file || file.startsWith('/') || file.includes('\\') || file.includes('://')) {
      violations.push(`Invalid repo-relative path "${rawFile}"`);
      continue;
    }
    const segments = file.split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      violations.push(`Path traversal or empty segment in "${rawFile}"`);
      continue;
    }
    if (!seen.has(file)) {
      seen.add(file);
      normalized.push(file);
    }
  }

  if (normalized.length > maxFiles) {
    violations.push(`Too many changed files (${normalized.length} > ${maxFiles})`);
  }

  const appPrefix = `apps/${app}/`;
  const appPackageJson = `apps/${app}/package.json`;
  const hasAppPackageJson = normalized.includes(appPackageJson);
  let hasAppFile = false;

  for (const file of normalized) {
    if (file.startsWith(appPrefix)) {
      hasAppFile = true;
      continue;
    }
    if (allowLockfile && file === 'pnpm-lock.yaml') {
      if (!hasAppPackageJson) {
        violations.push(`pnpm-lock.yaml may only change alongside ${appPackageJson}`);
      }
      continue;
    }
    violations.push(`File "${file}" is outside allowed scope (${appPrefix}**${allowLockfile ? ' or pnpm-lock.yaml with package.json' : ''})`);
  }

  if (!hasAppFile) {
    violations.push(`Diff must modify at least one file under ${appPrefix}`);
  }

  return {
    valid: violations.length === 0,
    files: normalized,
    violations,
  };
}

export function parseRecordBeadPrItems(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Agent output JSON must be an object with an "items" array');
  }
  if (!Array.isArray(raw.items)) {
    throw new Error('Agent output JSON is missing an "items" array');
  }
  return raw.items.filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item) && item.type === RECORD_BEAD_PR_ITEM_TYPE,
  );
}

export function findMatchingDraftPr(
  pullRequests,
  { beadId, app, defaultBranch = 'main', expectedAuthor = 'github-actions[bot]' },
) {
  const matches = [];
  for (const rawPr of pullRequests ?? []) {
    const pr = normalizePullRequestRecord(rawPr);
    if (pr.state !== 'open') continue;
    if (!pr.draft) continue;
    if (pr.baseRef !== defaultBranch) continue;
    if (expectedAuthor && pr.userLogin !== expectedAuthor) continue;
    if (!matchesWorkerBranchForBead(pr.headRef, beadId, app)) continue;
    matches.push(pr);
  }
  matches.sort((a, b) => b.number - a.number);
  return matches[0] ?? null;
}

export function buildBeadPrUpdateOperation({ bead, prNumber, prUrl, branch, note = '' }) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  const cleanNote = typeof note === 'string' ? note.replace(/[\r\n]+/g, ' ').trim() : '';
  const prefix = `Draft PR #${prNumber} opened (${branch}): ${prUrl}`;
  const fullNote = cleanNote ? `${prefix} — ${cleanNote}` : prefix;
  const boundedNote = fullNote.length <= LIMITS.note ? fullNote : `${fullNote.slice(0, LIMITS.note - 1)}…`;
  return {
    op: 'update',
    id: bead.id,
    expectedRevision: bead.revision,
    links: { pr: prNumber },
    note: boundedNote,
  };
}

export function recordVerifiedBeadDraftPr({
  cwd,
  ref = DEFAULT_BEADS_REF,
  remote = 'origin',
  beadId,
  app,
  pr,
  prFiles,
  note = '',
  actor = DEFAULT_WORKER_ACTOR,
  dryRun = false,
  skipSync = false,
  detectionConclusion = null,
  detectionSuccess = null,
  requireCleanDetection = false,
  now = new Date(),
}) {
  if (requireCleanDetection) {
    assertCleanThreatDetection({ detectionConclusion, detectionSuccess });
  }
  const normalizedPr = normalizePullRequestRecord(pr);
  if (!normalizedPr.draft || normalizedPr.state !== 'open' || !Number.isSafeInteger(normalizedPr.number) || normalizedPr.number <= 0) {
    throw new Error('Refusing to record PR on memory/beads: verified open draft PR is required');
  }
  if (!matchesWorkerBranchForBead(normalizedPr.headRef, beadId, app)) {
    throw new Error(`Draft PR #${normalizedPr.number} branch "${normalizedPr.headRef}" does not match bead ${beadId} (${app})`);
  }
  const diffCheck = validateWorkerChangedFiles(prFiles, { app });
  if (!diffCheck.valid) {
    throw new Error(`Draft PR #${normalizedPr.number} violates single-app scope for ${app}: ${diffCheck.violations.join('; ')}`);
  }

  if (!skipSync) {
    syncBeadsRef(cwd, { ref, remote, push: false });
  }
  const { beads: localBeads } = readBeadsFromRef(cwd, ref);
  const bead = localBeads.get(beadId);
  if (!bead) {
    throw new Error(`Bead ${beadId} not found on ${ref}`);
  }
  if (bead.scope?.type !== 'app' || bead.scope.targets?.[0] !== app) {
    throw new Error(`Bead ${beadId} scope does not match app "${app}"`);
  }

  const operation = buildBeadPrUpdateOperation({
    bead,
    prNumber: normalizedPr.number,
    prUrl: normalizedPr.url,
    branch: normalizedPr.headRef,
    note,
  });

  const safeOpts = {
    actor,
    now,
    maxCreates: 0,
    maxUpdates: 1,
    requireExpectedRevision: true,
    singleAppOnly: true,
    lockActor: true,
  };

  if (skipSync) {
    const preview = applyOperations(localBeads, [operation], safeOpts);
    return {
      dryRun: Boolean(dryRun),
      pushed: false,
      beadId,
      app,
      prNumber: normalizedPr.number,
      prUrl: normalizedPr.url,
      branch: normalizedPr.headRef,
      files: diffCheck.files,
      note: operation.note,
      updatedIds: preview.updatedIds,
    };
  }

  const remoteResult = applyRemoteBeadsRef(cwd, [operation], {
    ref,
    remote,
    message: `beads: link draft PR #${normalizedPr.number} for ${beadId}`,
    dryRun: Boolean(dryRun),
    ...safeOpts,
  });

  return {
    dryRun: Boolean(dryRun),
    pushed: remoteResult.pushed,
    commitSha: remoteResult.commitSha,
    beadId,
    app,
    prNumber: normalizedPr.number,
    prUrl: normalizedPr.url,
    branch: normalizedPr.headRef,
    files: diffCheck.files,
    note: operation.note,
    updatedIds: remoteResult.updatedIds,
  };
}
