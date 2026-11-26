import { existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { loadAppsRegistry } from './apps-registry.mjs';
import {
  DEFAULT_BEADS_REF,
  LIMITS,
  applyOperations,
  applyRemoteBeadsRef,
  filterClosedUpsertOperations,
  mutateBeadsRef,
  readBeadsFromRef,
} from './beads.mjs';
import { upstreamAppPrefixes } from '../report-unused-code.mjs';

export const UNUSED_CODE_ITEM_TYPE = 'upsert_unused_code_bead';
export const DEFAULT_TRIAGE_ACTOR = 'gh-aw/unused-code-triage';

const APP_ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const FORBIDDEN_DEDUPE_UNICODE = /[\p{Cc}\p{Cf}\p{Cs}\p{Cn}\s]/u;
const KNIP_ARTIFACT_PATH = 'quality-artifacts/unused-code/knip.json';

function hasForbiddenDedupeChar(value) {
  return FORBIDDEN_DEDUPE_UNICODE.test(value);
}

function stripControlChars(value) {
  let out = '';
  let lastWasSpace = false;
  for (const ch of String(value)) {
    const code = ch.codePointAt(0);
    const isControl = code < 0x20 || code === 0x7f || /[\p{Cc}\p{Cf}]/u.test(ch);
    if (isControl) {
      if (!lastWasSpace) {
        out += ' ';
        lastWasSpace = true;
      }
    } else {
      out += ch;
      lastWasSpace = false;
    }
  }
  return out;
}

function parseBoundedInt(raw, field, { min, max }) {
  if (raw === undefined || raw === null || raw === '') return undefined;
  let value;
  if (typeof raw === 'number') {
    value = raw;
  } else if (typeof raw === 'string' && /^\d+$/.test(raw.trim())) {
    value = Number(raw.trim());
  } else {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${field} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function isStrictlyContained(parentReal, childReal) {
  const rel = relative(parentReal, childReal);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function resolveTrustedAppDir(cwd, app) {
  const appsDir = resolve(cwd, 'apps');
  if (!existsSync(appsDir)) {
    throw new Error('apps directory does not exist');
  }
  const appsStat = lstatSync(appsDir);
  if (appsStat.isSymbolicLink() || !appsStat.isDirectory()) {
    throw new Error('apps directory must be a real directory, not a symlink');
  }
  const appDir = resolve(appsDir, app);
  if (!existsSync(appDir)) {
    throw new Error(`app directory apps/${app} does not exist`);
  }
  const appStat = lstatSync(appDir);
  if (appStat.isSymbolicLink() || !appStat.isDirectory()) {
    throw new Error(`app directory apps/${app} must be a real directory, not a symlink`);
  }
  const appsReal = realpathSync(appsDir);
  const appDirReal = realpathSync(appDir);
  if (!isStrictlyContained(appsReal, appDirReal)) {
    throw new Error(`app directory apps/${app} escapes apps/`);
  }
  return appDirReal;
}

function isContainedFileInDir(parentReal, targetPath) {
  if (!existsSync(targetPath)) return false;
  const targetReal = realpathSync(targetPath);
  if (!statSync(targetReal).isFile()) return false;
  return isStrictlyContained(parentReal, targetReal);
}

function validateRepoPathForApp(cwd, app, rawPath, { allowKnipArtifact = false } = {}) {
  if (typeof rawPath !== 'string') {
    throw new Error('path must be a string');
  }
  const normalized = rawPath.trim();
  if (!normalized || normalized.includes('\\') || normalized.includes('://') || normalized.startsWith('/')) {
    throw new Error(`invalid repo-relative path "${rawPath}"`);
  }
  const segments = normalized.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`path traversal or empty segment in "${rawPath}"`);
  }
  if (allowKnipArtifact && normalized === KNIP_ARTIFACT_PATH) {
    return normalized;
  }
  const appPrefix = `apps/${app}/`;
  if (!normalized.startsWith(appPrefix)) {
    throw new Error(`path "${normalized}" must stay under ${appPrefix}`);
  }
  const appDirReal = resolveTrustedAppDir(cwd, app);
  const fullPath = resolve(cwd, normalized);
  if (!isContainedFileInDir(appDirReal, fullPath)) {
    throw new Error(`file "${normalized}" does not exist inside apps/${app}/`);
  }
  return normalized;
}

export function assertCleanThreatDetection({ detectionConclusion, detectionSuccess }) {
  const conclusion = typeof detectionConclusion === 'string' ? detectionConclusion.trim() : '';
  const success = typeof detectionSuccess === 'string' ? detectionSuccess.trim() : '';
  if (conclusion !== 'success' || success !== 'true') {
    throw new Error(
      `Threat detection verdict is not cleanly verified (conclusion="${conclusion || 'missing'}", success="${success || 'missing'}"); refusing to apply Beads safe outputs.`,
    );
  }
}

export async function discoverFirstPartyApps(cwd) {
  const registry = await loadAppsRegistry(join(cwd, 'registry', 'apps.yml'));
  const upstream = upstreamAppPrefixes(cwd);
  const allowed = new Set();
  for (const app of registry.apps) {
    if (upstream.has(`apps/${app.id}/`)) continue;
    allowed.add(app.id);
  }
  return allowed;
}

export function parseAgentOutput(raw, itemType = UNUSED_CODE_ITEM_TYPE) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Agent output JSON must be an object with an "items" array');
  }
  if (!Array.isArray(raw.items)) {
    throw new Error('Agent output JSON is missing an "items" array');
  }
  return raw.items.filter(
    (item) => item && typeof item === 'object' && !Array.isArray(item) && item.type === itemType,
  );
}

