import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
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
export const DEFAULT_MAX_OPEN_PR_PAGES = 20;
export const DEFAULT_MAX_CLOSED_PR_PAGES = 20;
export const DEFAULT_MAX_PR_FILE_PAGES = 5;

export class WorkerPolicyViolationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'WorkerPolicyViolationError';
  }
}

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const WORKER_BRANCH_PATTERN = /^beads\/(bd-[0-9a-f]{8})-([a-z][a-z0-9-]*)(?:-[0-9a-f]{16})?$/;
const GH_AW_SALT_PATTERN = /^[0-9a-f]{16}$/;
const FORBIDDEN_AGENT_GUIDE_BASENAME = /^(?:AGENTS|AGENT|CLAUDE)\.md$/i;
const DEPENDENCY_SECTIONS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const SEMVER_CORE_PATTERN = /^v?\d+(?:\.(?:\d+|x|X|\*))?(?:\.(?:\d+|x|X|\*))?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;
const SEMVER_COMPARATOR_PATTERN = /^(?:\*|x|X|(?:>=|<=|>|<|=|\^|~)?v?\d+(?:\.(?:\d+|x|X|\*))?(?:\.(?:\d+|x|X|\*))?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/;
const NPM_ALIAS_PATTERN = /^npm:((?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*)@(.+)$/;
const CATALOG_SPEC_PATTERN = /^catalog:(?:[a-z0-9][a-z0-9._-]*)?$/i;

export function isAllowedSemverRange(raw) {
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 128 || /[/:\\@]/.test(trimmed)) return false;
  const clauses = trimmed.split(/\s*\|\|\s*/);
  if (clauses.some((clause) => clause.length === 0)) return false;
  for (const clause of clauses) {
    const hyphenParts = clause.split(/\s+-\s+/);
    if (hyphenParts.length === 2) {
      if (!SEMVER_CORE_PATTERN.test(hyphenParts[0]) || !SEMVER_CORE_PATTERN.test(hyphenParts[1])) {
        return false;
      }
      continue;
    }
    if (hyphenParts.length > 2) return false;
    const comparators = clause.split(/\s+/);
    if (comparators.some((token) => !SEMVER_COMPARATOR_PATTERN.test(token))) {
      return false;
    }
  }
  return true;
}

export function isAllowedDependencySpecifier(spec) {
  if (typeof spec !== 'string') return false;
  const trimmed = spec.trim();
  if (!trimmed || trimmed.length > 256) return false;
  if (trimmed.startsWith('workspace:')) {
    const rest = trimmed.slice('workspace:'.length);
    return rest === '*' || rest === '^' || rest === '~' || isAllowedSemverRange(rest);
  }
  if (trimmed.startsWith('catalog:')) {
    return CATALOG_SPEC_PATTERN.test(trimmed);
  }
  if (trimmed.startsWith('npm:')) {
    const match = trimmed.match(NPM_ALIAS_PATTERN);
    if (!match || match[1].includes('..')) return false;
    return isAllowedSemverRange(match[2]);
  }
  return isAllowedSemverRange(trimmed);
}

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
  return GH_AW_SALT_PATTERN.test(suffix);
}

function normalizePullRequestRecord(pr) {
  const headRef = pr?.headRef ?? pr?.head?.ref ?? '';
  const headSha = pr?.headSha ?? pr?.head?.sha ?? '';
  const baseRef = pr?.baseRef ?? pr?.base?.ref ?? '';
  const baseSha = pr?.baseSha ?? pr?.base?.sha ?? '';
  const state = String(pr?.state ?? '').toLowerCase();
  const updatedAt = pr?.updatedAt ?? pr?.updated_at ?? null;
  const closedAt = pr?.closedAt ?? pr?.closed_at ?? null;
  const mergedAt = pr?.mergedAt ?? pr?.merged_at ?? null;
  const draft = Boolean(pr?.draft ?? pr?.isDraft ?? false);
  const userLogin = pr?.userLogin ?? pr?.user?.login ?? '';
  const number = Number(pr?.number);
  const url = pr?.url ?? pr?.html_url ?? '';
  return { headRef, headSha, baseRef, baseSha, state, updatedAt, closedAt, mergedAt, draft, userLogin, number, url };
}

