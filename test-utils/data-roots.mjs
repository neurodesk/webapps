// Data roots of the reference compute server: relative path rules, canonical
// containment, paged listings and pattern matching, as in the "Data roots"
// section of docs/architecture/remote-compute-protocol.md. Every function
// throws on a path it refuses; the server maps that to 404 for listings and to
// invalid-spec for specs.
import { lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { checkRelativePath } from '../packages/cryo-em/src/spec.js';

export const PAGE_SIZE = 1000;
export const ROOT_ID = /^[a-z0-9][a-z0-9-]{0,31}$/;
const MAX_PATTERN_BYTES = 255;

/** Whether canonical `path` is `base` or lies below it. */
export function isInside(base, path) {
  if (path === base) return true;
  const prefix = base.endsWith(sep) ? base : base + sep;
  return path.startsWith(prefix);
}

/** Byte-order comparison of two names, as the protocol sorts them. */
export function compareBytes(a, b) {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}

/**
 * Canonicalise `{ id: absolutePath }` into a Map of id to canonical directory.
 * Throws on a bad id or a path that is not a directory.
 */
export function canonicalRoots(dataRoots) {
  const roots = new Map();
  for (const [id, path] of Object.entries(dataRoots)) {
    if (!ROOT_ID.test(id)) throw new Error(`data root id ${id} must match ${ROOT_ID}`);
    const canonical = realpathSync(path);
    if (!statSync(canonical).isDirectory()) throw new Error(`data root ${id} is not a directory`);
    roots.set(id, canonical);
  }
  return roots;
}

/**
 * Resolve a client's relative path inside a canonical base directory. The
 * result is canonical (symlinks resolved) and inside `base`, or this throws.
 */
export function resolveInside(base, path, { allowEmpty = false } = {}) {
  checkRelativePath(path, 'path', { allowEmpty });
  let canonical;
  try {
    canonical = realpathSync(join(base, path));
  } catch {
    throw new Error(`${path} does not exist`);
  }
  if (!isInside(base, canonical)) throw new Error(`${path} lies outside the root`);
  return canonical;
}

// The metadata of a directory entry, following a symlink only when its
// canonical target lies inside `base`.
function containedStat(base, path) {
  const link = lstatSync(path);
  if (!link.isSymbolicLink()) return link;
  let target;
  try {
    target = realpathSync(path);
  } catch {
    return null;
  }
  if (!isInside(base, target)) return null;
  return statSync(target);
}

function rfc3339(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function encodeCursor(name) {
  return Buffer.from(name).toString('hex');
}

function decodeCursor(cursor) {
  if (!/^(?:[0-9a-f]{2})+$/.test(cursor)) throw new Error('invalid cursor');
  return Buffer.from(cursor, 'hex').toString('utf8');
}

/**
 * One page of `GET /roots/{root}/entries`: names sorted in byte order,
 * dotfiles and escaping symlinks omitted, at most PAGE_SIZE entries. The
 * cursor is the hex encoding of the last name of the previous page.
 */
export function listEntries(root, path = '', cursor = null) {
  const directory = resolveInside(root, path, { allowEmpty: true });
  if (!statSync(directory).isDirectory()) throw new Error(`${path} is not a directory`);
  const after = cursor ? decodeCursor(cursor) : null;
  const entries = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.')) continue;
    if (after !== null && compareBytes(name, after) <= 0) continue;
    const stat = containedStat(root, join(directory, name));
    if (!stat) continue;
    let kind = null;
    if (stat.isFile()) kind = 'file';
    else if (stat.isDirectory()) kind = 'directory';
    if (!kind) continue;
    entries.push({
      name,
      kind,
      bytes: kind === 'file' ? stat.size : null,
      modifiedAt: rfc3339(stat.mtime),
    });
  }
  entries.sort((a, b) => compareBytes(a.name, b.name));
  let next = null;
  if (entries.length > PAGE_SIZE) {
    entries.length = PAGE_SIZE;
    next = encodeCursor(entries.at(-1).name);
  }
  return { path, entries, next };
}

/** `*` matches any run of characters and `?` one character; nothing else is special. */
export function globMatches(pattern, name) {
  let expression = '^';
  for (const character of pattern) {
    if (character === '*') expression += '.*';
    else if (character === '?') expression += '.';
    else expression += character.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
  }
  return new RegExp(`${expression}$`, 'su').test(name);
}

/**
 * Files of one directory of a root that `pattern` selects, sorted in byte
 * order. Dotfiles never match; a match whose canonical path leaves the root
 * refuses the whole reference; no match is an error.
 */
export function matchPattern(root, path, pattern) {
  if (typeof pattern !== 'string' || pattern === '' || Buffer.byteLength(pattern) > MAX_PATTERN_BYTES) throw new Error('pattern must be 1 to 255 bytes');
  if (pattern.includes('/') || pattern.includes('\0')) throw new Error('pattern must not contain / or NUL');
  const directory = resolveInside(root, path, { allowEmpty: true });
  const names = [];
  for (const name of readdirSync(directory)) {
    if (name.startsWith('.')) continue;
    if (!globMatches(pattern, name)) continue;
    let canonical;
    try {
      canonical = realpathSync(join(directory, name));
    } catch {
      throw new Error(`${name} is a broken link`);
    }
    if (!isInside(root, canonical)) throw new Error(`${name} lies outside the root`);
    if (statSync(canonical).isFile()) names.push(name);
  }
  if (!names.length) throw new Error(`no file in ${path || 'the root'} matches ${pattern}`);
  names.sort(compareBytes);
  return { directory: relative(root, directory).split(sep).join('/'), names };
}

/** A single regular file of a root, `{ root, path }`. */
export function resolveFile(root, path) {
  const canonical = resolveInside(root, path);
  if (!statSync(canonical).isFile()) throw new Error(`${path} is not a regular file`);
  return canonical;
}