export function translateUnusedCodeItems(items, { cwd, allowedApps, defaultNote = 'Verified by weekly gh-aw unused-code triage' }) {
  const operations = [];
  const skipped = [];
  const seenKeys = new Set();

  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    try {
      if (typeof item.app !== 'string' || !APP_ID_PATTERN.test(item.app.trim())) {
        throw new Error(`invalid app id "${item.app}"`);
      }
      const app = item.app.trim();
      if (!allowedApps.has(app)) {
        throw new Error(`app "${app}" is not a registered first-party non-upstream app`);
      }

      if (typeof item.dedupe_key !== 'string') {
        throw new Error('dedupe_key must be a string');
      }
      const dedupeKey = item.dedupe_key.trim();
      if (!dedupeKey || dedupeKey.length > LIMITS.dedupeKey || hasForbiddenDedupeChar(dedupeKey)) {
        throw new Error(`invalid dedupe_key "${item.dedupe_key}"`);
      }
      const expectedKeyPrefix = `knip:apps/${app}/`;
      if (!dedupeKey.startsWith(expectedKeyPrefix)) {
        throw new Error(`dedupe_key "${dedupeKey}" must start with "${expectedKeyPrefix}"`);
      }
      const keyBody = dedupeKey.slice('knip:'.length);
      const firstColon = keyBody.indexOf(':');
      if (firstColon <= `apps/${app}/`.length || firstColon === keyBody.length - 1) {
        throw new Error(`dedupe_key "${dedupeKey}" must have format "knip:apps/${app}/<file>:<symbol>"`);
      }
      const keyFile = keyBody.slice(0, firstColon);
      validateRepoPathForApp(cwd, app, keyFile);

      if (seenKeys.has(dedupeKey)) {
        throw new Error(`duplicate dedupe_key "${dedupeKey}" within the same batch`);
      }

      if (typeof item.title !== 'string' || !item.title.trim() || item.title.trim().length > LIMITS.title) {
        throw new Error(`title must be a non-empty string of at most ${LIMITS.title} characters`);
      }
      if (typeof item.summary !== 'string' || !item.summary.trim() || item.summary.trim().length > LIMITS.summary) {
        throw new Error(`summary must be a non-empty string of at most ${LIMITS.summary} characters`);
      }

      const priority = parseBoundedInt(item.priority, 'priority', { min: 1, max: 3 }) ?? 2;
      const expectedRevision = parseBoundedInt(item.expected_revision, 'expected_revision', {
        min: 1,
        max: Number.MAX_SAFE_INTEGER,
      });

      if (typeof item.evidence !== 'string' || !item.evidence.trim()) {
        throw new Error('evidence must be a non-empty comma- or newline-separated list of repo-relative paths');
      }
      const rawEvidence = item.evidence
        .split(/[\n,]/)
        .map((entry) => entry.trim())
        .filter(Boolean);
      if (rawEvidence.length === 0 || rawEvidence.length > 10) {
        throw new Error('evidence must list between 1 and 10 paths');
      }
      const evidence = [...new Set(rawEvidence.map((path) => validateRepoPathForApp(cwd, app, path, { allowKnipArtifact: true })))].sort();
      if (!evidence.some((path) => path.startsWith(`apps/${app}/`))) {
        throw new Error(`evidence must include at least one file under apps/${app}/`);
      }

      let note = defaultNote;
      if (item.note !== undefined && item.note !== null && item.note !== '') {
        if (typeof item.note !== 'string' || !item.note.trim() || item.note.trim().length > LIMITS.note) {
          throw new Error(`note must be a non-empty string of at most ${LIMITS.note} characters`);
        }
        note = item.note.trim();
      }

      seenKeys.add(dedupeKey);
      const op = {
        op: 'upsert',
        dedupeKey,
        title: item.title.trim(),
        summary: item.summary.trim(),
        kind: 'maintenance',
        priority,
        scope: { type: 'app', targets: [app] },
        links: { evidence },
        note,
      };
      if (expectedRevision !== undefined) {
        op.expectedRevision = expectedRevision;
      }
      operations.push(op);
    } catch (error) {
      skipped.push({
        index,
        dedupeKey: typeof item.dedupe_key === 'string' ? item.dedupe_key : null,
        app: typeof item.app === 'string' ? item.app : null,
        reason: error.message,
      });
    }
  }

  return { operations, skipped };
}