async function githubRequestJson(url, token, { method = 'GET', body = undefined, fetchImpl = fetch } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
  }
  const response = await fetchImpl(url, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`GitHub API ${method} ${url} returned ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function fetchWorkerPullRequests({
  repository,
  apiUrl = 'https://api.github.com',
  token,
  recentClosedDays = DEFAULT_RECENT_CLOSED_DAYS,
  maxOpenPages = DEFAULT_MAX_OPEN_PR_PAGES,
  maxClosedPages = DEFAULT_MAX_CLOSED_PR_PAGES,
  now = new Date(),
  fetchImpl = fetch,
}) {
  if (!repository || !token) {
    throw new Error('repository and token are required to query GitHub pull requests');
  }
  const base = apiUrl.replace(/\/+$/, '');
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  const cutoffMs = nowMs - recentClosedDays * 24 * 60 * 60 * 1000;
  const prs = [];

  // 1. Fetch ALL open PRs (fail closed if page budget is exhausted before EOF).
  let openDone = false;
  for (let page = 1; page <= maxOpenPages; page++) {
    const url = `${base}/repos/${repository}/pulls?state=open&sort=created&direction=desc&per_page=100&page=${page}`;
    const batch = await githubRequestJson(url, token, { fetchImpl });
    if (!Array.isArray(batch)) {
      throw new Error(`Unexpected non-array response from ${url}`);
    }
    prs.push(...batch);
    if (batch.length < 100) {
      openDone = true;
      break;
    }
  }
  if (!openDone) {
    throw new Error(`Open PR listing exceeded ${maxOpenPages} page(s); refusing to select a bead with incomplete open-PR state`);
  }

  // 2. Fetch closed PRs sorted by updated desc, stopping once updated_at < cutoff
  //    (since closed_at <= updated_at, no later page can contain a PR closed within the cutoff).
  if (recentClosedDays > 0) {
    let closedDone = false;
    for (let page = 1; page <= maxClosedPages; page++) {
      const url = `${base}/repos/${repository}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
      const batch = await githubRequestJson(url, token, { fetchImpl });
      if (!Array.isArray(batch)) {
        throw new Error(`Unexpected non-array response from ${url}`);
      }
      prs.push(...batch);
      if (batch.length < 100) {
        closedDone = true;
        break;
      }
      const last = normalizePullRequestRecord(batch[batch.length - 1]);
      const lastUpdatedMs = last.updatedAt ? Date.parse(last.updatedAt) : NaN;
      if (Number.isFinite(lastUpdatedMs) && lastUpdatedMs < cutoffMs) {
        closedDone = true;
        break;
      }
    }
    if (!closedDone) {
      throw new Error(`Closed PR listing exceeded ${maxClosedPages} page(s) before reaching ${recentClosedDays}-day cutoff; failing closed`);
    }
  }

  return prs;
}

export async function fetchPullRequestByNumber({
  repository,
  apiUrl = 'https://api.github.com',
  token,
  prNumber,
  fetchImpl = fetch,
}) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  const base = apiUrl.replace(/\/+$/, '');
  const url = `${base}/repos/${repository}/pulls/${prNumber}`;
  return githubRequestJson(url, token, { fetchImpl });
}

export async function fetchPullRequestFiles({
  repository,
  apiUrl = 'https://api.github.com',
  token,
  prNumber,
  maxPages = DEFAULT_MAX_PR_FILE_PAGES,
  fetchImpl = fetch,
}) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  const base = apiUrl.replace(/\/+$/, '');
  const filenames = [];
  const previousFilenames = [];
  let done = false;
  for (let page = 1; page <= maxPages; page++) {
    const url = `${base}/repos/${repository}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const batch = await githubRequestJson(url, token, { fetchImpl });
    if (!Array.isArray(batch)) {
      throw new Error(`Unexpected non-array response from ${url}`);
    }
    for (const entry of batch) {
      if (typeof entry?.filename === 'string') filenames.push(entry.filename);
      if (typeof entry?.previous_filename === 'string') previousFilenames.push(entry.previous_filename);
    }
    if (batch.length < 100) {
      done = true;
      break;
    }
  }
  if (!done) {
    throw new Error(`PR #${prNumber} file listing exceeded ${maxPages} page(s); failing closed`);
  }
  return { filenames, previousFilenames };
}

