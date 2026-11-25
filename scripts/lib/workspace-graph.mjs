import { readdirSync, readFileSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { parse } from 'yaml';
import { sharedModuleUsers } from './shared-module-users.mjs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import sourceParser from '@neurodesk/code-quality';

// Which apps/, packages/ and exes/ directories each workspace directory uses.
// Declared workspace dependencies are not enough: apps also reach shared code
// through relative paths in build scripts, Vite configs and Rust `#[path]`
// includes, so text references count as edges too. Root files an app reaches
// (`../../scripts/theme-app-dist.mjs`, `../../test-utils/dice.mjs`, and the
// registry files those read) are nodes of their own, followed through their
// imports to the packages they copy or bundle. SITE is a node for what ci.yml's
// site jobs run (siteJobNames), CATALOG for what its per-app jobs run.
// A false reference only widens the CI selection.

const TOP_LEVEL = ['apps', 'packages', 'exes'];
// Apps are leaves: a package that mentions an app does not use what that app uses.
const TRAVERSABLE_WORKSPACE_GROUPS = new Set(['packages', 'exes']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-sites', 'target', '.turbo', '.vite', 'coverage', 'test-results', 'playwright-report']);
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html|css|rs|toml|py|sh|ya?ml)$|^Makefile$/;
const MAX_TEXT_BYTES = 1024 * 1024;
// A relative path, or a root-relative string such as 'exes/compute-server/src/x.rs'
// joined onto a computed repository root.
const REFERENCE = /(?:(?:\.\.\/)+|['"`])(packages|exes)\/([\w.-]+)/g;
// Scripts address packages from the repository root, in either form, and
// sometimes a single file in one. Put `json` before `[cm]?[jt]s` with a path
// boundary so `.json` does not truncate to `.js` and `.json.gz` does not
// truncate to `.json`; `isCompleteScriptFile` further checks quoted literals.
const SCRIPT_REFERENCE = /\b(packages|exes)(?:\/|['"],\s*['"])([\w.-]+)((?:\/[\w.-]+)*\/[\w.-]+\.(?:json|[cm]?[jt]s|md)(?=[\s'"`),;:\]}]|$))?/g;
// Documentation counts only where code reads that exact file.
const DOCUMENT_REFERENCE = /\b((?:packages|exes)\/[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+\.md)\b/g;
// A package's own tests change no app unless an app reads from them.
const PACKAGE_TESTS = /(?:\.\.\/)+(packages\/[\w.-]+\/tests?)\//g;
const BARE_IMPORT = /\bfrom\s+['"]((?:@[\w.-]+\/)?[\w.-]+)/g;
const ROOT_FILE = String.raw`[\w./-]+\.(?:[cm]?[jt]s|json|ya?ml)`;
const ROOT_PATH = new RegExp(String.raw`(?:\.\.\/)+((?:scripts|test-utils|registry|test)\/${ROOT_FILE})\b`, 'g');
// Root files name each other relative to themselves or from the repository root.
const ROOT_IMPORT = new RegExp(String.raw`['"\`](\.\.?\/${ROOT_FILE})['"\`]`, 'g');
const ROOT_NAMED = new RegExp(String.raw`(?:^|[\s'"\`(=])(?:\.\/)?((?:scripts|test-utils|registry|test)\/${ROOT_FILE})\b|['"](registry|test-utils)['"],\s*['"](${ROOT_FILE})['"]`, 'gm');
const ROOT_GLOB = /['"`]((?:scripts|test-utils|test)\/[\w/-]+)\/[^'"`]*\*[^'"`]*['"`]/g;
const ROOT_DIRS = ['scripts/', 'test-utils/', 'registry/', 'test/', 'packages/', 'exes/'];
const ROOT_CONFIG = /^[\w.-]+\.(?:[cm]?[jt]s|json)$/;
const SOURCE_FILE = /\.[cm]?[jt]s$/;
// A whole line that is a `//` comment. Triple-slash lines stay: TypeScript's
// `/// <reference path>` directives are compiler inputs.
const LINE_COMMENT = /^[ \t]*\/\/(?!\/).*$/gm;
// An app's code names a file of another app by a relative path: a kit its build
// stages, a fixture its tests read.
const APP_CODE = /\.[cm]?[jt]sx?$/;
const RELATIVE_PATH = /(['"`])((?:\.\.\/)+[^'"`\s$]*)\1/g;
// Lint and mutation-testing configs: their own workflows read them, composite-site never does.
export const INDEPENDENT_CONFIG = /^(?:eslint|knip|stryker)\.config\.m?js$/;
export const CATALOG = '(catalog)';
export const SITE = '(site)';
// The ci.yml jobs that run once per selected app.
export const CATALOG_JOBS = ['app-tests', 'browser-e2e', 'browser-e2e-gpu'];

// ci.yml's site jobs: composite-site, which builds the site, every job that
// waits for a site job (the site-* checks of that build, agent-interactions)
// and agent-interactions, which older layouts ran inside composite-site.
export function siteJobNames(ci) {
  const jobs = ci?.jobs ?? {};
  const names = ['composite-site'];
  if (Object.hasOwn(jobs, 'agent-interactions')) names.push('agent-interactions');
  for (let added = true; added;) {
    added = false;
    for (const [name, job] of Object.entries(jobs)) {
      if (names.includes(name) || ![job?.needs ?? []].flat().some((need) => names.includes(need))) continue;
      names.push(name);
      added = true;
    }
  }
  return names;
}

// Root files a set of CI commands names, following `pnpm <root script>` calls.
function namedByCommands(commands, rootScripts, root = null, rootPackageName = null) {
  const named = new Set();
  const pending = commands.map((entry) => (typeof entry === 'string' ? { cmd: entry, workingDir: null } : entry));
  const expanded = new Set();
  while (pending.length) {
    const current = pending.pop();
    for (const match of current.cmd.matchAll(ROOT_NAMED)) if (match[1]) named.add(match[1]);
    for (const [, rootFile] of current.cmd.matchAll(ROOT_PATH)) named.add(rootFile);
    const nonRootWorkingDir = isStaticNonRootDir(current.workingDir, root);
    for (const script of extractPnpmRootScripts(current.cmd, { requireRootFlag: nonRootWorkingDir, baseDir: current.workingDir ?? '.', root, rootPackageName })) {
      if (!expanded.has(script)) {
        expanded.add(script);
        if (rootScripts[script]) pending.push({ cmd: rootScripts[script], workingDir: null });
      }
    }
  }
  return { named, expanded };
}
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];

function withoutLineComments(source, file) {
  let comments;
  try {
    comments = sourceParser.parse(source, { filePath: file, sourceType: 'module' }).comments;
  } catch {
    return source;
  }
  const starts = new Set(comments.filter(({ type }) => type === 'Line').map(({ range }) => range[0]));
  return source.replace(LINE_COMMENT, (line, offset) => starts.has(offset + line.indexOf('//')) ? '' : line);
}

async function listDirs(path) {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

async function* textFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* textFiles(join(dir, entry.name));
    } else if (entry.isFile() && TEXT_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function exists(path) {
  return stat(path).then(() => true, () => false);
}

// Regular file with no symlink at the leaf or any intermediate path component.
async function isRegularUnlinkedFile(root, target) {
  const full = join(root, target);
  const entry = await lstat(full).catch(() => null);
  if (!entry?.isFile()) return false;
  try {
    const [realRoot, realFull] = await Promise.all([realpath(root), realpath(full)]);
    return realFull === join(realRoot, target);
  } catch {
    return false;
  }
}

const AST_SKIP = new Set(['loc', 'range', 'start', 'end', 'tokens', 'comments', 'parent']);
const DIRECT_MODULE_PARENTS = new Set(['ImportDeclaration', 'ExportNamedDeclaration', 'ExportAllDeclaration', 'ImportExpression']);
const STATEMENT_BOUNDARY = new Set(['ExpressionStatement', 'VariableDeclaration']);
const FILE_READER_CALLS = new Set(['readFile', 'readFileSync', 'require']);
const PATH_JOIN_CALLS = new Set(['join', 'resolve']);
const EXEC_ARRAY_CALLS = new Set(['run', 'execFile', 'execFileSync', 'spawn', 'spawnSync']);
const INDEPENDENT_LINT_SCRIPT = /^node\s+(?:\.\.\/)+scripts\/lint\.mjs(?:\s+--workspace)?$/;
const FILTER_ARG = /(?:^|[\s;|&(])(--filter-prod|--filter|-F|--workspace|--dir|-C|--prefix|--cwd)(?:=|\s+)['"]?([^\s'"]+)['"]?/g;
const NPM_SHORT_WORKSPACE_ARG = /(?:^|[\s;|&(])(-w)(?:=|\s+)['"]?([^\s'"]+)['"]?/g;
const CROSS_WORKSPACE_FLAG = /(?:^|[\s;|&(])(?:--filter-prod|--filter|-F|--dir|-C|--prefix|--cwd|-r|--recursive|--workspace|-w|-ws|--workspaces)(?:=|\s|$)/;

function calleeNameOf(callNode) {
  const callee = callNode?.callee;
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name;
  return null;
}

function isJsonParseCall(node) {
  return (
    node?.type === 'CallExpression' &&
    calleeNameOf(node) === 'parse' &&
    node.callee?.type === 'MemberExpression' &&
    !node.callee.computed &&
    node.callee.object?.type === 'Identifier' &&
    node.callee.object.name === 'JSON'
  );
}

function isPlainJsonParseCall(node) {
  return (
    isJsonParseCall(node) &&
    Array.isArray(node.arguments) &&
    node.arguments.length === 1 &&
    node.arguments[0]?.type !== 'SpreadElement'
  );
}

// Classify a literal in a whitelisted standalone path context:
// (1) static/dynamic import/export source, (2) direct file-reader or final
// `join`/`resolve` argument consumed by a file reader (`readFile`/`readFileSync`/
// `require`), (3) element of an ArrayExpression passed directly to a subprocess
// runner (`run`/`execFile`/`execFileSync`/`spawn`/`spawnSync`), or (4) direct
// VariableDeclarator initializer whose binding is never referenced elsewhere.
// Returns `{ standalone, derivedJson }`: for `.json` reads, `derivedJson` is true
// whenever the parsed JSON value (or any property/chain from it) is used outside
// direct file-reader pass-through, so the JSON scanner preserves target directories.
function classifyPathLiteral(node, ancestors, referencedIdentifiers, readerArgIdentifiers, derivedIdentifiers) {
  const nope = { standalone: false, derivedJson: false };
  if (node.type !== 'Literal' || typeof node.value !== 'string') return nope;
  const isJsonLiteral = node.value.endsWith('.json');
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return nope;
  if (DIRECT_MODULE_PARENTS.has(parent.type) && parent.source === node) return { standalone: true, derivedJson: isJsonLiteral };
  if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id?.type === 'Identifier') {
    const grandParent = ancestors[ancestors.length - 2];
    const greatGrandParent = ancestors[ancestors.length - 3];
    const standalone =
      grandParent?.type === 'VariableDeclaration' &&
      greatGrandParent?.type !== 'ExportNamedDeclaration' &&
      !referencedIdentifiers.has(parent.id.name);
    return { standalone, derivedJson: false };
  }
  let callIndex = -1;
  let consumedByReader = false;
  if (parent.type === 'CallExpression' && Array.isArray(parent.arguments) && parent.arguments.includes(node)) {
    const name = calleeNameOf(parent);
    if (FILE_READER_CALLS.has(name)) consumedByReader = true;
    else if (!PATH_JOIN_CALLS.has(name) || parent.arguments[parent.arguments.length - 1] !== node) return nope;
    callIndex = ancestors.length - 1;
  } else if (parent.type === 'ArrayExpression') {
    const grandParent = ancestors[ancestors.length - 2];
    if (
      grandParent?.type === 'CallExpression' &&
      Array.isArray(grandParent.arguments) &&
      grandParent.arguments.includes(parent) &&
      EXEC_ARRAY_CALLS.has(calleeNameOf(grandParent))
    ) {
      callIndex = ancestors.length - 2;
      consumedByReader = true;
    }
  }
  if (callIndex < 0) return nope;
  let derivedJson = false;
  for (let i = callIndex - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    const child = ancestors[i + 1];
    if (STATEMENT_BOUNDARY.has(ancestor.type)) return { standalone: consumedByReader, derivedJson: isJsonLiteral && derivedJson };
    if (ancestor.type === 'ReturnStatement') {
      return consumedByReader && isJsonLiteral ? { standalone: true, derivedJson: true } : nope;
    }
    if (ancestor.type === 'AwaitExpression' && ancestor.argument === child) continue;
    if (ancestor.type === 'VariableDeclarator' && ancestor.init === child) {
      const exported = ancestors[i - 1]?.type === 'VariableDeclaration' && ancestors[i - 2]?.type === 'ExportNamedDeclaration';
      if (exported) return nope;
      if (ancestor.id?.type === 'Identifier') {
        if (isJsonLiteral) {
          if (derivedIdentifiers.has(ancestor.id.name)) derivedJson = true;
        } else if (readerArgIdentifiers.has(ancestor.id.name)) {
          return nope;
        }
      } else if (isJsonLiteral) {
        derivedJson = true;
      } else {
        return nope;
      }
      if (consumedByReader) continue;
      if (
        ancestors[i - 1]?.type === 'VariableDeclaration' &&
        ancestor.id?.type === 'Identifier' &&
        !referencedIdentifiers.has(ancestor.id.name)
      ) {
        consumedByReader = true;
        continue;
      }
      return nope;
    }
    if (ancestor.type === 'CallExpression' && Array.isArray(ancestor.arguments) && ancestor.arguments.includes(child)) {
      const name = calleeNameOf(ancestor);
      if (!consumedByReader) {
        if (FILE_READER_CALLS.has(name)) consumedByReader = true;
        else if (!PATH_JOIN_CALLS.has(name) || ancestor.arguments[ancestor.arguments.length - 1] !== child) return nope;
      } else if (isJsonLiteral && FILE_READER_CALLS.has(name)) {
        continue;
      } else if (isJsonParseCall(ancestor)) {
        if (!isPlainJsonParseCall(ancestor)) {
          if (isJsonLiteral) derivedJson = true;
          else return nope;
        }
      } else {
        return nope;
      }
      continue;
    }
    return nope;
  }
  return { standalone: consumedByReader, derivedJson: isJsonLiteral && derivedJson };
}

// Inspect one reference to an identifier and classify whether it is used purely
// as a direct file-reader argument (possibly chained to another binding) or
// participates in path/data derivation (concatenation, joins, aliasing, etc.).
function classifyIdentifierUse(idNode, ancestors, derivedIdentifiers, readerDepEdges) {
  const idName = idNode.name;
  let idx = ancestors.length - 1;
  let expr = idNode;
  while (idx >= 0) {
    const cur = ancestors[idx];
    if (cur.type === 'MemberExpression' && cur.object === expr) {
      expr = cur;
      idx--;
      continue;
    }
    if (cur.type === 'ChainExpression' || cur.type === 'TSAsExpression' || cur.type === 'TSNonNullExpression') {
      expr = cur;
      idx--;
      continue;
    }
    break;
  }
  const useNode = idx >= 0 ? ancestors[idx] : null;
  if (!useNode || useNode.type !== 'CallExpression' || !Array.isArray(useNode.arguments) || !useNode.arguments.includes(expr)) {
    derivedIdentifiers.add(idName);
    return;
  }
  const callee = calleeNameOf(useNode);
  if (!FILE_READER_CALLS.has(callee) && !isPlainJsonParseCall(useNode)) {
    derivedIdentifiers.add(idName);
    return;
  }
  // Check what consumes the result of `readFileSync(id)` / `JSON.parse(id)`.
  for (let i = idx - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    const prev = ancestors[i + 1];
    if (ancestor.type === 'ExpressionStatement') return;
    if (ancestor.type === 'AwaitExpression' && ancestor.argument === prev) continue;
    if (ancestor.type === 'CallExpression' && Array.isArray(ancestor.arguments) && ancestor.arguments.includes(prev)) {
      if (FILE_READER_CALLS.has(calleeNameOf(ancestor)) || isPlainJsonParseCall(ancestor)) continue;
      derivedIdentifiers.add(idName);
      return;
    }
    if (ancestor.type === 'VariableDeclarator' && ancestor.init === prev) {
      const exported = ancestors[i - 1]?.type === 'VariableDeclaration' && ancestors[i - 2]?.type === 'ExportNamedDeclaration';
      if (!exported && ancestor.id?.type === 'Identifier') {
        readerDepEdges.push([idName, ancestor.id.name]);
        return;
      }
      derivedIdentifiers.add(idName);
      return;
    }
    derivedIdentifiers.add(idName);
    return;
  }
  derivedIdentifiers.add(idName);
}

// Collect string and template literal ranges in a script so SCRIPT_REFERENCE can
// narrow to an exact file only for whitelisted standalone path literals.
function collectScriptStringLiterals(text, file) {
  let ast;
  try {
    ast = sourceParser.parse(text, { filePath: file, sourceType: 'module' });
  } catch {
    return null;
  }
  const referencedIdentifiers = new Set();
  const readerArgIdentifiers = new Set();
  const derivedIdentifiers = new Set();
  const readerDepEdges = [];
  const candidates = [];
  const ancestors = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.type === 'Identifier') {
      const parent = ancestors[ancestors.length - 1];
      const isDeclId = parent?.type === 'VariableDeclarator' && parent.id === node;
      const isNonComputedProp =
        (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node) ||
        (parent?.type === 'Property' && !parent.computed && parent.key === node);
      if (!isDeclId && !isNonComputedProp) {
        referencedIdentifiers.add(node.name);
        if (
          parent?.type === 'CallExpression' &&
          Array.isArray(parent.arguments) &&
          parent.arguments.includes(node) &&
          (FILE_READER_CALLS.has(calleeNameOf(parent)) || PATH_JOIN_CALLS.has(calleeNameOf(parent)) || EXEC_ARRAY_CALLS.has(calleeNameOf(parent)))
        ) {
          readerArgIdentifiers.add(node.name);
        }
        classifyIdentifierUse(node, ancestors, derivedIdentifiers, readerDepEdges);
      }
    }
    const isStringLiteral = node.type === 'Literal' && typeof node.value === 'string';
    const isTemplate = node.type === 'TemplateLiteral';
    if ((isStringLiteral || isTemplate) && Array.isArray(node.range)) {
      candidates.push({ node, ancestors: [...ancestors] });
    }
    ancestors.push(node);
    for (const key of Object.keys(node)) {
      if (!AST_SKIP.has(key)) walk(node[key]);
    }
    ancestors.pop();
  };
  walk(ast);
  for (let changed = true; changed;) {
    changed = false;
    for (const [src, dst] of readerDepEdges) {
      if (derivedIdentifiers.has(dst) && !derivedIdentifiers.has(src)) {
        derivedIdentifiers.add(src);
        changed = true;
      }
    }
  }
  return candidates.map(({ node, ancestors: chain }) => {
    const isStringLiteral = node.type === 'Literal' && typeof node.value === 'string';
    const isTemplate = node.type === 'TemplateLiteral';
    const commentLine =
      (isStringLiteral || (isTemplate && node.expressions.length === 0)) &&
      chain[chain.length - 1]?.type === 'VariableDeclarator' &&
      /(?:^|\n)[ \t]*\/\//.test(text.slice(node.range[0] + 1, node.range[1] - 1));
    const classified = classifyPathLiteral(node, chain, referencedIdentifiers, readerArgIdentifiers, derivedIdentifiers);
    return { start: node.range[0], end: node.range[1], standalone: classified.standalone || commentLine, derivedJson: classified.derivedJson };
  });
}

// Whether a SCRIPT_REFERENCE file match ends at a real path boundary and, when
// inside a JS string/template literal, spans a complete whitelisted literal.
function matchScriptLiteral(text, match, literals) {
  const start = match.index;
  const end = match.index + match[0].length;
  const after = text[end];
  if (after && !/[\s'"`),;:\]}]/.test(after)) return { complete: false, derivedJson: true };
  if (literals !== null) {
    const litAtEnd = literals.find((lit) => lit.start < end && end <= lit.end);
    if (litAtEnd) {
      if (!litAtEnd.standalone) return { complete: false, derivedJson: true };
      const tail = text.slice(end, litAtEnd.end - 1);
      if (tail.length > 0 && !(tail === '\n' && text.slice(litAtEnd.start + 1, start).includes('//'))) return { complete: false, derivedJson: true };
      const litAtStart = literals.find((lit) => lit.start <= start && start < lit.end);
      if (litAtStart && litAtStart !== litAtEnd && !litAtStart.standalone) return { complete: false, derivedJson: true };
      return { complete: true, derivedJson: litAtEnd.derivedJson };
    }
    return { complete: true, derivedJson: false };
  }
  const sepStart = start + match[1].length;
  if (text[sepStart] !== '/') {
    const secondQuote = match[0].slice(match[1].length + 1).match(/['"`]/)?.[0];
    const complete = Boolean(secondQuote && after === secondQuote);
    return { complete, derivedJson: true };
  }
  let i = start - 1;
  while (i >= 0 && /[\w./-]/.test(text[i])) i--;
  if (i >= 0 && (text[i] === "'" || text[i] === '"' || text[i] === '`') && (i === 0 || text[i - 1] !== '\\')) {
    return { complete: after === text[i], derivedJson: true };
  }
  return { complete: true, derivedJson: true };
}

function resolveWorkspaceTarget(raw, baseDir, { root, nodeByPackageName, nodeSet }) {
  if (nodeByPackageName.has(raw)) return nodeByPackageName.get(raw);
  const unwrapped = raw.startsWith('{') && raw.endsWith('}') ? raw.slice(1, -1) : raw;
  if (unwrapped.includes('$') || unwrapped.includes('*')) return null;
  const normalized = unwrapped.replace(/^\.\//, '').replace(/\/+$/, '');
  if (nodeSet.has(normalized)) return normalized;
  const prefixNode = normalized.match(/^(?:apps|packages|exes)\/[^/]+/)?.[0];
  if (prefixNode && nodeSet.has(prefixNode)) return prefixNode;
  if (baseDir && !baseDir.includes('$')) {
    const rel = relative(root, resolve(root, baseDir, unwrapped)).split(sep).join('/').replace(/\/+$/, '');
    if (nodeSet.has(rel)) return rel;
    const relPrefix = rel.match(/^(?:apps|packages|exes)\/[^/]+/)?.[0];
    if (relPrefix && nodeSet.has(relPrefix)) return relPrefix;
  }
  return null;
}

const AMBIGUOUS_DIR = Symbol('ambiguous-dir');
const AMBIGUOUS_LINT_EXEC = /\b(?:eval|xargs)\b|\b(?:ba|da|z|k)?sh\b[^\n]*-[a-zA-Z]*c\b|\$\(|`/;

// Find the index of the `)` matching an opening `(` (such as `$(`),
// respecting single/double quotes, backslash escapes, backticks, and nested `$(...)`.
function findMatchingParen(text, openIndex) {
  let depth = 1;
  let quote = null;
  let inBacktick = false;
  let atWordStart = true;
  for (let i = openIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (quote === "'") {
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (ch === '\\') {
      if (text[i + 1] === '\n') {
        i++;
        continue;
      }
      if (text[i + 1] === '\r' && text[i + 2] === '\n') {
        i += 2;
        continue;
      }
      i++;
      atWordStart = false;
      continue;
    }
    if (quote === '"') {
      if (ch === '$' && text[i + 1] === '(') {
        const close = findMatchingParen(text, i + 1);
        if (close < 0) return -1;
        i = close;
        atWordStart = false;
        continue;
      }
      if (ch === '"') quote = null;
      atWordStart = false;
      continue;
    }
    if (inBacktick) {
      if (ch === '`') inBacktick = false;
      atWordStart = false;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      atWordStart = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      atWordStart = false;
      continue;
    }
    if (ch === '#' && atWordStart) {
      while (i < text.length && text[i] !== '\n') i++;
      atWordStart = true;
      continue;
    }
    if (ch === '(') {
      depth++;
      atWordStart = true;
    } else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
      atWordStart = true;
    } else {
      atWordStart = /[\s;|&]/.test(ch);
    }
  }
  return -1;
}

// Split a shell script into simple command tokens and subshell parens `(`, `)`,
// respecting quotes, backslash escapes/continuations, comments, backticks, and `$(...)`.
function splitShellCommands(script) {
  const tokens = [];
  let current = '';
  let quote = null;
  let inBacktick = false;
  let atWordStart = true;
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) tokens.push(trimmed);
    current = '';
    atWordStart = true;
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      atWordStart = false;
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') {
        i++;
        continue;
      }
      if (next === '\r' && script[i + 2] === '\n') {
        i += 2;
        continue;
      }
      if (next !== undefined) {
        current += ch + next;
        i++;
        atWordStart = false;
        continue;
      }
    }
    if (quote === '"') {
      if (ch === '$' && next === '(') {
        const close = findMatchingParen(script, i + 1);
        if (close >= 0) {
          current += script.slice(i, close + 1);
          i = close;
          atWordStart = false;
          continue;
        }
      }
      current += ch;
      if (ch === '"') quote = null;
      atWordStart = false;
      continue;
    }
    if (inBacktick) {
      current += ch;
      if (ch === '`') inBacktick = false;
      atWordStart = false;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      current += ch;
      atWordStart = false;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      atWordStart = false;
      continue;
    }
    if (ch === '#' && atWordStart) {
      while (i < script.length && script[i] !== '\n') i++;
      flush();
      continue;
    }
    if (ch === '$' && next === '(') {
      const close = findMatchingParen(script, i + 1);
      if (close >= 0) {
        current += script.slice(i, close + 1);
        i = close;
        atWordStart = false;
        continue;
      }
      current += '$(';
      i++;
      atWordStart = false;
      continue;
    }
    if (ch === '\n' || ch === ';') {
      flush();
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      flush();
      i++;
      continue;
    }
    if (ch === '&' || ch === '|') {
      flush();
      continue;
    }
    if (ch === '(' || ch === ')') {
      flush();
      tokens.push(ch);
      continue;
    }
    current += ch;
    atWordStart = /\s/.test(ch);
  }
  flush();
  return tokens;
}

// Workspace nodes whose `lint` script may be executed by any cross-workspace
// lint invocation (`pnpm --filter <pkg> lint`, `--filter=<pkg>`, `-r lint`,
// `--dir`, a CI step's `working-directory`, or `cd <dir> && pnpm lint`).
function lintTargetsInCommands(commands, context) {
  const { root, manifests } = context;
  const targets = new Set();
  const allLintNodes = () => [...manifests.entries()].filter(([, manifest]) => typeof manifest?.scripts?.lint === 'string').map(([node]) => node);
  const addAll = () => {
    for (const node of allLintNodes()) targets.add(node);
  };
  for (const entry of commands) {
    const rawCmd = typeof entry === 'string' ? entry : entry.cmd;
    const workingDir = typeof entry === 'string' ? null : entry.workingDir ?? null;
    const baseDir = typeof entry === 'string' ? '.' : entry.baseDir ?? workingDir ?? '.';
    if (INDEPENDENT_LINT_SCRIPT.test(rawCmd.trim())) continue;
    if (!/\blint\b/.test(rawCmd)) continue;
    const trimmedWorkingDir = typeof workingDir === 'string' ? workingDir.trim() : '';
    const workingDirIsUncertain = Boolean(trimmedWorkingDir) && isUncertainCdTarget(trimmedWorkingDir);
    const resolvedWorkingDir = trimmedWorkingDir && !workingDirIsUncertain
      ? (relative(root, resolve(root, trimmedWorkingDir)).split(sep).join('/').replace(/\/+$/, '') || '.')
      : '';
    const nonRootWorkingDir = workingDirIsUncertain || Boolean(resolvedWorkingDir && resolvedWorkingDir !== '.');
    // Possible directories tracked conservatively across segments: `cwdDirs`
    // keeps `.` and all reached directories so returning to the repository root
    // (`cd ../..`) resolves subsequent relative `cd` calls; `activeDirs` tracks
    // non-root directories entered via `working-directory` or `cd`.
    const initialWorkingDir = workingDirIsUncertain ? AMBIGUOUS_DIR : resolvedWorkingDir;
    let cwdDirs = new Set([nonRootWorkingDir ? initialWorkingDir : baseDir]);
    let activeDirs = new Set(nonRootWorkingDir ? [initialWorkingDir] : []);
    const dirStack = [];
    for (const token of splitShellCommands(rawCmd)) {
      if (token === '(') {
        dirStack.push({ cwd: new Set(cwdDirs), active: new Set(activeDirs) });
        continue;
      }
      if (token === ')') {
        if (dirStack.length > 0) {
          const prev = dirStack.pop();
          cwdDirs = prev.cwd;
          activeDirs = prev.active;
        }
        continue;
      }
      if (/\bpopd\b/.test(token)) {
        cwdDirs = new Set([...cwdDirs, AMBIGUOUS_DIR]);
        activeDirs = new Set([...activeDirs, AMBIGUOUS_DIR]);
      }
      const cdMatches = extractCdTargets(token);
      if (cdMatches.length > 0) {
        const nextCwd = new Set(cwdDirs);
        const nextActive = new Set(activeDirs);
        for (const dir of cdMatches) {
          for (const from of cwdDirs) {
            if (from === AMBIGUOUS_DIR || isUncertainCdTarget(dir)) {
              nextCwd.add(AMBIGUOUS_DIR);
              nextActive.add(AMBIGUOUS_DIR);
            } else {
              const rel = relative(root, resolve(root, from, dir)).split(sep).join('/').replace(/\/+$/, '') || '.';
              if (!rel.startsWith('..')) nextCwd.add(rel);
              if (rel !== '.' && !rel.startsWith('..')) nextActive.add(rel);
            }
          }
        }
        cwdDirs = nextCwd;
        activeDirs = nextActive;
      }
      if (!/\blint\b/.test(token)) continue;
      if (AMBIGUOUS_LINT_EXEC.test(token)) {
        addAll();
        continue;
      }
      if (!/\b(?:pnpm|npm|yarn)\b/.test(token)) continue;
      const isPnpm = /(?:^|[\s;|&(/])pnpm(?:\.(?:cjs|mjs|js|cmd|exe))?(?:$|[\s;|&)])/.test(token);
      // `-w` means `--workspace-root` in pnpm, but `--workspace <pkg>` in npm.
      const hasRootFlag = /(?:^|\s)--workspace-root(?:\s|$)/.test(token) || (isPnpm && /(?:^|\s)-w(?:\s|$)/.test(token));
      const hasCrossFlag = CROSS_WORKSPACE_FLAG.test(token);
      // `-w` / `--workspace-root` overrides `--dir` / `-C` / `--prefix` / `--cwd`
      // in pnpm; only explicit filter/recursive/workspace-list flags still target
      // workspace members alongside `-w`.
      const hasWorkspaceSelectorFlag = /(?:^|[\s;|&(])(?:--filter-prod|--filter|-F|-r|--recursive|--workspace(?:=|\s)|-ws|--workspaces)/.test(token);
      if (!hasCrossFlag && activeDirs.size === 0) continue;
      if (hasRootFlag && !hasWorkspaceSelectorFlag) continue;
      const recursive = /(?:^|\s)(?:-r|--recursive)(?:\s|$)/.test(token);
      const rawFilters = [
        ...[...token.matchAll(FILTER_ARG)].map(([, flag, target]) => ({ flag, target })),
        ...(!isPnpm ? [...token.matchAll(NPM_SHORT_WORKSPACE_ARG)].map(([, flag, target]) => ({ flag, target })) : []),
      ];
      const filters = rawFilters.filter(({ flag }) => !hasRootFlag || flag === '--filter-prod' || flag === '--filter' || flag === '-F');
      if (!recursive && filters.length > 0) {
        let allResolved = true;
        const resolveBases = new Set([...(baseDir !== '.' ? [baseDir] : []), ...(activeDirs.size > 0 ? activeDirs : cwdDirs)]);
        for (const { flag, target: filter } of filters) {
          const isFilterFlag = flag === '--filter-prod' || flag === '--filter' || flag === '-F';
          const isExactRootName =
            isFilterFlag &&
            Boolean(context.rootPackageName) &&
            filter === context.rootPackageName;
          if (isExactRootName) continue;
          const unwrapped = filter.startsWith('{') && filter.endsWith('}') ? filter.slice(1, -1) : filter;
          const hasGraphOrGlob = filter.includes('*') || /^\.{2,3}\^?|\^?\.{2,3}$/.test(filter);
          let resolvedAny = false;
          for (const from of resolveBases) {
            if (from === AMBIGUOUS_DIR) {
              allResolved = false;
              continue;
            }
            const workspaceNode = resolveWorkspaceTarget(filter, from, context);
            if (workspaceNode) {
              targets.add(workspaceNode);
              resolvedAny = true;
            } else if (!hasGraphOrGlob && !isUncertainCdTarget(unwrapped)) {
              const rel = relative(root, resolve(root, from, unwrapped)).split(sep).join('/').replace(/\/+$/, '');
              if (!rel || rel === '.') resolvedAny = true;
              else allResolved = false;
            } else {
              allResolved = false;
            }
          }
          if (!resolvedAny) allResolved = false;
        }
        if (!allResolved) addAll();
      } else if (!hasCrossFlag && activeDirs.size > 0) {
        let allResolved = true;
        for (const dir of activeDirs) {
          if (dir === AMBIGUOUS_DIR) {
            allResolved = false;
            continue;
          }
          const workspaceNode = resolveWorkspaceTarget(dir, '.', context);
          if (workspaceNode) targets.add(workspaceNode);
          else allResolved = false;
        }
        if (!allResolved) addAll();
      } else {
        addAll();
      }
    }
  }
  return targets;
}

const PNPM_VALUE_OPTIONS = new Set([
  '--reporter', '--loglevel', '--config', '--store-dir', '--virtual-store-dir', '--modules-dir',
  '--color', '--workspace-concurrency', '--network-concurrency', '--fetch-retries',
  '--child-concurrency', '--filter', '--filter-prod', '-F', '--dir', '-C', '--prefix', '--cwd',
  '--stream-prefix', '--test-pattern', '--changed-files-ignore-pattern',
]);

function tokenizeShellWords(segment) {
  const words = [];
  let current = '';
  let quote = null;
  let hasToken = false;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    const next = segment[i + 1];
    if (quote === "'") {
      if (ch === "'") quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === '\\' && next !== undefined) {
      if (next === '\n') {
        i++;
        continue;
      }
      if (next === '\r' && segment[i + 2] === '\n') {
        i += 2;
        continue;
      }
      current += next;
      hasToken = true;
      i++;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else current += ch;
      hasToken = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (hasToken) {
        words.push(current);
        current = '';
        hasToken = false;
      }
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (hasToken) words.push(current);
  return words;
}

const SHELL_BIN = /^(?:\/[\w/.-]*\/)?(?:ba|da|z|k)?sh$/;
const PNPM_BIN = /(?:^|\/)pnpm(?:\.(?:cjs|mjs|js|cmd|exe))?$/;

function isUncertainCdTarget(dir) {
  return dir === '-' || dir === '~' || dir.startsWith('~/') || dir.includes('$') || dir.includes('*') || dir.includes('`');
}

// Whether a CI `working-directory` statically resolves to a directory other
// than the repository root. Unresolved/dynamic paths (such as
// `${{ github.workspace }}`) and normalized root paths (`././`) return false so
// root-script discovery remains conservative.
function isStaticNonRootDir(workingDir, root) {
  const trimmed = typeof workingDir === 'string' ? workingDir.trim() : '';
  if (!trimmed || !root || isUncertainCdTarget(trimmed)) return false;
  const rel = relative(root, resolve(root, trimmed)).split(sep).join('/').replace(/\/+$/, '');
  return Boolean(rel && rel !== '.');
}

// Extract destination arguments from `cd` / `pushd` invocations in a shell
// segment, skipping shell options such as `-L`, `-P`, `-e`, and `--`.
function extractCdTargets(segment) {
  const words = tokenizeShellWords(segment);
  if (words[0] === 'echo' || words[0] === 'printf') return [];
  const targets = [];
  for (let start = 0; start < words.length; start++) {
    if (words[start] !== 'cd' && words[start] !== 'pushd') continue;
    let idx = start + 1;
    while (idx < words.length) {
      if (words[idx] === '--') {
        idx++;
        break;
      }
      if (/^-[LPe@n]+$/.test(words[idx])) {
        idx++;
        continue;
      }
      break;
    }
    targets.push(idx < words.length ? words[idx] : '~');
    start = idx;
  }
  return targets;
}

function extractCommandSubstitutions(segment) {
  const inner = [];
  let inSingle = false;
  let inDouble = false;
  let atWordStart = true;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (inSingle) {
      if (ch === "'") inSingle = false;
      atWordStart = false;
      continue;
    }
    if (ch === '\\') {
      if (segment[i + 1] === '\n') {
        i++;
        continue;
      }
      if (segment[i + 1] === '\r' && segment[i + 2] === '\n') {
        i += 2;
        continue;
      }
      i++;
      atWordStart = false;
      continue;
    }
    if (ch === '"') {
      inDouble = !inDouble;
      atWordStart = false;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = true;
      atWordStart = false;
      continue;
    }
    if (!inDouble && ch === '#' && atWordStart) {
      while (i < segment.length && segment[i] !== '\n') i++;
      atWordStart = true;
      continue;
    }
    if (ch === '$' && segment[i + 1] === '(') {
      const close = findMatchingParen(segment, i + 1);
      if (close > i + 2) {
        inner.push(segment.slice(i + 2, close));
        i = close;
      }
      atWordStart = false;
    } else if (ch === '`') {
      const start = i + 1;
      let end = -1;
      for (let j = start; j < segment.length; j++) {
        if (segment[j] === '\\') {
          j++;
          continue;
        }
        if (segment[j] === '`') {
          end = j;
          break;
        }
      }
      if (end > start) {
        inner.push(segment.slice(start, end));
        i = end;
      }
      atWordStart = false;
    } else if (!inDouble) {
      atWordStart = /[\s;|&(]/.test(ch);
    }
  }
  return inner;
}

function filterTargetsRoot(filterVal, cwdDirs, root, rootPackageName) {
  if (!filterVal || filterVal.startsWith('!')) return false;
  if (filterVal.includes('${{')) return false;
  // Strip pnpm graph selectors (`...pkg`, `pkg...`, `pkg^...`, `[since]`).
  const core = filterVal.replace(/^\.{2,3}\^?|\^?\.{2,3}$/g, '').replace(/\[[^\]]*\]$/, '');
  if (!core) return false;
  if (rootPackageName && core === rootPackageName) return true;
  const pathCandidate = core.startsWith('{') && core.endsWith('}') ? core.slice(1, -1) : core;
  if (root && !isUncertainCdTarget(pathCandidate) && (core.startsWith('{') || pathCandidate.startsWith('.') || pathCandidate.includes('/'))) {
    for (const from of cwdDirs) {
      if (from.includes('$')) return true;
      const rel = relative(root, resolve(root, from, pathCandidate)).split(sep).join('/').replace(/\/+$/, '');
      if (!rel || rel === '.') return true;
    }
  }
  if (core.includes('*') && rootPackageName) {
    const escaped = core.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (new RegExp(`^${escaped}$`).test(rootPackageName)) return true;
  }
  return false;
}

// Extract root package.json script names invoked via `pnpm`, allowing shell
// wrappers (`if`, `elif`, `while`, `until`, `timeout`, `bash -c`, `eval`,
// `$(...)`, backticks), `cd` back to the repository root, and pnpm flags
// (`--silent`, `--if-present`, `-w`, `--workspace-root`, `--dir <root>`,
// `--filter <root>`) in any order before or after `run`.
function extractPnpmRootScripts(command, { requireRootFlag = false, baseDir = '.', root = null, rootPackageName = null, depth = 0 } = {}) {
  const scripts = [];
  if (depth > 4) return scripts;
  let cwdDirs = new Set([baseDir]);
  const dirStack = [];
  for (const token of splitShellCommands(command)) {
    if (token === '(') {
      dirStack.push(new Set(cwdDirs));
      continue;
    }
    if (token === ')') {
      if (dirStack.length > 0) cwdDirs = dirStack.pop();
      continue;
    }
    if (/\bpopd\b/.test(token)) {
      cwdDirs = new Set([...cwdDirs, '.']);
    }
    const cdMatches = extractCdTargets(token);
    if (cdMatches.length > 0) {
      const nextCwd = new Set(cwdDirs);
      for (const dir of cdMatches) {
        if (isUncertainCdTarget(dir)) {
          // An uncertain `cd` (such as `cd "$GITHUB_WORKSPACE"` or `cd -`) may
          // land at the repository root, so retain `.` conservatively.
          nextCwd.add('.');
          continue;
        }
        if (!root) continue;
        for (const from of cwdDirs) {
          if (from.includes('$')) continue;
          const rel = relative(root, resolve(root, from, dir)).split(sep).join('/').replace(/\/+$/, '') || '.';
          if (!rel.startsWith('..')) nextCwd.add(rel);
        }
      }
      cwdDirs = nextCwd;
    }
    const mayRunAtRoot = !requireRootFlag || cwdDirs.has('.');
    for (const subst of extractCommandSubstitutions(token)) {
      for (const from of cwdDirs) {
        scripts.push(...extractPnpmRootScripts(subst, { requireRootFlag: !mayRunAtRoot, baseDir: from, root, rootPackageName, depth: depth + 1 }));
      }
    }
    const words = tokenizeShellWords(token);
    if (words[0] === 'echo' || words[0] === 'printf') continue;
    for (let start = 0; start < words.length; start++) {
      if (words[start] === 'eval' && start + 1 < words.length) {
        const body = words.slice(start + 1).join(' ');
        for (const from of cwdDirs) {
          scripts.push(...extractPnpmRootScripts(body, { requireRootFlag: !mayRunAtRoot, baseDir: from, root, rootPackageName, depth: depth + 1 }));
        }
        break;
      }
      if (SHELL_BIN.test(words[start])) {
        for (let k = start + 1; k < words.length; k++) {
          if (words[k] === '--') break;
          if (/^-[a-zA-Z]*c$/.test(words[k]) && k + 1 < words.length) {
            for (const from of cwdDirs) {
              scripts.push(...extractPnpmRootScripts(words[k + 1], { requireRootFlag: !mayRunAtRoot, baseDir: from, root, rootPackageName, depth: depth + 1 }));
            }
            break;
          }
          if (words[k] === '-o' && k + 1 < words.length) {
            k++;
            continue;
          }
          if (!words[k].startsWith('-')) break;
        }
        continue;
      }
      if (!PNPM_BIN.test(words[start])) continue;
      let idx = start + 1;
      let hasRootFlag = false;
      let hasNonRootFilter = false;
      let hasNonRootDir = false;
      let seenRun = false;
      for (; idx < words.length; idx++) {
        const word = words[idx];
        if (word === '--') break;
        if (word === '-w' || word === '--workspace-root') {
          hasRootFlag = true;
          continue;
        }
        if (
          word === '--filter' || word === '--filter-prod' || word === '-F' ||
          word.startsWith('--filter=') || word.startsWith('--filter-prod=') || word.startsWith('-F=')
        ) {
          const filterVal = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++idx];
          if (filterTargetsRoot(filterVal, cwdDirs, root, rootPackageName)) hasRootFlag = true;
          else hasNonRootFilter = true;
          continue;
        }
        if (
          word === '--dir' || word === '-C' || word === '--prefix' ||
          word.startsWith('--dir=') || word.startsWith('-C=') || word.startsWith('--prefix=')
        ) {
          const dirVal = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++idx];
          if (!dirVal || !root || isUncertainCdTarget(dirVal)) {
            // A dynamic directory (such as `--dir "$GITHUB_WORKSPACE"`) may target
            // the repository root, so retain the root script conservatively.
            hasRootFlag = true;
          } else {
            let hitsRoot = false;
            for (const from of cwdDirs) {
              if (from.includes('$')) {
                hitsRoot = true;
                continue;
              }
              const rel = relative(root, resolve(root, from, dirVal)).split(sep).join('/').replace(/\/+$/, '');
              if (!rel || rel === '.') hitsRoot = true;
            }
            if (hitsRoot) hasRootFlag = true;
            else hasNonRootDir = true;
          }
          continue;
        }
        if (word.startsWith('-')) {
          if (PNPM_VALUE_OPTIONS.has(word) && idx + 1 < words.length) idx++;
          continue;
        }
        if (!seenRun && (word === 'run' || word === 'run-script')) {
          seenRun = true;
          continue;
        }
        if ((hasRootFlag || (!hasNonRootFilter && !hasNonRootDir && mayRunAtRoot)) && /^[A-Za-z0-9_@][\w.:/@-]*$/.test(word)) {
          scripts.push(word);
        }
        break;
      }
      start = idx;
    }
  }
  return scripts;
}

// Expand CI commands through root package.json scripts without stripping
// `pnpm --filter`, so workspace script invocations (such as `--filter @nd/n4 lint`)
// remain visible before deciding whether standalone lint scripts can be omitted.
function expandedCommandTexts(commands, rootScripts, root = null, rootPackageName = null) {
  const entries = [];
  const pending = commands.map((entry) => (typeof entry === 'string' ? { cmd: entry, workingDir: null } : entry));
  const expanded = new Set();
  while (pending.length) {
    const current = pending.pop();
    entries.push(current);
    const nonRootWorkingDir = isStaticNonRootDir(current.workingDir, root);
    for (const script of extractPnpmRootScripts(current.cmd, { requireRootFlag: nonRootWorkingDir, baseDir: current.workingDir ?? '.', root, rootPackageName })) {
      if (!expanded.has(script)) {
        expanded.add(script);
        if (rootScripts[script]) pending.push({ cmd: rootScripts[script], workingDir: null });
      }
    }
  }
  return entries;
}

const COMMAND_PACKAGE_TESTS = /(?:^|[\s'"`(=])(?:\.\/)?(packages\/[\w.-]+\/tests?)(?:\/|$)/gm;

// Expand root package.json scripts explicitly invoked from a workspace manifest
// via `pnpm -w [run] <script>`, `pnpm --workspace-root [run] <script>`, or
// `pnpm --dir <root> [run] <script>`, returning expanded commands and names.
function expandedRootScriptsFromWorkspace(commands, rootScripts, { baseDir = '.', root = null, rootPackageName = null } = {}) {
  const names = new Set();
  const texts = [];
  const pending = [];
  for (const cmd of commands) {
    for (const script of extractPnpmRootScripts(cmd, { requireRootFlag: true, baseDir, root, rootPackageName })) {
      if (!names.has(script)) {
        names.add(script);
        if (rootScripts[script]) pending.push(rootScripts[script]);
      }
    }
  }
  while (pending.length) {
    const command = pending.pop();
    texts.push(command);
    for (const script of extractPnpmRootScripts(command, { root, rootPackageName })) {
      if (!names.has(script)) {
        names.add(script);
        if (rootScripts[script]) pending.push(rootScripts[script]);
      }
    }
  }
  return { texts, names };
}

// Omit a workspace package.json's standalone `lint` script (`node ../../scripts/lint.mjs`)
// before scanning text references, as long as neither CI nor any other script calls `lint`.
// Direct imports/references in code or build scripts remain untouched.
function manifestScanText(text, manifest, stripStandaloneLint) {
  if (!stripStandaloneLint) return text;
  const lintCmd = manifest?.scripts?.lint;
  if (typeof lintCmd !== 'string' || !INDEPENDENT_LINT_SCRIPT.test(lintCmd.trim())) return text;
  if (Object.entries(manifest.scripts).some(([name, cmd]) => name !== 'lint' && /\blint\b/.test(String(cmd)))) return text;
  const scripts = { ...manifest.scripts };
  delete scripts.lint;
  return JSON.stringify({ ...manifest, scripts }, null, 2);
}

async function readPackageJson(dir) {
  try {
    return JSON.parse(await readFile(join(dir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
}

function nodeOf(root, path) {
  const [top, name] = relative(root, path).split(/[\\/]/);
  return TRAVERSABLE_WORKSPACE_GROUPS.has(top) && name ? `${top}/${name}` : null;
}

export class WorkspaceGraphConfigurationError extends Error {}

export async function loadConservativeWorkspaceGraph(root) {
  const nodes = (await Promise.all(TOP_LEVEL.map(async (top) => (await listDirs(join(root, top))).map((name) => `${top}/${name}`)))).flat();
  const nodeSet = new Set(nodes);
  const manifests = new Map(await Promise.all(nodes.map(async (node) => [node, await readPackageJson(join(root, node))])));
  const nodeByPackageName = new Map([...manifests].filter(([, manifest]) => manifest?.name).map(([node, manifest]) => [manifest.name, node]));

  const ci = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const rootScripts = rootManifest.scripts ?? {};
  const rootPackageName = typeof rootManifest.name === 'string' ? rootManifest.name : null;
  const workflowWorkingDir = ci?.defaults?.run?.['working-directory'] ?? null;
  const rawRuns = (names) => names.flatMap((name) => {
    const job = ci?.jobs?.[name];
    const steps = job?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new WorkspaceGraphConfigurationError(`ci.yml job ${name} has no step list; update the workspace graph's CI entry points`);
    }
    const jobWorkingDir = job?.defaults?.run?.['working-directory'] ?? workflowWorkingDir;
    return steps.map((step) => ({
      cmd: String(step?.run ?? ''),
      workingDir: step?.['working-directory'] ?? jobWorkingDir ?? null,
    }));
  });
  const rawEntries = [
    [SITE, rawRuns(siteJobNames(ci))],
    [CATALOG, rawRuns(CATALOG_JOBS)],
  ];
  const expandedByEntry = new Map(rawEntries.map(([node, raw]) => [node, expandedCommandTexts(raw, rootScripts, root, rootPackageName)]));
  const workspaceRootScriptInfo = new Map(nodes.map((node) => {
    const allScripts = Object.values(manifests.get(node)?.scripts ?? {}).map(String);
    return [node, expandedRootScriptsFromWorkspace(allScripts, rootScripts, { baseDir: node, root, rootPackageName })];
  }));
  const workspaceRootScripts = new Map([...workspaceRootScriptInfo].map(([node, { names }]) => [node, names]));
  const workspaceExpandedScripts = new Map(nodes.map((node) => {
    const allScripts = Object.values(manifests.get(node)?.scripts ?? {}).map((cmd) => ({ cmd: String(cmd), baseDir: node }));
    const rootExpanded = (workspaceRootScriptInfo.get(node)?.texts ?? []).map((cmd) => ({ cmd, baseDir: '.' }));
    return [node, [...allScripts, ...rootExpanded]];
  }));
  const lintTargetContext = { root, rootPackageName, nodeByPackageName, nodeSet, manifests };
  const lintInvokedNodes = new Set();
  for (const [, cmds] of expandedByEntry) {
    for (const target of lintTargetsInCommands(cmds, lintTargetContext)) lintInvokedNodes.add(target);
  }
  for (const [, cmds] of workspaceExpandedScripts) {
    for (const target of lintTargetsInCommands(cmds, lintTargetContext)) lintInvokedNodes.add(target);
  }

  const edges = new Map();
  const pendingRootFiles = [];
  const derivedJsonFiles = new Set();
  const scannedDerivedJson = new Set();
  // App id -> the paths in other app directories its code names.
  const appReads = new Map();
  for (const node of nodes) {
    const uses = new Set();
    const manifest = manifests.get(node);
    for (const field of DEPENDENCY_FIELDS) {
      for (const [name, spec] of Object.entries(manifest?.[field] ?? {})) {
        const workspaceNode = String(spec).startsWith('workspace:') && nodeByPackageName.get(name);
        if (workspaceNode && TRAVERSABLE_WORKSPACE_GROUPS.has(workspaceNode.split('/')[0])) uses.add(workspaceNode);
        if (String(spec).startsWith('file:')) {
          const target = nodeOf(root, resolve(root, node, String(spec).slice('file:'.length)));
          if (target) uses.add(target);
        }
      }
    }
    const expandedScripts = workspaceExpandedScripts.get(node) ?? [];
    for (const lintTarget of lintTargetsInCommands(expandedScripts, lintTargetContext)) {
      uses.add(lintTarget);
    }
    for (const cmd of workspaceRootScriptInfo.get(node)?.texts ?? []) {
      for (const match of cmd.matchAll(ROOT_NAMED)) {
        if (match[1]) {
          uses.add(match[1]);
          pendingRootFiles.push(match[1]);
        }
      }
      for (const [, rootFile] of cmd.matchAll(ROOT_PATH)) {
        uses.add(rootFile);
        pendingRootFiles.push(rootFile);
      }
      for (const [, tests] of cmd.matchAll(COMMAND_PACKAGE_TESTS)) uses.add(tests);
      for (const [, tests] of cmd.matchAll(PACKAGE_TESTS)) uses.add(tests);
      for (const [, document] of cmd.matchAll(DOCUMENT_REFERENCE)) uses.add(document);
      for (const [, top, name, inner] of cmd.matchAll(SCRIPT_REFERENCE)) {
        if (!nodeSet.has(`${top}/${name}`)) continue;
        uses.add(`${top}/${name}`);
        const target = inner && `${top}/${name}${inner}`;
        if (target && await isRegularUnlinkedFile(root, target)) {
          uses.add(target);
          pendingRootFiles.push(target);
        }
      }
    }
    const manifestPath = join(root, node, 'package.json');
    for await (const file of textFiles(join(root, node))) {
      if ((await stat(file)).size > MAX_TEXT_BYTES) continue;
      const rawText = await readFile(file, 'utf8');
      const text = file === manifestPath ? manifestScanText(rawText, manifest, !lintInvokedNodes.has(node)) : rawText;
      for (const [, top, name] of text.matchAll(REFERENCE)) {
        if (nodeSet.has(`${top}/${name}`)) uses.add(`${top}/${name}`);
      }
      for (const [, tests] of text.matchAll(PACKAGE_TESTS)) uses.add(tests);
      for (const [, document] of text.matchAll(DOCUMENT_REFERENCE)) uses.add(document);
      for (const [, rootFile] of text.matchAll(ROOT_PATH)) {
        uses.add(rootFile);
        pendingRootFiles.push(rootFile);
      }
      if (node.startsWith('apps/') && APP_CODE.test(file)) {
        for (const [, , path] of text.matchAll(RELATIVE_PATH)) {
          const target = relative(root, resolve(dirname(file), path)).split(sep).join('/');
          const owner = target.match(/^apps\/[^/]+/)?.[0];
          if (owner && owner !== node && nodeSet.has(owner)) appReads.set(node, new Set([...(appReads.get(node) ?? []), target]));
        }
      }
    }
    uses.delete(node);
    edges.set(node, uses);
  }

  // Root tool configs (e2e.config.ts, tsconfig.agentic.json) are read implicitly
  // by the site jobs' commands, so the site build follows them too.
  const rootConfigs = (await readdir(root)).filter((name) => /^(?:[\w-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json)$/.test(name) && !INDEPENDENT_CONFIG.test(name));
  const rootScriptsRun = new Map();
  for (const [node, commands] of rawEntries) {
    const { named, expanded } = namedByCommands(commands, rootScripts, root, rootPackageName);
    if (node === SITE) for (const config of rootConfigs) named.add(config);
    for (const lintTarget of lintTargetsInCommands(expandedByEntry.get(node) ?? [], lintTargetContext)) {
      named.add(lintTarget);
    }
    edges.set(node, named);
    rootScriptsRun.set(node, expanded);
    pendingRootFiles.push(...named);
  }

  while (pendingRootFiles.length) {
    const file = pendingRootFiles.pop();
    const isJsonFile = /^(?:packages|exes)\/.*\.json$/.test(file);
    const derived = isJsonFile && derivedJsonFiles.has(file);
    if (edges.has(file) && (!derived || scannedDerivedJson.has(file))) continue;
    const uses = edges.get(file) ?? new Set();
    edges.set(file, uses);
    if (isJsonFile) {
      if (derived) scannedDerivedJson.add(file);
      const jsonText = await readFile(join(root, file), 'utf8').catch(() => null);
      if (jsonText !== null) {
        for (const match of jsonText.matchAll(SCRIPT_REFERENCE)) {
          const [, top, name, inner] = match;
          if (!nodeSet.has(`${top}/${name}`)) continue;
          const prev = jsonText[match.index - 1];
          const next = jsonText[match.index + match[0].length];
          const completeJsonString = (prev === '"' || (prev === '/' && jsonText.slice(match.index - 3, match.index) === '"./')) && next === '"';
          const target = inner && completeJsonString && `${top}/${name}${inner}`;
          if (target && await isRegularUnlinkedFile(root, target)) {
            uses.add(target);
            if (derived) {
              uses.add(`${top}/${name}`);
              derivedJsonFiles.add(target);
            }
            pendingRootFiles.push(target);
          } else {
            uses.add(`${top}/${name}`);
          }
        }
        for (const [, path, dir, name] of jsonText.matchAll(ROOT_NAMED)) {
          const target = path ?? `${dir}/${name}`;
          if ((ROOT_DIRS.some((rootDir) => target.startsWith(rootDir)) || ROOT_CONFIG.test(target)) && target !== file) {
            uses.add(target);
            pendingRootFiles.push(target);
          }
        }
      }
      continue;
    }
    if (!SOURCE_FILE.test(file)) continue;
    const source = await readFile(join(root, file), 'utf8').catch(() => null);
    if (source === null) continue;
    const text = withoutLineComments(source, file);
    const literals = collectScriptStringLiterals(text, file);
    for (const match of text.matchAll(SCRIPT_REFERENCE)) {
      const [, top, name, inner] = match;
      if (!nodeSet.has(`${top}/${name}`)) continue;
      const literalMatch = inner ? matchScriptLiteral(text, match, literals) : { complete: false, derivedJson: true };
      const target = literalMatch.complete && `${top}/${name}${inner}`;
      if (target && await isRegularUnlinkedFile(root, target)) {
        uses.add(target);
        if (literalMatch.derivedJson && target.endsWith('.json')) derivedJsonFiles.add(target);
        pendingRootFiles.push(target);
      } else {
        uses.add(`${top}/${name}`);
        const exactJson = inner?.endsWith('.json') && `${top}/${name}${inner}`;
        if (exactJson && await isRegularUnlinkedFile(root, exactJson)) {
          uses.add(exactJson);
          derivedJsonFiles.add(exactJson);
          pendingRootFiles.push(exactJson);
        }
      }
    }
    for (const [, name] of text.matchAll(BARE_IMPORT)) {
      if (nodeByPackageName.has(name)) uses.add(nodeByPackageName.get(name));
    }
    const imports = [...text.matchAll(ROOT_IMPORT)].map(([, path]) => relative(root, resolve(root, dirname(file), path)).split(sep).join('/'));
    const named = [...text.matchAll(ROOT_NAMED)].map(([, path, dir, name]) => path ?? `${dir}/${name}`);
    for (const [, directory] of text.matchAll(ROOT_GLOB)) {
      if (!await exists(join(root, directory))) continue;
      for await (const path of textFiles(join(root, directory))) named.push(relative(root, path).split(sep).join('/'));
    }
    for (const target of [...imports, ...named]) {
      if ((ROOT_DIRS.some((dir) => target.startsWith(dir)) || ROOT_CONFIG.test(target)) && target !== file) {
        uses.add(target);
        pendingRootFiles.push(target);
      }
    }
  }
  // `moduleUsers(path)`: the nodes that load one module of the shared component
  // package, or null for a file the planner ties to the whole package.
  // `appReaders(path)`: the app ids whose code names `path`, or a directory
  // holding it, in another app's directory. `appsNaming(identifier)`: the app
  // ids whose code names `identifier`, read on first use.
  let moduleUsers;
  // The root package.json scripts each ci.yml job runs, directly or through
  // other scripts (`pnpm <script>`; a package's own scripts are not root ones).
  const jobScripts = new Map(Object.entries(ci?.jobs ?? {}).map(([id, job]) => {
    const jobWorkingDir = job?.defaults?.run?.['working-directory'] ?? workflowWorkingDir;
    return [id, namedByCommands(
      (Array.isArray(job?.steps) ? job.steps : []).map((step) => ({
        cmd: String(step?.run ?? ''),
        workingDir: step?.['working-directory'] ?? jobWorkingDir ?? null,
      })),
      rootScripts,
      root,
      rootPackageName,
    ).expanded];
  }));
  const naming = new Map();
  const graph = {
    nodes: Object.freeze(nodes),
    edges,
    rootScriptsRun,
    jobScripts,
    workspaceRootScripts,
    moduleUsers: (path) => (moduleUsers ??= sharedModuleUsers(root, graph))(path),
    appReaders: (path) => [...appReads]
      .filter(([, targets]) => [...targets].some((target) => path === target || path.startsWith(`${target}/`)))
      .map(([node]) => node.slice('apps/'.length)),
    appsNaming: (identifier) => {
      if (!naming.has(identifier)) naming.set(identifier, appsNamingIdentifier(root, nodes, identifier));
      return naming.get(identifier);
    },
  };
  return Object.freeze(graph);
}

function appsNamingIdentifier(root, nodes, identifier) {
  const word = new RegExp(String.raw`\b${identifier}\b`);
  const names = (dir) => readdirSync(dir, { withFileTypes: true }).some((entry) => {
    if (entry.isDirectory()) return !SKIPPED_DIRS.has(entry.name) && names(join(dir, entry.name));
    return entry.isFile() && APP_CODE.test(entry.name) && word.test(readFileSync(join(dir, entry.name), 'utf8'));
  });
  return nodes.filter((node) => node.startsWith('apps/') && names(join(root, node))).map((node) => node.slice('apps/'.length));
}

// Every directory or root file `node` uses, directly or through others.
export function reachableFrom(graph, node) {
  const seen = new Set([node]);
  const pending = [node];
  while (pending.length) {
    for (const next of graph.edges.get(pending.pop()) ?? []) {
      if (!seen.has(next)) {
        seen.add(next);
        pending.push(next);
      }
    }
  }
  return seen;
}