export async function applyUnusedCodeSafeOutputs(rawOutput, {
  cwd = process.cwd(),
  ref = DEFAULT_BEADS_REF,
  remote = 'origin',
  actor = DEFAULT_TRIAGE_ACTOR,
  maxCreates = 5,
  maxUpdates = 10,
  staged = false,
  dryRun = false,
  skipSync = false,
  requireCleanDetection = false,
  detectionConclusion = null,
  detectionSuccess = null,
  beforePush = null,
  allowedApps = null,
  itemType = UNUSED_CODE_ITEM_TYPE,
  now = new Date(),
} = {}) {
  if (requireCleanDetection) {
    assertCleanThreatDetection({ detectionConclusion, detectionSuccess });
  }

  const matchingItems = parseAgentOutput(rawOutput, itemType);
  if (matchingItems.length === 0) {
    return {
      status: 'skipped',
      staged: Boolean(staged || dryRun),
      pushed: false,
      createdIds: [],
      updatedIds: [],
      untouchedIds: [],
      skipped: [],
      message: `No ${itemType} items emitted by agent.`,
    };
  }

  const apps = allowedApps ?? await discoverFirstPartyApps(cwd);
  const { operations, skipped } = translateUnusedCodeItems(matchingItems, { cwd, allowedApps: apps });
  if (operations.length === 0) {
    throw new Error(`All ${skipped.length} ${itemType} item(s) failed validation: ${skipped.map((s) => s.reason).join('; ')}`);
  }

  const safeOpts = {
    actor,
    now,
    maxCreates,
    maxUpdates,
    requireExpectedRevision: true,
    singleAppOnly: true,
    lockActor: true,
  };

  const itemIndexByKey = new Map();
  for (let i = 0; i < matchingItems.length; i++) {
    const key = typeof matchingItems[i]?.dedupe_key === 'string' ? matchingItems[i].dedupe_key.trim() : null;
    if (key && !itemIndexByKey.has(key)) itemIndexByKey.set(key, i);
  }
  const mergeSkippedClosed = (closedList) => [
    ...skipped,
    ...closedList.map((entry) => ({
      index: itemIndexByKey.get(entry.dedupeKey) ?? -1,
      dedupeKey: entry.dedupeKey,
      app: matchingItems[itemIndexByKey.get(entry.dedupeKey)]?.app ?? null,
      reason: entry.reason,
    })),
  ];

  const previewOnly = Boolean(staged || dryRun);

  if (!skipSync) {
    const remoteResult = applyRemoteBeadsRef(cwd, operations, {
      ref,
      remote,
      message: 'beads: weekly unused-code triage',
      dryRun: previewOnly,
      skipClosedUpserts: true,
      beforePush,
      ...safeOpts,
    });
    const allSkipped = mergeSkippedClosed(remoteResult.skippedClosed ?? []);
    const allSkippedAsClosed = remoteResult.createdIds.length === 0
      && remoteResult.updatedIds.length === 0
      && remoteResult.untouchedIds.length === 0
      && (remoteResult.skippedClosed?.length ?? 0) > 0;
    if (previewOnly || allSkippedAsClosed) {
      return {
        status: 'skipped',
        staged: previewOnly,
        pushed: false,
        createdIds: remoteResult.createdIds,
        updatedIds: remoteResult.updatedIds,
        untouchedIds: remoteResult.untouchedIds,
        skipped: allSkipped,
        message: allSkippedAsClosed && !previewOnly
          ? `All ${remoteResult.skippedClosed.length} finding(s) correspond to already-closed beads; no writes needed.`
          : `Staged preview: ${remoteResult.createdIds.length} create(s), ${remoteResult.updatedIds.length} update(s), ${remoteResult.untouchedIds.length} untouched.`,
      };
    }
    return {
      status: 'success',
      staged: false,
      pushed: remoteResult.pushed,
      commitSha: remoteResult.commitSha,
      createdIds: remoteResult.createdIds,
      updatedIds: remoteResult.updatedIds,
      untouchedIds: remoteResult.untouchedIds,
      skipped: allSkipped,
      message: `Applied to ${ref}: ${remoteResult.createdIds.length} created, ${remoteResult.updatedIds.length} updated, ${remoteResult.untouchedIds.length} untouched${remoteResult.pushed ? ' (pushed)' : ' (no remote push needed)'}.`,
    };
  }

  if (previewOnly) {
    const { beads: localBeads } = readBeadsFromRef(cwd, ref);
    const { activeOperations, skippedClosed } = filterClosedUpsertOperations(localBeads, operations);
    const allSkipped = mergeSkippedClosed(skippedClosed);
    if (activeOperations.length === 0) {
      return {
        status: 'skipped',
        staged: true,
        pushed: false,
        createdIds: [],
        updatedIds: [],
        untouchedIds: [],
        skipped: allSkipped,
        message: `All ${skippedClosed.length} finding(s) correspond to already-closed beads; no writes needed.`,
      };
    }
    const preview = applyOperations(localBeads, activeOperations, safeOpts);
    return {
      status: 'skipped',
      staged: true,
      pushed: false,
      createdIds: preview.createdIds,
      updatedIds: preview.updatedIds,
      untouchedIds: preview.untouchedIds,
      skipped: allSkipped,
      message: `Staged preview: ${preview.createdIds.length} create(s), ${preview.updatedIds.length} update(s), ${preview.untouchedIds.length} untouched.`,
    };
  }

  const applied = mutateBeadsRef(cwd, operations, {
    ref,
    message: 'beads: weekly unused-code triage',
    skipClosedUpserts: true,
    ...safeOpts,
  });
  const allSkipped = mergeSkippedClosed(applied.skippedClosed ?? []);
  const allSkippedAsClosed = applied.createdIds.length === 0
    && applied.updatedIds.length === 0
    && applied.untouchedIds.length === 0
    && (applied.skippedClosed?.length ?? 0) > 0;
  if (allSkippedAsClosed) {
    return {
      status: 'skipped',
      staged: false,
      pushed: false,
      createdIds: [],
      updatedIds: [],
      untouchedIds: [],
      skipped: allSkipped,
      message: `All ${applied.skippedClosed.length} finding(s) correspond to already-closed beads; no writes needed.`,
    };
  }
  return {
    status: 'success',
    staged: false,
    pushed: false,
    commitSha: applied.commitSha,
    createdIds: applied.createdIds,
    updatedIds: applied.updatedIds,
    untouchedIds: applied.untouchedIds,
    skipped: allSkipped,
    message: `Applied to ${ref}: ${applied.createdIds.length} created, ${applied.updatedIds.length} updated, ${applied.untouchedIds.length} untouched (no remote push needed).`,
  };
}