function sanitizeCloseReason(reason, maxChars = 2048) {
  const normalized = String(reason ?? 'Verification failed').replace(/\r\n?/g, '\n');
  let out = '';
  for (const ch of normalized) {
    const code = ch.codePointAt(0);
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a) || code === 0x7f) {
      out += ' ';
    } else {
      out += ch;
    }
  }
  const cleaned = out.replace(/```/g, '` ` `').trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, maxChars - 1)}…`;
}

export async function closeViolatingPullRequest({
  repository,
  apiUrl = 'https://api.github.com',
  token,
  prNumber,
  reason,
  fetchImpl = fetch,
}) {
  const base = apiUrl.replace(/\/+$/, '');
  // Close the violating PR FIRST so a comment failure can never leave it open.
  await githubRequestJson(`${base}/repos/${repository}/pulls/${prNumber}`, token, {
    method: 'PATCH',
    body: { state: 'closed' },
    fetchImpl,
  });

  const sanitizedReason = sanitizeCloseReason(reason, 2048);
  const commentBody = [
    'Closed this automated draft PR because deterministic post-PR verification failed:',
    '',
    '```text',
    sanitizedReason,
    '```',
    '',
    'No update was recorded to `refs/heads/memory/beads`.',
  ].join('\n');

  let commentPosted = false;
  let commentError = null;
  try {
    await githubRequestJson(`${base}/repos/${repository}/issues/${prNumber}/comments`, token, {
      method: 'POST',
      body: { body: commentBody },
      fetchImpl,
    });
    commentPosted = true;
  } catch (error) {
    commentError = error.message;
  }
  return { closed: true, commentPosted, commentError };
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

function normalizeRepoPath(rawFile, violations) {
  if (typeof rawFile !== 'string') {
    violations.push('Non-string file path in diff');
    return null;
  }
  const file = rawFile.trim();
  if (!file || file.startsWith('/') || file.includes('\\') || file.includes('://')) {
    violations.push(`Invalid repo-relative path "${rawFile}"`);
    return null;
  }
  const segments = file.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    violations.push(`Path traversal or empty segment in "${rawFile}"`);
    return null;
  }
  return file;
}

