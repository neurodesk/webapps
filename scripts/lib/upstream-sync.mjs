// Three-way merge of an upstream repository's changes into the monorepo copy
// of an app. Base is the commit the app was last synced from, "local" is the
// checkout and "upstream" is the new commit; nothing outside appDir is touched.
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { upstreamCitationSnapshot } from './upstream-citations.mjs';

export const PACKAGE_VERSION_SITE = { file: 'package.json', pattern: /("version":\s*")[^"]+(")/ };

function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, ...args], { maxBuffer: 1 << 30 });
}

function show(directory, commit, path) {
  return git(directory, 'show', `${commit}:${path}`);
}

function isBinary(...buffers) {
  return buffers.some(buffer => buffer && buffer.subarray(0, 8000).includes(0));
}

function rewrite(text, rules) {
  return Object.entries(rules).reduce((value, [from, to]) => value.replaceAll(from, to), text);
}

function ignored(path, patterns) {
  return patterns.some(pattern => pattern.endsWith('/**') ? path.startsWith(pattern.slice(0, -2)) : path === pattern);
}

// Upstream and the monorepo version an app independently. Give base and
// upstream the local version so version lines never conflict.
function pinVersions(text, path, local, sites) {
  let result = text;
  for (const site of sites.filter(item => item.file === path)) {
    const match = site.pattern.exec(local);
    if (!match) continue;
    const value = match[0];
    result = result.replace(site.pattern, () => value);
  }
  return result;
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// Key-by-key merge, so independent additions to package.json never conflict.
const CONFLICT = Symbol('conflict');
function mergeJson(local, base, upstream) {
  if (same(local, upstream) || same(upstream, base)) return local;
  if (same(local, base)) return upstream;
  if (![local, base ?? {}, upstream].every(isObject)) return CONFLICT;
  const merged = {};
  for (const key of new Set([...Object.keys(local), ...Object.keys(upstream)])) {
    const value = mergeJson(local[key], base?.[key], upstream[key]);
    if (value === CONFLICT) return CONFLICT;
    if (value !== undefined) merged[key] = value;
  }
  return merged;
}

function threeWay(local, base, upstream) {
  const directory = mkdtempSync(join(process.env.TMPDIR || '.', 'upstream-merge-'));
  try {
    const files = ['local', 'base', 'upstream'].map(name => join(directory, name));
    [local, base, upstream].forEach((content, index) => writeFileSync(files[index], content));
    const merged = spawnSync('git', ['merge-file', '-p', '-L', 'monorepo', '-L', 'base', '-L', 'upstream', ...files], { maxBuffer: 1 << 30 });
    if (merged.status === null || merged.status < 0 || merged.status > 127) throw new Error(`git merge-file failed: ${merged.stderr}`);
    return { content: merged.stdout, conflict: merged.status > 0 };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Applies upstream's base..target changes to appDir.
 * config.ignore: upstream paths never imported (`dir/**` or exact paths).
 * config.rewrite: text replaced in upstream paths and contents, for renames.
 * versionSites: { file, pattern } with file relative to appDir.
 * Returns one { path, status } entry per upstream change.
 */
export function mergeUpstream({ upstream, base, target, appDir, config = {}, versionSites = [] }) {
  const rules = config.rewrite || {};
  const patterns = config.ignore || [];
  const baseDirs = new Set();
  for (const item of git(upstream, 'ls-tree', '-r', '--name-only', base).toString().split('\n').filter(Boolean)) {
    for (let dir = dirname(item); dir !== '.'; dir = dirname(dir)) baseDirs.add(dir);
  }
  // True when an upstream directory above name existed at base and the monorepo removed it.
  const insideRemovedDirectory = name => {
    for (let dir = dirname(name); dir !== '.'; dir = dirname(dir)) {
      if (baseDirs.has(dir) && !existsSync(join(appDir, rewrite(dir, rules)))) return true;
    }
    return false;
  };
  const addFile = (name, file, bytes) => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
    if (git(upstream, 'ls-tree', target, '--', name).toString().startsWith('100755')) chmodSync(file, 0o755);
  };
  const changes = git(upstream, 'diff', '--name-status', '--no-renames', base, target).toString().split('\n').filter(Boolean);
  const report = [];
  for (const line of changes) {
    const [status, name] = line.split('\t');
    const path = rewrite(name, rules);
    const file = join(appDir, path);
    const local = existsSync(file) ? readFileSync(file) : null;
    if (ignored(name, patterns)) {
      report.push({ path, status: 'ignored' });
      continue;
    }
    if (status === 'D') {
      if (!local) report.push({ path, status: 'unchanged' });
      else if (local.equals(Buffer.from(rewrite(show(upstream, base, name).toString('latin1'), rules), 'latin1'))) {
        unlinkSync(file);
        report.push({ path, status: 'deleted' });
      } else report.push({ path, status: 'kept', reason: 'upstream deleted a file the monorepo changed' });
      continue;
    }
    // A file upstream had at base and the monorepo removed was replaced by
    // shared code on purpose; so was a new file in a directory it removed.
    const dropped = status === 'A' ? insideRemovedDirectory(name) : !local;
    if (dropped) {
      report.push({ path, status: 'dropped', reason: 'the monorepo replaced this upstream file' });
      continue;
    }
    const upstreamBytes = show(upstream, target, name);
    const baseBytes = status === 'A' ? Buffer.alloc(0) : show(upstream, base, name);
    if (isBinary(upstreamBytes, baseBytes, local)) {
      if (!local || local.equals(baseBytes)) {
        if (local) writeFileSync(file, upstreamBytes);
        else addFile(name, file, upstreamBytes);
        report.push({ path, status: local ? 'updated' : 'added' });
      } else if (local.equals(upstreamBytes)) report.push({ path, status: 'unchanged' });
      else report.push({ path, status: 'conflict', reason: 'binary file changed on both sides; kept the monorepo copy' });
      continue;
    }
    const localText = local ? local.toString('latin1') : '';
    const upstreamText = pinVersions(rewrite(upstreamBytes.toString('latin1'), rules), path, localText, versionSites);
    if (!local) {
      addFile(name, file, Buffer.from(upstreamText, 'latin1'));
      report.push({ path, status: 'added' });
      continue;
    }
    const baseText = pinVersions(rewrite(baseBytes.toString('latin1'), rules), path, localText, versionSites);
    const json = path.endsWith('package.json') ? mergeJson(...[localText, baseText, upstreamText].map(text => JSON.parse(text))) : CONFLICT;
    const merged = json !== CONFLICT
      ? { content: Buffer.from(`${JSON.stringify(json, null, 2)}\n`), conflict: false }
      : threeWay(local, Buffer.from(baseText, 'latin1'), Buffer.from(upstreamText, 'latin1'));
    if (merged.content.equals(local)) {
      report.push({ path, status: 'unchanged' });
      continue;
    }
    writeFileSync(file, merged.content);
    report.push({ path, status: merged.conflict ? 'conflict' : 'merged' });
  }
  if (config.citationSnapshot) {
    const { file, selector, output } = config.citationSnapshot;
    const snapshot = upstreamCitationSnapshot(show(upstream, target, file).toString('utf8'), target, selector);
    writeFileSync(join(appDir, output), `${JSON.stringify(snapshot, null, 2)}\n`);
  }
  return report;
}