function escapeMarkdownText(value) {
  return stripControlChars(String(value))
    .replaceAll('\\', '\\\\')
    .replaceAll('`', '\\`')
    .replaceAll('*', '\\*')
    .replaceAll('_', '\\_')
    .replaceAll('[', '\\[')
    .replaceAll(']', '\\]')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('|', '\\|')
    .replaceAll('#', '\\#')
    .replaceAll('~', '\\~')
    .trim();
}

function sanitizeCodeSpan(value) {
  return stripControlChars(String(value)).replaceAll('`', "'").trim();
}

export function formatSafeOutputsSummary(result, { workflow = 'unused-code-triage', ref = DEFAULT_BEADS_REF } = {}) {
  const mode = result.staged ? 'staged preview (no writes)' : `live (${ref})`;
  const lines = [
    '## Beads safe-outputs summary',
    '',
    `- **Mode:** ${mode}`,
    `- **Status:** ${result.status}`,
    `- **Created:** ${result.createdIds.length}${result.createdIds.length ? ` (${result.createdIds.join(', ')})` : ''}`,
    `- **Updated:** ${result.updatedIds.length}${result.updatedIds.length ? ` (${result.updatedIds.join(', ')})` : ''}`,
    `- **Untouched:** ${result.untouchedIds.length}`,
    `- **Skipped invalid items:** ${result.skipped.length}`,
    `- **Pushed to remote:** ${result.pushed ? 'yes' : 'no'}`,
  ];
  if (result.skipped.length > 0) {
    lines.push('', '### Skipped invalid items', '');
    for (const item of result.skipped) {
      const keyPart = item.dedupeKey ? ` (\`${sanitizeCodeSpan(item.dedupeKey)}\`)` : '';
      lines.push(`- Item #${item.index + 1}${keyPart}: ${escapeMarkdownText(item.reason)}`);
    }
  }
  lines.push('', `> Generated by agentic workflow \`${sanitizeCodeSpan(workflow)}\` via deterministic \`scripts/apply-beads-safe-outputs.mjs\`.`);
  return `${lines.join('\n')}\n`;
}