export function validateWorkerChangedFiles(
  files,
  { app, maxFiles = 20, allowLockfile = true, previousFiles = [] } = {},
) {
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
    const file = normalizeRepoPath(rawFile, violations);
    if (file && !seen.has(file)) {
      seen.add(file);
      normalized.push(file);
    }
  }

  const normalizedPrevious = [];
  const seenPrevious = new Set();
  for (const rawFile of previousFiles ?? []) {
    const file = normalizeRepoPath(rawFile, violations);
    if (file && !seenPrevious.has(file)) {
      seenPrevious.add(file);
      normalizedPrevious.push(file);
    }
  }

  // Count unique current filenames against maxFiles (renames count once, matching gh-aw max-patch-files).
  if (normalized.length > maxFiles) {
    violations.push(`Too many changed files (${normalized.length} > ${maxFiles})`);
  }

  const appPrefix = `apps/${app}/`;
  const appPackageJson = `apps/${app}/package.json`;
  const hasAppPackageJson = normalized.includes(appPackageJson);
  let hasAppFile = false;

  const checkPathAllowed = (file, { isCurrent }) => {
    const baseName = file.split('/').at(-1);
    if (FORBIDDEN_AGENT_GUIDE_BASENAME.test(baseName)) {
      violations.push(`Agent instruction file "${file}" cannot be modified by automated worker PRs`);
      return;
    }
    if (file.startsWith(appPrefix)) {
      if (isCurrent) hasAppFile = true;
      return;
    }
    if (isCurrent && allowLockfile && file === 'pnpm-lock.yaml') {
      if (!hasAppPackageJson) {
        violations.push(`pnpm-lock.yaml may only change alongside ${appPackageJson}`);
      }
      return;
    }
    violations.push(`File "${file}" is outside allowed scope (${appPrefix}**${allowLockfile ? ' or pnpm-lock.yaml with package.json' : ''})`);
  };

  for (const file of normalized) {
    checkPathAllowed(file, { isCurrent: true });
  }
  for (const file of normalizedPrevious) {
    checkPathAllowed(file, { isCurrent: false });
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

export function validatePackageJsonDiff(baseJsonText, headJsonText) {
  let basePkg;
  let headPkg;
  try {
    basePkg = JSON.parse(baseJsonText);
    headPkg = JSON.parse(headJsonText);
  } catch (error) {
    return { valid: false, violations: [`Invalid package.json JSON: ${error.message}`] };
  }
  if (!basePkg || typeof basePkg !== 'object' || Array.isArray(basePkg) || !headPkg || typeof headPkg !== 'object' || Array.isArray(headPkg)) {
    return { valid: false, violations: ['package.json must be a JSON object'] };
  }

  const violations = [];
  const baseScripts = basePkg.scripts ?? {};
  const headScripts = headPkg.scripts ?? {};
  if (JSON.stringify(baseScripts) !== JSON.stringify(headScripts)) {
    violations.push('package.json "scripts" cannot be added, modified, or removed by automated worker PRs');
  }

  for (const section of DEPENDENCY_SECTIONS) {
    const baseDeps = basePkg[section] && typeof basePkg[section] === 'object' ? basePkg[section] : {};
    const headDeps = headPkg[section] && typeof headPkg[section] === 'object' ? headPkg[section] : {};
    for (const [depName, spec] of Object.entries(headDeps)) {
      if (baseDeps[depName] === spec) continue;
      if (typeof spec !== 'string' || !spec.trim()) {
        violations.push(`${section}.${depName} must have a non-empty version string`);
        continue;
      }
      const trimmed = spec.trim();
      if (!isAllowedDependencySpecifier(trimmed)) {
        violations.push(`${section}.${depName} uses disallowed dependency specifier "${trimmed}" (only semver ranges, npm:<pkg>@<range>, workspace:, and catalog: are allowed)`);
      }
    }
  }

  return { valid: violations.length === 0, violations };
}

export function verifyRegeneratedLockfile({
  cwd,
  baseSha,
  headSha,
  app,
  regenerateLockfile = null,
}) {
  const pkgPath = `apps/${app}/package.json`;
  const basePkgText = execFileSync('git', ['show', `${baseSha}:${pkgPath}`], { cwd, encoding: 'utf8' });
  const headPkgText = execFileSync('git', ['show', `${headSha}:${pkgPath}`], { cwd, encoding: 'utf8' });
  const pkgCheck = validatePackageJsonDiff(basePkgText, headPkgText);
  if (!pkgCheck.valid) {
    throw new WorkerPolicyViolationError(`${pkgPath} policy violation: ${pkgCheck.violations.join('; ')}`);
  }

  const headLock = execFileSync('git', ['show', `${headSha}:pnpm-lock.yaml`], { cwd, encoding: 'utf8' });
  const pkgAbs = resolve(cwd, pkgPath);
  const lockAbs = resolve(cwd, 'pnpm-lock.yaml');
  const originalPkg = readFileSync(pkgAbs, 'utf8');
  const originalLock = readFileSync(lockAbs, 'utf8');

  try {
    writeFileSync(pkgAbs, headPkgText, 'utf8');
    if (typeof regenerateLockfile === 'function') {
      regenerateLockfile({ cwd, pkgPath, headPkgText });
    } else {
      execFileSync('pnpm', ['install', '--lockfile-only', '--ignore-scripts'], {
        cwd,
        stdio: 'pipe',
      });
    }
    const regeneratedLock = readFileSync(lockAbs, 'utf8');
    if (regeneratedLock !== headLock) {
      throw new WorkerPolicyViolationError('PR pnpm-lock.yaml does not match deterministic regeneration from base parent + PR package.json');
    }
  } finally {
    writeFileSync(pkgAbs, originalPkg, 'utf8');
    writeFileSync(lockAbs, originalLock, 'utf8');
  }

  return { verified: true };
}

export function buildDeterministicBeadPrNote({ prNumber, prUrl, branch, fileCount }) {
  const fullNote = `Draft PR #${prNumber} opened (${branch}, ${fileCount} file(s)): ${prUrl}`;
  return fullNote.length <= LIMITS.note ? fullNote : `${fullNote.slice(0, LIMITS.note - 1)}…`;
}

export function buildBeadPrUpdateOperation({ bead, prNumber, prUrl, branch, fileCount }) {
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error(`Invalid PR number: ${prNumber}`);
  }
  return {
    op: 'update',
    id: bead.id,
    expectedRevision: bead.revision,
    links: { pr: prNumber },
    note: buildDeterministicBeadPrNote({ prNumber, prUrl, branch, fileCount }),
  };
}

