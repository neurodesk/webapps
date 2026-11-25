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
const ROOT_SCRIPT_CALL = /\bpnpm\s+(?:(?:-w|--workspace-root)\s+)?(?:run\s+)?['"]?([A-Za-z0-9_@][\w.:/@-]*)['"]?/g;
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
function namedByCommands(commands, rootScripts) {
  const named = new Set();
  const pending = [...commands];
  const expanded = new Set();
  while (pending.length) {
    const command = pending.pop();
    for (const match of command.matchAll(ROOT_NAMED)) if (match[1]) named.add(match[1]);
    for (const [, rootFile] of command.matchAll(ROOT_PATH)) named.add(rootFile);
    for (const [, script] of command.matchAll(ROOT_SCRIPT_CALL)) {
      if (!expanded.has(script)) {
        expanded.add(script);
        if (rootScripts[script]) pending.push(rootScripts[script]);
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
const FILTER_ARG = /(?:^|[\s;|&(])(?:--filter|-F|--dir|-C|--prefix|--cwd)(?:=|\s+)['"]?([^\s'"]+)['"]?/g;
const CROSS_WORKSPACE_FLAG = /(?:^|[\s;|&(])(?:--filter|-F|--dir|-C|--prefix|--cwd|-r|--recursive|--workspace|-w|--workspaces)(?:=|\s|$)/;
const SHELL_CD_TARGET = /(?:^|[\s;|&(])(?:cd|pushd)\s+['"]?([^\s'"&;|()]+)['"]?/g;

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
  if (raw.includes('$') || raw.includes('*')) return null;
  const normalized = raw.replace(/^\.\//, '').replace(/\/+$/, '');
  if (nodeSet.has(normalized)) return normalized;
  const prefixNode = normalized.match(/^(?:apps|packages|exes)\/[^/]+/)?.[0];
  if (prefixNode && nodeSet.has(prefixNode)) return prefixNode;
  if (baseDir && !baseDir.includes('$')) {
    const rel = relative(root, resolve(root, baseDir, raw)).split(sep).join('/').replace(/\/+$/, '');
    if (nodeSet.has(rel)) return rel;
    const relPrefix = rel.match(/^(?:apps|packages|exes)\/[^/]+/)?.[0];
    if (relPrefix && nodeSet.has(relPrefix)) return relPrefix;
  }
  return null;
}

const AMBIGUOUS_DIR = Symbol('ambiguous-dir');
const AMBIGUOUS_LINT_EXEC = /\b(?:eval|xargs)\b|\b(?:ba|da|z|k)?sh\b[^\n]*-[a-zA-Z]*c\b|\$\(|`/;

// Split a shell script into simple command tokens and subshell parens `(`, `)`,
// respecting quotes, backslash escapes/continuations, comments, and `$(...)`.
function splitShellCommands(script) {
  const tokens = [];
  let current = '';
  let quote = null;
  let substDepth = 0;
  const flush = () => {
    const trimmed = current.trim();
    if (trimmed) tokens.push(trimmed);
    current = '';
  };
  for (let i = 0; i < script.length; i++) {
    const ch = script[i];
    const next = script[i + 1];
    if (quote === "'") {
      current += ch;
      if (ch === "'") quote = null;
      continue;
    }
    if (ch === '\\') {
      if (next === '\n') {
        i++;
        continue;
      }
      if (next !== undefined) {
        current += ch + next;
        i++;
        continue;
      }
    }
    if (quote === '"') {
      current += ch;
      if (ch === '"') quote = null;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      current += ch;
      continue;
    }
    if (ch === '#' && (current.length === 0 || /\s/.test(current[current.length - 1]))) {
      while (i < script.length && script[i] !== '\n') i++;
      flush();
      continue;
    }
    if (ch === '$' && next === '(') {
      substDepth++;
      current += '$(';
      i++;
      continue;
    }
    if (substDepth > 0) {
      if (ch === '(') substDepth++;
      else if (ch === ')') substDepth--;
      current += ch;
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
    const nonRootWorkingDir = Boolean(workingDir && workingDir.trim() && !/^\.\/?$/.test(workingDir.trim()));
    // Possible directories tracked conservatively across segments: a `cd` in a
    // pipeline, short-circuited `&&`/`||`, background job, or branch never drops
    // the caller's existing directories. Empty means root (for CI steps) or the
    // owning workspace itself (already handled by manifestScanText).
    let activeDirs = new Set(nonRootWorkingDir ? [workingDir.trim()] : []);
    const dirStack = [];
    for (const token of splitShellCommands(rawCmd)) {
      if (token === '(') {
        dirStack.push(new Set(activeDirs));
        continue;
      }
      if (token === ')') {
        if (dirStack.length > 0) activeDirs = dirStack.pop();
        continue;
      }
      if (/\bpopd\b/.test(token)) {
        activeDirs = new Set([...activeDirs, AMBIGUOUS_DIR]);
      }
      const cdMatches = [...token.matchAll(SHELL_CD_TARGET)].map(([, dir]) => dir);
      if (cdMatches.length > 0) {
        const nextDirs = new Set(activeDirs);
        const bases = activeDirs.size > 0 ? [...activeDirs] : [baseDir];
        for (const dir of cdMatches) {
          for (const from of bases) {
            if (from === AMBIGUOUS_DIR || dir === '-' || dir.includes('$') || dir.includes('*')) {
              nextDirs.add(AMBIGUOUS_DIR);
            } else {
              const rel = relative(root, resolve(root, from, dir)).split(sep).join('/').replace(/\/+$/, '');
              if (rel && rel !== '.') nextDirs.add(rel);
            }
          }
        }
        activeDirs = nextDirs;
      }
      if (!/\blint\b/.test(token)) continue;
      if (AMBIGUOUS_LINT_EXEC.test(token)) {
        addAll();
        continue;
      }
      if (!/\b(?:pnpm|npm|yarn)\b/.test(token)) continue;
      const hasRootFlag = /(?:^|\s)(?:-w|--workspace-root)(?:\s|$)/.test(token);
      const hasCrossFlag = CROSS_WORKSPACE_FLAG.test(token);
      const hasNonRootCrossFlag = /(?:^|[\s;|&(])(?:--filter|-F|--dir|-C|--prefix|--cwd|-r|--recursive|--workspace(?:=|\s)|--workspaces)/.test(token);
      if (!hasCrossFlag && activeDirs.size === 0) continue;
      // `pnpm -w run lint` / `pnpm --workspace-root run lint` runs the root lint
      // script (handled by ROOT_SCRIPT_CALL), not every workspace member.
      if (hasRootFlag && !hasNonRootCrossFlag) continue;
      const recursive = /(?:^|\s)(?:-r|--recursive)(?:\s|$)/.test(token);
      const filters = [...token.matchAll(FILTER_ARG)].map(([, target]) => target);
      if (!recursive && filters.length > 0) {
        let allResolved = true;
        const resolveBases = activeDirs.size > 0 ? [...activeDirs] : [baseDir];
        for (const filter of filters) {
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

// Expand CI commands through root package.json scripts without stripping
// `pnpm --filter`, so workspace script invocations (such as `--filter @nd/n4 lint`)
// remain visible before deciding whether standalone lint scripts can be omitted.
function expandedCommandTexts(commands, rootScripts) {
  const entries = [];
  const pending = commands.map((entry) => (typeof entry === 'string' ? { cmd: entry, workingDir: null } : entry));
  const expanded = new Set();
  while (pending.length) {
    const current = pending.pop();
    entries.push(current);
    for (const [, script] of current.cmd.matchAll(ROOT_SCRIPT_CALL)) {
      if (!expanded.has(script)) {
        expanded.add(script);
        if (rootScripts[script]) pending.push({ cmd: rootScripts[script], workingDir: null });
      }
    }
  }
  return entries;
}

const WORKSPACE_ROOT_SCRIPT_CALL = /\bpnpm\s+(?:-w|--workspace-root)\s+(?:run\s+)?['"]?([A-Za-z0-9_@][\w.:/@-]*)['"]?/g;
const COMMAND_PACKAGE_TESTS = /(?:^|[\s'"`(=])(?:\.\/)?(packages\/[\w.-]+\/tests?)(?:\/|$)/gm;

// Expand root package.json scripts explicitly invoked from a workspace manifest
// via `pnpm -w [run] <script>` or `pnpm --workspace-root [run] <script>`,
// returning both the expanded command texts and all invoked root script names.
function expandedRootScriptsFromWorkspace(commands, rootScripts) {
  const names = new Set();
  const texts = [];
  const pending = [];
  for (const cmd of commands) {
    for (const [, script] of cmd.matchAll(WORKSPACE_ROOT_SCRIPT_CALL)) {
      if (!names.has(script)) {
        names.add(script);
        if (rootScripts[script]) pending.push(rootScripts[script]);
      }
    }
  }
  while (pending.length) {
    const command = pending.pop();
    texts.push(command);
    for (const [, script] of command.matchAll(ROOT_SCRIPT_CALL)) {
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
  const rootScripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts;
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
  const expandedByEntry = new Map(rawEntries.map(([node, raw]) => [node, expandedCommandTexts(raw, rootScripts)]));
  const workspaceRootScriptInfo = new Map(nodes.map((node) => {
    const allScripts = Object.values(manifests.get(node)?.scripts ?? {}).map(String);
    return [node, expandedRootScriptsFromWorkspace(allScripts, rootScripts)];
  }));
  const workspaceRootScripts = new Map([...workspaceRootScriptInfo].map(([node, { names }]) => [node, names]));
  const workspaceExpandedScripts = new Map(nodes.map((node) => {
    const allScripts = Object.values(manifests.get(node)?.scripts ?? {}).map((cmd) => ({ cmd: String(cmd), baseDir: node }));
    const rootExpanded = (workspaceRootScriptInfo.get(node)?.texts ?? []).map((cmd) => ({ cmd, baseDir: '.' }));
    return [node, [...allScripts, ...rootExpanded]];
  }));
  const lintTargetContext = { root, nodeByPackageName, nodeSet, manifests };
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
      for (const [, tests] of cmd.matchAll(COMMAND_PACKAGE_TESTS)) uses.add(tests);
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

  const entries = rawEntries.map(([node, raw]) => [node, raw.map(({ cmd }) => cmd.replace(/pnpm --filter \S+ (?:run )?\S+/g, ''))]);
  // Root tool configs (e2e.config.ts, tsconfig.agentic.json) are read implicitly
  // by the site jobs' commands, so the site build follows them too.
  const rootConfigs = (await readdir(root)).filter((name) => /^(?:[\w-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json)$/.test(name) && !INDEPENDENT_CONFIG.test(name));
  const rootScriptsRun = new Map();
  for (const [node, commands] of entries) {
    const { named, expanded } = namedByCommands(commands, rootScripts);
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
  const jobScripts = new Map(Object.entries(ci?.jobs ?? {}).map(([id, job]) => [id, namedByCommands(
    (Array.isArray(job?.steps) ? job.steps : []).map((step) => String(step?.run ?? '').replace(/pnpm --filter \S+ (?:run )?\S+/g, '')),
    rootScripts,
  ).expanded]));
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