export function recordVerifiedBeadDraftPr({
  cwd,
  ref = DEFAULT_BEADS_REF,
  remote = 'origin',
  selection,
  allowedApps,
  pr,
  prFiles,
  prPreviousFiles = [],
  defaultBranch = 'main',
  expectedAuthor = 'github-actions[bot]',
  actor = DEFAULT_WORKER_ACTOR,
  dryRun = false,
  skipSync = false,
  detectionConclusion = null,
  detectionSuccess = null,
  requireCleanDetection = false,
  now = new Date(),
}) {
  if (requireCleanDetection) {
    try {
      assertCleanThreatDetection({ detectionConclusion, detectionSuccess });
    } catch (error) {
      throw new WorkerPolicyViolationError(error.message);
    }
  }
  if (!selection || selection.selected !== true || !selection.bead?.id || !selection.app) {
    throw new WorkerPolicyViolationError('Refusing to record PR: immutable pre-selection artifact did not select an eligible bead');
  }
  const beadId = selection.bead.id;
  const app = selection.app;
  if (allowedApps && !allowedApps.has(app)) {
    throw new WorkerPolicyViolationError(`Selected app "${app}" is not a registered first-party non-upstream app`);
  }

  const normalizedPr = normalizePullRequestRecord(pr);
  if (!normalizedPr.draft || normalizedPr.state !== 'open' || !Number.isSafeInteger(normalizedPr.number) || normalizedPr.number <= 0) {
    throw new WorkerPolicyViolationError('Refusing to record PR on memory/beads: verified open draft PR is required');
  }
  if (normalizedPr.baseRef !== defaultBranch) {
    throw new WorkerPolicyViolationError(`Draft PR #${normalizedPr.number} base branch "${normalizedPr.baseRef}" must be "${defaultBranch}"`);
  }
  if (expectedAuthor && normalizedPr.userLogin !== expectedAuthor) {
    throw new WorkerPolicyViolationError(`Draft PR #${normalizedPr.number} author "${normalizedPr.userLogin}" does not match expected "${expectedAuthor}"`);
  }
  if (!matchesWorkerBranchForBead(normalizedPr.headRef, beadId, app)) {
    throw new WorkerPolicyViolationError(`Draft PR #${normalizedPr.number} branch "${normalizedPr.headRef}" does not match selected bead ${beadId} (${app})`);
  }

  const diffCheck = validateWorkerChangedFiles(prFiles, { app, previousFiles: prPreviousFiles });
  if (!diffCheck.valid) {
    throw new WorkerPolicyViolationError(`Draft PR #${normalizedPr.number} violates single-app scope for ${app}: ${diffCheck.violations.join('; ')}`);
  }

  if (!skipSync) {
    syncBeadsRef(cwd, { ref, remote, push: false });
  }
  const { beads: localBeads } = readBeadsFromRef(cwd, ref);
  const bead = localBeads.get(beadId);
  if (!bead) {
    throw new WorkerPolicyViolationError(`Bead ${beadId} not found on ${ref}`);
  }
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(String(now));
  if (bead.status !== 'open') {
    throw new WorkerPolicyViolationError(`Bead ${beadId} is no longer open (current status: "${bead.status}")`);
  }
  if (bead.kind !== 'maintenance') {
    throw new WorkerPolicyViolationError(`Bead ${beadId} has kind "${bead.kind}" (only "maintenance" is allowed)`);
  }
  if (isBlockedByDeps(bead, localBeads)) {
    throw new WorkerPolicyViolationError(`Bead ${beadId} is now blocked by unresolved dependencies`);
  }
  if (hasActiveLease(bead, nowMs)) {
    throw new WorkerPolicyViolationError(`Bead ${beadId} is currently leased by "${bead.lease.owner}"`);
  }
  if (bead.scope?.type !== 'app' || bead.scope.targets?.length !== 1 || bead.scope.targets[0] !== app) {
    throw new WorkerPolicyViolationError(`Bead ${beadId} scope does not match selected app "${app}"`);
  }

  const operation = buildBeadPrUpdateOperation({
    bead,
    prNumber: normalizedPr.number,
    prUrl: normalizedPr.url,
    branch: normalizedPr.headRef,
    fileCount: diffCheck.files.length,
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
