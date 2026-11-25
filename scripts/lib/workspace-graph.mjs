import { readdirSync, readFileSync } from 'node:fs';
import { lstat, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { isBuiltin } from 'node:module';
import { parse } from 'yaml';
import { sharedModuleUsers } from './shared-module-users.mjs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
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
// Wildcard sentinel recorded in `jobScripts` / `workspaceRootScripts` when a
// command runs an unresolvable dynamic root script name (e.g. `pnpm -w run "$CHECK"`).
export const ANY_ROOT_SCRIPT = '*';
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
function stableEnvKey(env) {
  if (!env || typeof env !== 'object') return '';
  return JSON.stringify(Object.entries(env).sort(([a], [b]) => a.localeCompare(b)));
}

function namedByCommands(commands, rootScripts, root = null, rootPackageName = null) {
  const named = new Set();
  const pending = commands.map((entry) => (typeof entry === 'string' ? { cmd: entry, workingDir: null, env: null } : entry));
  const expanded = new Set();
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    for (const match of current.cmd.matchAll(ROOT_NAMED)) if (match[1]) named.add(match[1]);
    for (const [, rootFile] of current.cmd.matchAll(ROOT_PATH)) named.add(rootFile);
    const nonRootWorkingDir = isStaticNonRootDir(current.workingDir, root);
    const staticWd = nonRootWorkingDir && typeof current.workingDir === 'string' ? current.workingDir.trim().replace(/\/+$/, '') : null;
    for (const seg of splitShellCommands(current.cmd)) {
      for (const word of tokenizeShellWordsWithExpansion(seg)) {
        if (!word.value || /[$`*?[{]/.test(word.value)) continue;
        const candidate = staticWd
          ? posix.normalize(`${staticWd}/${word.value}`)
          : posix.normalize(word.value.replace(/^\/+/, ''));
        if (candidate.startsWith('..')) continue;
        if (ROOT_DIRS.some((dir) => candidate.startsWith(dir)) || ROOT_CONFIG.test(candidate)) {
          named.add(candidate);
        }
      }
    }
    for (const { script, env } of extractPnpmRootScripts(current.cmd, { requireRootFlag: nonRootWorkingDir, baseDir: current.workingDir ?? '.', root, rootPackageName, rootScripts, stepEnv: current.env ?? null })) {
      expanded.add(script);
      const visitKey = `${script}\0${stableEnvKey(env)}`;
      if (!visited.has(visitKey)) {
        visited.add(visitKey);
        if (script !== ANY_ROOT_SCRIPT && rootScripts[script]) pending.push({ cmd: rootScripts[script], workingDir: null, env });
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

const isFunctionNode = (node) => Boolean(node && (
  node.type === 'FunctionDeclaration'
  || node.type === 'FunctionExpression'
  || node.type === 'ArrowFunctionExpression'
));

const moduleExportName = (node) => (
  node?.type === 'Identifier'
    ? node.name
    : node?.type === 'Literal' && typeof node.value === 'string'
      ? node.value
      : null
);

function isImportMetaUrlNode(node) {
  return Boolean(
    node?.type === 'MemberExpression'
    && !node.computed
    && node.object?.type === 'MetaProperty'
    && node.object.meta?.name === 'import'
    && node.object.property?.name === 'meta'
    && node.property?.type === 'Identifier'
    && node.property.name === 'url',
  );
}

function isProcessArgv1Node(node) {
  return Boolean(
    node?.type === 'MemberExpression'
    && node.computed
    && node.object?.type === 'MemberExpression'
    && !node.object.computed
    && node.object.object?.type === 'Identifier'
    && node.object.object.name === 'process'
    && node.object.property?.type === 'Identifier'
    && node.object.property.name === 'argv'
    && node.property?.type === 'Literal'
    && node.property.value === 1,
  );
}

function isPathToFileUrlArgv1Href(node, auth) {
  if (node?.type !== 'MemberExpression' || node.computed || node.property?.type !== 'Identifier' || node.property.name !== 'href') return false;
  const call = node.object;
  if (call?.type !== 'CallExpression' || call.callee?.type !== 'Identifier' || call.callee.name !== 'pathToFileURL' || call.arguments?.length !== 1) return false;
  if (!auth?.hasAuthenticPathToFileUrl || auth.processShadowed) return false;
  const arg = call.arguments[0];
  if (isProcessArgv1Node(arg)) return true;
  return Boolean(
    auth.hasAuthenticResolve
    && arg?.type === 'CallExpression'
    && arg.callee?.type === 'Identifier'
    && arg.callee.name === 'resolve'
    && arg.arguments?.length === 1
    && isProcessArgv1Node(arg.arguments[0]),
  );
}

const SAFE_PROCESS_READ_PROPS = new Set(['pid', 'version', 'versions', 'platform', 'arch', 'env', 'execPath', 'stdout', 'stderr', 'exit']);

function isWriteTarget(exprNode, ancestors) {
  let child = exprNode;
  for (let i = ancestors.length - 1; i >= 0; i--) {
    const parent = ancestors[i];
    if (!parent) break;
    if (parent.type === 'AssignmentExpression' && parent.left === child) return true;
    if (parent.type === 'UpdateExpression' && parent.argument === child) return true;
    if (parent.type === 'UnaryExpression' && parent.operator === 'delete' && parent.argument === child) return true;
    if ((parent.type === 'ForInStatement' || parent.type === 'ForOfStatement') && parent.left === child) return true;
    if (
      parent.type === 'ArrayPattern'
      || parent.type === 'ObjectPattern'
      || parent.type === 'RestElement'
      || (parent.type === 'Property' && parent.value === child)
      || (parent.type === 'AssignmentPattern' && parent.left === child)
    ) {
      child = parent;
      continue;
    }
    break;
  }
  return false;
}

function isSafeProcessUse(idNode, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  const grandparent = ancestors[ancestors.length - 2];
  if (parent?.type !== 'MemberExpression' || parent.object !== idNode || parent.computed) return false;
  const prop = parent.property?.type === 'Identifier' ? parent.property.name : null;
  if (!prop) return false;
  if (isWriteTarget(parent, ancestors.slice(0, -1))) return false;
  if (SAFE_PROCESS_READ_PROPS.has(prop)) return true;
  if (prop === 'argv') {
    const greatGrand = ancestors[ancestors.length - 3];
    const isSafeMethod =
      grandparent?.type === 'MemberExpression'
      && grandparent.object === parent
      && !grandparent.computed
      && (grandparent.property?.name === 'slice' || grandparent.property?.name === 'includes')
      && greatGrand?.type === 'CallExpression'
      && greatGrand.callee === grandparent;
    const isReadOnlyIndex =
      grandparent?.type === 'MemberExpression'
      && grandparent.object === parent
      && grandparent.computed
      && grandparent.property?.type === 'Literal'
      && typeof grandparent.property.value === 'number'
      && !isWriteTarget(grandparent, ancestors.slice(0, -2));
    return Boolean(isSafeMethod || isReadOnlyIndex);
  }
  return false;
}

function collectPatternNames(pattern, onName) {
  if (!pattern || typeof pattern !== 'object') return;
  if (pattern.type === 'Identifier') {
    onName(pattern.name);
  } else if (pattern.type === 'ObjectPattern') {
    for (const prop of pattern.properties ?? []) {
      if (prop.type === 'RestElement') collectPatternNames(prop.argument, onName);
      else collectPatternNames(prop.value, onName);
    }
  } else if (pattern.type === 'ArrayPattern') {
    for (const element of pattern.elements ?? []) {
      if (element) collectPatternNames(element, onName);
    }
  } else if (pattern.type === 'AssignmentPattern') {
    collectPatternNames(pattern.left, onName);
  } else if (pattern.type === 'RestElement') {
    collectPatternNames(pattern.argument, onName);
  }
}

// Verify that `pathToFileURL` comes from `node:url`, `resolve` from `node:path`,
// and neither those bindings nor `process` are shadowed or reassigned in `ast`.
function esmGuardBindingAuth(ast) {
  let pathToFileUrlImported = false;
  let resolveImported = false;
  let shadowedPathToFileUrl = false;
  let shadowedResolve = false;
  let processShadowed = false;
  for (const stmt of ast?.body ?? []) {
    if (stmt.type === 'ImportDeclaration' && stmt.source?.type === 'Literal') {
      const src = stmt.source.value;
      for (const spec of stmt.specifiers ?? []) {
        const local = spec.local?.name;
        const imported = spec.type === 'ImportSpecifier' ? moduleExportName(spec.imported) : null;
        if (local === 'process') processShadowed = true;
        if (local === 'pathToFileURL') {
          if (imported === 'pathToFileURL' && (src === 'node:url' || src === 'url')) pathToFileUrlImported = true;
          else shadowedPathToFileUrl = true;
        }
        if (local === 'resolve') {
          if (imported === 'resolve' && (src === 'node:path' || src === 'path')) resolveImported = true;
          else shadowedResolve = true;
        }
      }
    }
  }
  const checkDeclName = (name) => {
    if (name === 'pathToFileURL') shadowedPathToFileUrl = true;
    if (name === 'resolve') shadowedResolve = true;
    if (name === 'process') processShadowed = true;
  };
  const scan = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item);
      return;
    }
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id?.name) {
      checkDeclName(node.id.name);
    }
    if (isFunctionNode(node) && Array.isArray(node.params)) {
      for (const param of node.params) collectPatternNames(param, checkDeclName);
    }
    if (node.type === 'CatchClause' && node.param) collectPatternNames(node.param, checkDeclName);
    if (node.type === 'VariableDeclarator' && node.id) collectPatternNames(node.id, checkDeclName);
    if (node.type === 'AssignmentExpression' && node.left) collectPatternNames(node.left, checkDeclName);
    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left && node.left.type !== 'VariableDeclaration') {
      collectPatternNames(node.left, checkDeclName);
    }
    if (node.type === 'UpdateExpression' && node.argument) collectPatternNames(node.argument, checkDeclName);
    for (const key of Object.keys(node)) {
      if (!AST_SKIP.has(key)) scan(node[key]);
    }
  };
  scan(ast);
  return {
    hasAuthenticPathToFileUrl: pathToFileUrlImported && !shadowedPathToFileUrl,
    hasAuthenticResolve: resolveImported && !shadowedResolve,
    processShadowed,
  };
}

const UNSAFE_PROCESS_MODULES = new Set([
  'process',
  'node:process',
  'module',
  'node:module',
  'vm',
  'node:vm',
  'inspector',
  'node:inspector',
  'inspector/promises',
  'node:inspector/promises',
  'v8',
  'node:v8',
]);
const UNSAFE_GLOBAL_PROPS = new Set(['process', 'globalThis', 'global', 'Reflect', 'eval', 'Function']);

// Whether an AST may mutate `process` or `process.argv` (outside an authenticated
// strict ESM main guard's consequent; `else` branches are always scanned).
function astMayMutateProcessArgv(ast, allowGuardIf = false) {
  if (!ast) return true;
  const bindingAuth = allowGuardIf ? esmGuardBindingAuth(ast) : null;
  let unsafe = false;
  const scan = (node, ancestors = []) => {
    if (unsafe || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) scan(item, ancestors);
      return;
    }
    if (
      (node.type === 'ImportDeclaration' || node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration')
      && node.source?.type === 'Literal'
      && UNSAFE_PROCESS_MODULES.has(node.source.value)
    ) {
      unsafe = true;
      return;
    }
    if (node.type === 'ImportExpression' && (node.source?.type !== 'Literal' || UNSAFE_PROCESS_MODULES.has(node.source.value))) {
      unsafe = true;
      return;
    }
    if (node.type === 'CallExpression' && node.callee?.type === 'Identifier' && node.callee.name === 'require') {
      unsafe = true;
      return;
    }
    if (allowGuardIf && node.type === 'IfStatement' && isStrictEsmMainGuard(node, bindingAuth)) {
      if (node.alternate) scan(node.alternate, [...ancestors, node]);
      return;
    }
    if (node.type === 'Identifier') {
      const parent = ancestors[ancestors.length - 1];
      const isNonComputedProp =
        (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node)
        || (parent?.type === 'Property' && !parent.computed && parent.key === node);
      if (!isNonComputedProp) {
        if (node.name === 'Reflect' || node.name === 'eval' || node.name === 'Function') {
          unsafe = true;
          return;
        }
        if (node.name === 'globalThis' || node.name === 'global') {
          const isSafeGlobalRead =
            parent?.type === 'MemberExpression'
            && parent.object === node
            && !parent.computed
            && parent.property?.type === 'Identifier'
            && !UNSAFE_GLOBAL_PROPS.has(parent.property.name)
            && !isWriteTarget(parent, ancestors.slice(0, -1));
          if (!isSafeGlobalRead) {
            unsafe = true;
            return;
          }
        }
        if (node.name === 'process' && !isSafeProcessUse(node, ancestors)) {
          unsafe = true;
          return;
        }
      }
      if (node.name === 'argv') {
        const isSafeProcessArgv = parent?.type === 'MemberExpression' && parent.property === node && parent.object?.type === 'Identifier' && parent.object.name === 'process' && isSafeProcessUse(parent.object, ancestors);
        if (!isSafeProcessArgv) {
          unsafe = true;
          return;
        }
      }
    }
    ancestors.push(node);
    for (const key of Object.keys(node)) {
      if (!AST_SKIP.has(key)) scan(node[key], ancestors);
    }
    ancestors.pop();
  };
  scan(ast);
  return unsafe;
}

// Verify that `pathToFileURL` comes from `node:url`, `resolve` from `node:path`,
// and neither those bindings nor `process`/`process.argv` are shadowed or mutated.
function esmGuardImportAuth(ast, anyModuleMutatesArgv = false) {
  const auth = esmGuardBindingAuth(ast);
  return {
    ...auth,
    processShadowed: auth.processShadowed || anyModuleMutatesArgv || astMayMutateProcessArgv(ast, true),
  };
}

// Strict Node ESM CLI entry guard: `if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href)`
// (optionally guarded on the left with `process.argv[1] && ...`), with authentic
// `node:url`/`node:path` imports and unshadowed `process`. Arbitrary truthy checks
// like `if (import.meta.url)` or locally shadowed helpers do NOT match.
function isStrictEsmMainGuard(ifNode, auth) {
  if (ifNode?.type !== 'IfStatement') return false;
  let eq = ifNode.test;
  if (eq?.type === 'LogicalExpression' && eq.operator === '&&' && isProcessArgv1Node(eq.left)) eq = eq.right;
  if (eq?.type !== 'BinaryExpression' || eq.operator !== '===') return false;
  return (
    (isImportMetaUrlNode(eq.left) && isPathToFileUrlArgv1Href(eq.right, auth))
    || (isImportMetaUrlNode(eq.right) && isPathToFileUrlArgv1Href(eq.left, auth))
  );
}

function walkAstIdentifiers(node, onIdent, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAstIdentifiers(item, onIdent, ancestors);
    return;
  }
  if (node.type === 'Identifier') {
    const parent = ancestors[ancestors.length - 1];
    const isDeclId =
      (parent?.type === 'VariableDeclarator' && parent.id === node)
      || (parent?.type === 'FunctionDeclaration' && parent.id === node)
      || (parent?.type === 'FunctionExpression' && parent.id === node)
      || (parent?.type === 'ClassDeclaration' && parent.id === node)
      || (parent?.type === 'ImportSpecifier' && (parent.local === node || parent.imported === node))
      || (parent?.type === 'ImportDefaultSpecifier' && parent.local === node)
      || (parent?.type === 'ImportNamespaceSpecifier' && parent.local === node)
      || (parent?.type === 'ExportSpecifier' && parent.exported === node);
    const isParam = isFunctionNode(parent) && Array.isArray(parent.params) && parent.params.includes(node);
    const isNonComputedProp =
      (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node)
      || (parent?.type === 'Property' && !parent.computed && parent.key === node);
    if (!isDeclId && !isParam && !isNonComputedProp) onIdent(node, ancestors);
  }
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (!AST_SKIP.has(key)) walkAstIdentifiers(node[key], onIdent, ancestors);
  }
  ancestors.pop();
}

function collectTopLevelBindings(ast) {
  const bindings = new Map();
  const exportedNames = new Set();
  for (const stmt of ast.body ?? []) {
    if (stmt.type === 'ExportNamedDeclaration') {
      if (stmt.declaration?.type === 'FunctionDeclaration' && stmt.declaration.id?.name) {
        bindings.set(stmt.declaration.id.name, stmt.declaration);
        exportedNames.add(stmt.declaration.id.name);
      } else if (stmt.declaration?.type === 'VariableDeclaration') {
        for (const decl of stmt.declaration.declarations ?? []) {
          if (decl.id?.type === 'Identifier' && decl.init) {
            bindings.set(decl.id.name, decl.init);
            exportedNames.add(decl.id.name);
          }
        }
      }
      for (const spec of stmt.specifiers ?? []) {
        if (spec.local?.name) exportedNames.add(spec.local.name);
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      if (stmt.declaration?.type === 'Identifier') exportedNames.add(stmt.declaration.name);
      else if (stmt.declaration?.id?.name) exportedNames.add(stmt.declaration.id.name);
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      bindings.set(stmt.id.name, stmt);
    } else if (stmt.type === 'VariableDeclaration') {
      for (const decl of stmt.declarations ?? []) {
        if (decl.id?.type === 'Identifier' && decl.init) bindings.set(decl.id.name, decl.init);
      }
    }
  }
  return { bindings, exportedNames };
}

function isProcessArgvNode(node) {
  return Boolean(
    node?.type === 'MemberExpression'
    && !node.computed
    && node.object?.type === 'Identifier'
    && node.object.name === 'process'
    && node.property?.type === 'Identifier'
    && node.property.name === 'argv',
  );
}

function isFlagDropFilter(fn) {
  if (!fn || (fn.type !== 'ArrowFunctionExpression' && fn.type !== 'FunctionExpression')) return false;
  if (fn.params?.length !== 1 || fn.params[0]?.type !== 'Identifier') return false;
  const param = fn.params[0].name;
  let expr = fn.body;
  if (expr?.type === 'BlockStatement') {
    if (expr.body?.length !== 1 || expr.body[0]?.type !== 'ReturnStatement') return false;
    expr = expr.body[0].argument;
  }
  if (expr?.type !== 'BinaryExpression' || expr.operator !== '!==') return false;
  const isFlagLit = (n) => n?.type === 'Literal' && typeof n.value === 'string' && n.value.startsWith('-');
  const isParam = (n) => n?.type === 'Identifier' && n.name === param;
  return (isParam(expr.left) && isFlagLit(expr.right)) || (isFlagLit(expr.left) && isParam(expr.right));
}

function isArgvSlice2Expr(node) {
  if (node?.type !== 'CallExpression' || node.callee?.type !== 'MemberExpression' || node.callee.computed) return false;
  const method = node.callee.property?.type === 'Identifier' ? node.callee.property.name : null;
  if (method === 'slice' && isProcessArgvNode(node.callee.object)) {
    return node.arguments?.length === 1 && node.arguments[0]?.type === 'Literal' && node.arguments[0].value === 2;
  }
  if (method === 'filter' && node.arguments?.length === 1 && isFlagDropFilter(node.arguments[0])) {
    return isArgvSlice2Expr(node.callee.object);
  }
  return false;
}

// Whether a caller module passes only the CLI's argv[2] app argument to its
// imported `provisionTestData` binding (never a literal, shadowed param, or fallback).
function callerPreservesAppIdentity(ast, localFnName) {
  if (!ast || !localFnName || astMayMutateProcessArgv(ast, false)) return false;
  const argvAppVars = new Set();
  const argvDeclNodes = new Set();
  for (const stmt of ast.body ?? []) {
    if (stmt.type !== 'VariableDeclaration' || stmt.kind !== 'const') continue;
    for (const decl of stmt.declarations ?? []) {
      if (
        decl.id?.type === 'Identifier'
        && decl.init?.type === 'MemberExpression'
        && decl.init.computed
        && isProcessArgvNode(decl.init.object)
        && decl.init.property?.type === 'Literal'
        && decl.init.property.value === 2
      ) {
        argvAppVars.add(decl.id.name);
        argvDeclNodes.add(decl);
      } else if (
        decl.id?.type === 'ArrayPattern'
        && decl.id.elements?.[0]?.type === 'Identifier'
        && isArgvSlice2Expr(decl.init)
      ) {
        argvAppVars.add(decl.id.elements[0].name);
        argvDeclNodes.add(decl);
      }
    }
  }
  if (argvAppVars.size === 0) return false;
  // Reject any nested/shadowing binding or reassignment of an argvAppVar.
  const shadowed = new Set();
  const checkShadow = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) checkShadow(item);
      return;
    }
    const mark = (name) => {
      if (argvAppVars.has(name)) shadowed.add(name);
    };
    if (node.type === 'VariableDeclarator' && !argvDeclNodes.has(node) && node.id) collectPatternNames(node.id, mark);
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id?.name) mark(node.id.name);
    if (isFunctionNode(node) && Array.isArray(node.params)) {
      for (const param of node.params) collectPatternNames(param, mark);
    }
    if (node.type === 'CatchClause' && node.param) collectPatternNames(node.param, mark);
    if (node.type === 'AssignmentExpression' && node.left) collectPatternNames(node.left, mark);
    if ((node.type === 'ForInStatement' || node.type === 'ForOfStatement') && node.left && node.left.type !== 'VariableDeclaration') {
      collectPatternNames(node.left, mark);
    }
    if (node.type === 'UpdateExpression' && node.argument) collectPatternNames(node.argument, mark);
    for (const key of Object.keys(node)) {
      if (!AST_SKIP.has(key)) checkShadow(node[key]);
    }
  };
  checkShadow(ast);
  let valid = true;
  walkAstIdentifiers(ast, (idNode, ancestors) => {
    if (!valid || idNode.name !== localFnName) return;
    const parent = ancestors[ancestors.length - 1];
    const okCall = Boolean(
      !ancestors.some(isFunctionNode)
      && parent?.type === 'CallExpression'
      && parent.callee === idNode
      && parent.arguments?.length >= 1
      && parent.arguments[0]?.type === 'Identifier'
      && argvAppVars.has(parent.arguments[0].name)
      && !shadowed.has(parent.arguments[0].name),
    );
    if (!okCall) valid = false;
  });
  return valid;
}

// Tokenize one shell segment while preserving each word's exact raw text so
// callers can distinguish `"$APP"` from `'$APP'`, `\$APP`, or `"$A""4"`.
function tokenizeShellWordsWithExpansion(segment) {
  const words = [];
  let current = '';
  let start = -1;
  let quote = null;
  const markStart = (idx) => {
    if (start === -1) start = idx;
  };
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    const next = segment[i + 1];
    if (quote === "'") {
      markStart(i);
      if (ch === "'") quote = null;
      else current += ch;
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
      markStart(i);
      current += next;
      i++;
      continue;
    }
    if (segment.startsWith('${{', i)) {
      const close = segment.indexOf('}}', i + 3);
      if (close !== -1) {
        markStart(i);
        current += segment.slice(i, close + 2);
        i = close + 1;
        continue;
      }
    }
    if (quote === '"') {
      markStart(i);
      if (ch === '"') quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      markStart(i);
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (start !== -1) {
        words.push({ value: current, raw: segment.slice(start, i) });
        current = '';
        start = -1;
      }
      continue;
    }
    markStart(i);
    current += ch;
  }
  if (start !== -1) words.push({ value: current, raw: segment.slice(start) });
  return words;
}

const UNSAFE_EXEC_ENV = /^(?:NODE_|BASH_ENV$|BASH_FUNC_|BASHOPTS$|ENV$|ZDOTDIR$|SHELLOPTS$|PS4$|PROMPT_COMMAND$|IFS$|CDPATH$|PATH$|FPATH$|LD_|DYLD_|GLOBIGNORE$|EXECIGNORE$)/;
const UNSAFE_EXEC_ENV_TEXT = /\b(?:NODE_OPTIONS|NODE_PATH|BASH_ENV|BASH_FUNC_|BASHOPTS|ZDOTDIR|SHELLOPTS|PROMPT_COMMAND|LD_PRELOAD|DYLD_INSERT_LIBRARIES)\b/;

function isRepoRootWorkingDir(workingDir, root) {
  if (!workingDir) return true;
  const trimmed = typeof workingDir === 'string' ? workingDir.trim() : '';
  if (!trimmed) return true;
  if (isUncertainCdTarget(trimmed)) return false;
  if (!root) return trimmed === '.' || trimmed === './';
  const rel = relative(root, resolve(root, trimmed)).split(sep).join('/').replace(/\/+$/, '');
  return rel === '' || rel === '.';
}

function shellGlobMatches(pattern, target) {
  if (!pattern || !target) return false;
  const expandBraces = (text) => {
    const match = text.match(/\{([^{}]+)\}/);
    if (!match || !match[1].includes(',')) return [text];
    const parts = match[1].split(',');
    if (parts.length > 16) return null;
    const prefix = text.slice(0, match.index);
    const suffix = text.slice(match.index + match[0].length);
    const results = [];
    for (const part of parts) {
      const sub = expandBraces(`${prefix}${part}${suffix}`);
      if (!sub) return null;
      results.push(...sub);
      if (results.length > 64) return null;
    }
    return results;
  };
  const expanded = expandBraces(pattern);
  if (!expanded) return true;
  for (const pat of expanded) {
    let re = '^';
    for (let i = 0; i < pat.length; i++) {
      const ch = pat[i];
      if (ch === '*') {
        if (pat[i + 1] === '*') {
          re += '.*';
          i++;
        } else {
          re += '[^/]*';
        }
      } else if (ch === '?') {
        re += '[^/]';
      } else if (ch === '[') {
        const end = pat.indexOf(']', i + 1);
        if (end === -1) {
          re += '\\[';
        } else {
          let cls = pat.slice(i + 1, end);
          if (cls.startsWith('!')) cls = `^${cls.slice(1)}`;
          re += `[${cls}]`;
          i = end;
        }
      } else {
        re += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }
    }
    re += '$';
    try {
      if (new RegExp(re).test(target)) return true;
    } catch {
      return true;
    }
  }
  return false;
}

const SHELL_CONTROL_PREFIXES = new Set(['if', 'elif', 'while', 'until', 'then', 'do', 'else', '!']);
const OPAQUE_SHELL_COMMANDS = new Set(['eval', 'sh', 'bash', 'dash', 'zsh', 'ksh', 'csh', 'tcsh', 'fish', 'source', '.', 'exec', 'xargs', 'env', 'timeout', 'nohup']);
const SAFE_NODE_DIAGNOSTICS = new Set(['-v', '--version', '-h', '--help', '--v8-options']);

// Whether every CATALOG CI invocation of `entryFile` runs plain `node <entryFile>`
// (no preloads, flags, wrappers, custom shells, or startup/runtime env hooks) and
// passes `${{ matrix.app }}` (directly or via one unconcatenated single-step env var)
// as its first CLI argument.
function ciCommandsPreserveMatrixApp(catalogCmds, entryFile, root = null) {
  const entryBase = entryFile.split('/').pop();
  const matchesEntryWord = (value, workingDir) => {
    const clean = value.replace(/^\/+/, '');
    const normalized = posix.normalize(clean);
    if (normalized === entryFile) return true;
    const wdNorm = workingDir && !isRepoRootWorkingDir(workingDir, root) ? workingDir.trim().replace(/\/+$/, '') : null;
    const candidate = wdNorm ? posix.normalize(`${wdNorm}/${value}`) : normalized;
    if (candidate === entryFile) return true;
    if (/[*?[{]/.test(candidate) && shellGlobMatches(candidate, entryFile)) return true;
    return value.includes(entryBase) && normalized !== 'scripts/lib/e2e-test-data.mjs';
  };
  for (const entry of catalogCmds ?? []) {
    if (typeof entry === 'object' && entry?.opaqueAction) return false;
    const cmd = typeof entry === 'string' ? entry : entry.cmd;
    const stepEnv = typeof entry === 'string' ? null : entry.env ?? null;
    const workingDir = typeof entry === 'string' ? null : entry.workingDir ?? null;
    const shell = typeof entry === 'string' ? null : entry.shell ?? null;
    if (shell && shell !== 'bash' && shell !== 'sh') return false;
    if (UNSAFE_EXEC_ENV_TEXT.test(cmd)) return false;
    if (stepEnv && Object.keys(stepEnv).some((key) => UNSAFE_EXEC_ENV.test(key))) return false;
    if (stepEnv && Object.values(stepEnv).some((val) => String(val ?? '').includes(entryBase))) return false;
    const segments = splitShellCommands(cmd);
    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const seg = segments[segIdx];
      const words = tokenizeShellWordsWithExpansion(seg);
      if (words.length === 0) continue;
      let startIdx = 0;
      while (startIdx < words.length) {
        const val = words[startIdx].value;
        if (SHELL_CONTROL_PREFIXES.has(val)) {
          startIdx++;
          continue;
        }
        const envAssign = val.match(/^([A-Za-z_]\w*)\+?=/);
        if (envAssign) {
          if (UNSAFE_EXEC_ENV.test(envAssign[1])) return false;
          startIdx++;
          continue;
        }
        break;
      }
      const cmdWords = words.slice(startIdx);
      if (cmdWords.length === 0) continue;
      const cmdName = cmdWords[0].value.split('/').pop();
      if (OPAQUE_SHELL_COMMANDS.has(cmdName)) return false;
      if (cmdName === 'node') {
        if (cmdWords.length === 2 && SAFE_NODE_DIAGNOSTICS.has(cmdWords[1].value)) continue;
        if (cmdWords.length < 2 || cmdWords[1].value.startsWith('-') || /[$`*?[{]/.test(cmdWords[1].value)) return false;
      } else if (
        cmdName !== 'echo'
        && cmdName !== 'printf'
        && cmdWords.some((w, idx) => idx > 0 && w.value.split('/').pop() === 'node')
      ) {
        return false;
      }
      const entryIdx = words.findIndex((w) => matchesEntryWord(w.value, workingDir));
      if (entryIdx < 0) continue;
      if (!isRepoRootWorkingDir(workingDir, root)) return false;
      if (segIdx !== 0 || /`|\$\(/.test(seg)) return false;
      if (entryIdx !== 1 || words[0].raw !== 'node' || entryIdx + 1 >= words.length) return false;
      const entryNorm = posix.normalize(words[entryIdx].value.replace(/^\/+/, ''));
      if (entryNorm !== entryFile) return false;
      const rawArg = words[entryIdx + 1].raw;
      if (rawArg === '${{ matrix.app }}' || rawArg === '"${{ matrix.app }}"' || rawArg === "'${{ matrix.app }}'") continue;
      const varMatch = rawArg.match(/^(?:"\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})"|\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\}))$/);
      if (!varMatch || !stepEnv) return false;
      const varName = varMatch[1] ?? varMatch[2] ?? varMatch[3] ?? varMatch[4];
      if (!Object.hasOwn(stepEnv, varName) || String(stepEnv[varName]).trim() !== '${{ matrix.app }}') return false;
    }
  }
  return true;
}

// Return AST ranges and owning app ids in `scripts/lib/e2e-test-data.mjs`
// provably belonging only to individual app provisioners: direct
// `provisioners.<app>[.cpu].provision` function bodies and private (non-exported)
// top-level functions referenced exclusively from inside those provision bodies.
function computeProvisionerOnlyRanges(ast) {
  if (!ast) return { ok: false, entries: [] };
  const { bindings, exportedNames } = collectTopLevelBindings(ast);
  const provisionersObj = bindings.get('provisioners');
  if (provisionersObj?.type !== 'ObjectExpression') return { ok: false, entries: [] };
  // Bail out if `provisioners` is re-exported under another name or as default.
  for (const stmt of ast.body ?? []) {
    if (stmt.type === 'ExportNamedDeclaration') {
      for (const spec of stmt.specifiers ?? []) {
        const exported = moduleExportName(spec.exported);
        if (spec.local?.name === 'provisioners' && exported !== 'provisioners') return { ok: false, entries: [] };
      }
    } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration?.type === 'Identifier' && stmt.declaration.name === 'provisioners') {
      return { ok: false, entries: [] };
    }
  }
  const provisionFnApps = new Map();
  const provisionIdentApps = new Map();
  const recordProvisionProp = (obj, appId) => {
    if (obj?.type !== 'ObjectExpression') return;
    for (const prop of obj.properties ?? []) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const key = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.type === 'Literal' ? String(prop.key.value) : null;
      if (key === 'provision') {
        if (prop.value?.type === 'FunctionExpression' || prop.value?.type === 'ArrowFunctionExpression') provisionFnApps.set(prop.value, appId);
        else if (prop.value?.type === 'Identifier') provisionIdentApps.set(prop.value, appId);
      } else if (key === 'cpu') {
        recordProvisionProp(prop.value, appId);
      }
    }
  };
  for (const prop of provisionersObj.properties ?? []) {
    if (prop.type !== 'Property' || prop.computed) return { ok: false, entries: [] };
    const appId = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.type === 'Literal' ? String(prop.key.value) : null;
    if (!appId) return { ok: false, entries: [] };
    recordProvisionProp(prop.value, appId);
  }

  const privateFns = new Map();
  for (const [name, node] of bindings) {
    if (!exportedNames.has(name) && isFunctionNode(node)) privateFns.set(name, node);
  }
  const privateFnToName = new Map([...privateFns].map(([name, node]) => [node, name]));
  const provisionTestDataFn = exportedNames.has('provisionTestData') && isFunctionNode(bindings.get('provisionTestData'))
    ? bindings.get('provisionTestData')
    : null;
  const appParamName = provisionTestDataFn?.params?.[0]?.type === 'Identifier' ? provisionTestDataFn.params[0].name : null;
  const nonProvisionerReferenced = new Set();
  const privateFnDeps = new Map([...privateFns.keys()].map((name) => [name, new Set()]));
  const privateFnApps = new Map([...privateFns.keys()].map((name) => [name, new Set()]));
  let provisionersUsedAtStartup = false;

  walkAstIdentifiers(ast, (idNode, ancestors) => {
    if (idNode.name === 'provisionTestData') {
      provisionersUsedAtStartup = true;
      return;
    }
    if (appParamName && idNode.name === appParamName && provisionTestDataFn && ancestors.includes(provisionTestDataFn)) {
      const parent = ancestors[ancestors.length - 1];
      if ((parent?.type === 'AssignmentExpression' && parent.left === idNode) || (parent?.type === 'UpdateExpression' && parent.argument === idNode)) {
        provisionersUsedAtStartup = true;
        return;
      }
    }
    if (idNode.name === 'provisioners') {
      const parent = ancestors[ancestors.length - 1];
      const safeDispatchLookup = Boolean(
        provisionTestDataFn
        && appParamName
        && ancestors.includes(provisionTestDataFn)
        && parent?.type === 'MemberExpression'
        && parent.object === idNode
        && parent.computed
        && parent.property?.type === 'Identifier'
        && parent.property.name === appParamName,
      );
      if (!safeDispatchLookup) {
        provisionersUsedAtStartup = true;
        return;
      }
      return;
    }
    if (provisionIdentApps.has(idNode)) {
      if (privateFnApps.has(idNode.name)) privateFnApps.get(idNode.name).add(provisionIdentApps.get(idNode));
      return;
    }
    const enclosingProvision = ancestors.find((a) => provisionFnApps.has(a));
    if (enclosingProvision) {
      if (privateFnApps.has(idNode.name)) privateFnApps.get(idNode.name).add(provisionFnApps.get(enclosingProvision));
      return;
    }
    const enclosingPrivate = ancestors.find((a) => privateFnToName.has(a));
    if (enclosingPrivate) {
      privateFnDeps.get(privateFnToName.get(enclosingPrivate)).add(idNode.name);
      return;
    }
    nonProvisionerReferenced.add(idNode.name);
  });

  if (provisionersUsedAtStartup) return { ok: false, entries: [] };

  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...nonProvisionerReferenced]) {
      for (const dep of privateFnDeps.get(name) ?? []) {
        if (!nonProvisionerReferenced.has(dep)) {
          nonProvisionerReferenced.add(dep);
          changed = true;
        }
      }
    }
    for (const [caller, apps] of privateFnApps) {
      for (const dep of privateFnDeps.get(caller) ?? []) {
        const depApps = privateFnApps.get(dep);
        if (!depApps) continue;
        for (const appId of apps) {
          if (!depApps.has(appId)) {
            depApps.add(appId);
            changed = true;
          }
        }
      }
    }
  }

  const entries = [];
  for (const [fn, appId] of provisionFnApps) {
    if (Array.isArray(fn.range)) entries.push({ range: fn.range, apps: new Set([appId]) });
  }
  for (const [name, fn] of privateFns) {
    if (!nonProvisionerReferenced.has(name) && Array.isArray(fn.range)) {
      entries.push({ range: fn.range, apps: privateFnApps.get(name) ?? new Set() });
    }
  }
  return { ok: true, entries };
}

// Return AST ranges of top-level functions in an imported root library module
// that are unreachable from both module-load execution (excluding strict Node
// ESM main-entry guards) and the set of export names actually imported.
function computeUnreachableExportRanges(ast, importedNames, anyModuleMutatesArgv = false) {
  if (!ast || !importedNames?.size) return [];
  const { bindings } = collectTopLevelBindings(ast);
  const fnBindings = new Map([...bindings].filter(([, node]) => isFunctionNode(node)));
  const fnNodeToName = new Map([...fnBindings].map(([name, node]) => [node, name]));
  const reachable = new Set(importedNames);
  for (const stmt of ast.body ?? []) {
    if (stmt.type === 'ExportNamedDeclaration') {
      for (const spec of stmt.specifiers ?? []) {
        const exported = moduleExportName(spec.exported);
        if (exported && spec.local?.name && importedNames.has(exported)) {
          reachable.add(spec.local.name);
        }
      }
    }
  }
  const fnDeps = new Map([...fnBindings.keys()].map((name) => [name, new Set()]));
  const guardAuth = esmGuardImportAuth(ast, anyModuleMutatesArgv);

  const isInStrictMainGuard = (ancestors, node) => {
    for (let i = 0; i < ancestors.length; i += 1) {
      const ancestor = ancestors[i];
      if (isStrictEsmMainGuard(ancestor, guardAuth)) {
        const next = i + 1 < ancestors.length ? ancestors[i + 1] : node;
        if (next === ancestor.consequent) return true;
      }
    }
    return false;
  };

  walkAstIdentifiers(ast, (idNode, ancestors) => {
    const enclosingFn = ancestors.find((a) => fnNodeToName.has(a));
    if (enclosingFn) {
      fnDeps.get(fnNodeToName.get(enclosingFn)).add(idNode.name);
      return;
    }
    if (isInStrictMainGuard(ancestors, idNode)) return;
    reachable.add(idNode.name);
  });

  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...reachable]) {
      for (const dep of fnDeps.get(name) ?? []) {
        if (!reachable.has(dep)) {
          reachable.add(dep);
          changed = true;
        }
      }
    }
  }

  const ranges = [];
  for (const [name, fn] of fnBindings) {
    if (!reachable.has(name) && Array.isArray(fn.range)) ranges.push(fn.range);
  }
  return ranges;
}

// Collect string/template literal ranges, AST, and module specifiers in a script
// so SCRIPT_REFERENCE can narrow exact files, externalImporterDeps covers all
// import forms, and catalogShared narrows only proven provisioner-only refs.
function analyzeScriptFile(text, file) {
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
  const specifiers = [];
  const ancestors = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if (node.type === 'ImportDeclaration' && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
      const namedOnly = node.specifiers.every((s) => s.type === 'ImportSpecifier');
      specifiers.push({
        value: node.source.value,
        range: node.source.range ?? node.range ?? [0, 0],
        kind: node.specifiers.length === 0 ? 'side-effect' : 'import',
        namedImports: namedOnly ? node.specifiers.map((s) => moduleExportName(s.imported)).filter(Boolean) : null,
        localBindings: namedOnly ? node.specifiers.map((s) => ({ imported: moduleExportName(s.imported), local: s.local?.name })).filter((b) => b.imported && b.local) : null,
      });
    } else if ((node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') && node.source?.type === 'Literal' && typeof node.source.value === 'string') {
      specifiers.push({
        value: node.source.value,
        range: node.source.range ?? node.range ?? [0, 0],
        kind: 'export',
        namedImports: null,
      });
    } else if (node.type === 'ImportExpression') {
      const val = node.source?.type === 'Literal' && typeof node.source.value === 'string' ? node.source.value : null;
      specifiers.push({
        value: val,
        range: node.source?.range ?? node.range ?? [0, 0],
        kind: 'dynamic',
        namedImports: null,
      });
    } else if (
      node.type === 'CallExpression'
      && node.arguments?.length > 0
      && (
        calleeNameOf(node) === 'require'
        || (
          node.callee?.type === 'MemberExpression'
          && !node.callee.computed
          && node.callee.property?.type === 'Identifier'
          && node.callee.property.name === 'resolve'
          && (
            (node.callee.object?.type === 'Identifier' && node.callee.object.name === 'require')
            || (node.callee.object?.type === 'MetaProperty' && node.callee.object.meta?.name === 'import' && node.callee.object.property?.name === 'meta')
          )
        )
      )
    ) {
      const arg = node.arguments[0];
      const val = arg?.type === 'Literal' && typeof arg.value === 'string' ? arg.value : null;
      specifiers.push({
        value: val,
        range: arg?.range ?? node.range ?? [0, 0],
        kind: 'require',
        namedImports: null,
      });
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
  const literals = candidates.map(({ node, ancestors: chain }) => {
    const isStringLiteral = node.type === 'Literal' && typeof node.value === 'string';
    const isTemplate = node.type === 'TemplateLiteral';
    const commentLine =
      (isStringLiteral || (isTemplate && node.expressions.length === 0)) &&
      chain[chain.length - 1]?.type === 'VariableDeclarator' &&
      /(?:^|\n)[ \t]*\/\//.test(text.slice(node.range[0] + 1, node.range[1] - 1));
    const classified = classifyPathLiteral(node, chain, referencedIdentifiers, readerArgIdentifiers, derivedIdentifiers);
    return { start: node.range[0], end: node.range[1], standalone: classified.standalone || commentLine, derivedJson: classified.derivedJson };
  });
  return { ast, literals, specifiers };
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
    const stepEnv = typeof entry === 'string' ? null : entry.env ?? null;
    if (INDEPENDENT_LINT_SCRIPT.test(rawCmd.trim())) continue;
    if (!/\blint\b/.test(rawCmd) && !/[$`*]|\$\{\{/.test(rawCmd)) continue;
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
      const hasLiteralLint = /\blint\b/.test(token);
      if (!hasLiteralLint && !/[$`*]|\$\{\{/.test(token)) continue;
      if (hasLiteralLint && AMBIGUOUS_LINT_EXEC.test(token)) {
        addAll();
        continue;
      }
      const parsed = parseLintCommandFlags(token, { stepEnv, rawCmd, releaseTestScripts: context.releaseTestScripts });
      if (!hasLiteralLint && !parsed.hasLintScript) {
        const words = tokenizeShellWords(token);
        if (
          (words[0] === 'eval' && words.slice(1).some((w) => /[$`*]|\$\{\{/.test(w)))
          || (SHELL_BIN.test(words[0] ?? '') && words.includes('-c') && words.slice(words.indexOf('-c') + 1).some((w) => /[$`*]|\$\{\{/.test(w)))
        ) {
          addAll();
        }
        continue;
      }
      if (!parsed.hasRunner) continue;
      if (!parsed.hasCrossFlag && activeDirs.size === 0) continue;
      if (parsed.hasRootFlag && !parsed.hasWorkspaceSelector) continue;
      if (!parsed.recursive && parsed.filters.length > 0) {
        let allResolved = true;
        const resolveBases = new Set([...(baseDir !== '.' ? [baseDir] : []), ...(activeDirs.size > 0 ? activeDirs : cwdDirs)]);
        for (const { target: filter, isFilter } of parsed.filters) {
          const isExactRootName =
            isFilter &&
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
            const workspaceNode = filter ? resolveWorkspaceTarget(filter, from, context) : null;
            if (workspaceNode) {
              targets.add(workspaceNode);
              resolvedAny = true;
            } else if (filter && !hasGraphOrGlob && !isUncertainCdTarget(unwrapped)) {
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
      } else if (!parsed.hasCrossFlag && activeDirs.size > 0) {
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
    if (quote !== "'" && segment.startsWith('${{', i)) {
      const close = segment.indexOf('}}', i + 3);
      if (close !== -1) {
        current += segment.slice(i, close + 2);
        hasToken = true;
        i = close + 1;
        continue;
      }
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
const NPM_BIN = /(?:^|\/)npm(?:\.(?:cjs|mjs|js|cmd|exe))?$/;
const YARN_BIN = /(?:^|\/)yarn(?:\.(?:cjs|mjs|js|cmd|exe))?$/;

function resolveSingleCommandEnvVar(word, rawCmd, stepEnv) {
  if (!stepEnv) return null;
  const varMatch = word.match(/^\$(?:([A-Za-z_]\w*)|\{([A-Za-z_]\w*)\})$/);
  if (!varMatch) return null;
  if (splitShellCommands(rawCmd).length !== 1 || /`|\$\(/.test(rawCmd)) return null;
  const varName = varMatch[1] ?? varMatch[2];
  const reassigned = new RegExp(String.raw`(?:^|[\s;&|()])(?:(?:export|declare|local|typeset|readonly)\s+(?:-[A-Za-z]+\s+)*)?${varName}\+?=`).test(rawCmd);
  if (reassigned || !Object.hasOwn(stepEnv, varName)) return null;
  return String(stepEnv[varName]).trim();
}

function scriptMayInvokeLint(scriptWord, { stepEnv = null, rawCmd = '', releaseTestScripts = null } = {}) {
  if (!scriptWord) return false;
  if (scriptWord === 'lint') return true;
  if (!/[$`*]/.test(scriptWord) && !scriptWord.includes('${{')) return false;
  const val = resolveSingleCommandEnvVar(scriptWord, rawCmd, stepEnv);
  if (val !== null) {
    if (val === '${{ matrix.release_test }}') {
      return !releaseTestScripts || releaseTestScripts.has('lint');
    }
    if (!/[$`*]/.test(val) && !val.includes('${{')) {
      return val === 'lint';
    }
  }
  return true;
}

// Parse package-manager flags in one shell command segment, attributing `-w`
// and workspace/directory selectors to the specific `pnpm`, `npm`, or `yarn`
// invocation that receives them (so e.g. `pnpm exec npm -w @nd/n4 run lint`
// treats `-w` as npm's `--workspace` rather than pnpm's `--workspace-root`).
function parseLintCommandFlags(token, scriptOpts = {}) {
  const words = tokenizeShellWords(token);
  let hasRunner = false;
  let hasRootFlag = false;
  let hasCrossFlag = false;
  let hasWorkspaceSelector = false;
  let hasLintScript = false;
  let recursive = false;
  const filters = [];
  for (let i = 0; i < words.length; i++) {
    const kind = PNPM_BIN.test(words[i]) ? 'pnpm' : NPM_BIN.test(words[i]) ? 'npm' : YARN_BIN.test(words[i]) ? 'yarn' : null;
    if (!kind) continue;
    hasRunner = true;
    let runnerRootFlag = false;
    let seenRun = false;
    let runnerScriptWord = null;
    const runnerDirFilters = [];
    for (i++; i < words.length; i++) {
      const word = words[i];
      if (word === '--') break;
      if (kind === 'pnpm' && (word === 'exec' || word === 'dlx')) break;
      if (kind === 'npm' && word === 'exec') break;
      if (kind === 'yarn' && (word === 'exec' || word === 'dlx')) break;
      if (kind === 'pnpm' && (word === 'recursive' || word === 'multi' || word === 'm')) {
        recursive = true;
        hasCrossFlag = true;
        hasWorkspaceSelector = true;
        continue;
      }
      if (kind === 'yarn' && word === 'workspaces') {
        recursive = true;
        hasCrossFlag = true;
        hasWorkspaceSelector = true;
        continue;
      }
      if (kind === 'yarn' && word === 'workspace' && i + 1 < words.length) {
        hasCrossFlag = true;
        hasWorkspaceSelector = true;
        filters.push({ target: words[++i], isFilter: true });
        continue;
      }
      if (word === '--workspace-root' || (kind === 'pnpm' && word === '-w')) {
        runnerRootFlag = true;
        hasRootFlag = true;
        hasCrossFlag = true;
        continue;
      }
      if (word === '-r' || word === '--recursive' || word === '-ws' || word === '--workspaces') {
        recursive = true;
        hasCrossFlag = true;
        hasWorkspaceSelector = true;
        continue;
      }
      if (
        word === '--filter' || word === '--filter-prod' || word === '-F' ||
        word.startsWith('--filter=') || word.startsWith('--filter-prod=') || word.startsWith('-F=')
      ) {
        const target = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i];
        hasCrossFlag = true;
        hasWorkspaceSelector = true;
        filters.push({ target: target ?? '', isFilter: true });
        continue;
      }
      if (
        word === '--workspace' || word.startsWith('--workspace=') ||
        (kind === 'npm' && (word === '-w' || word.startsWith('-w=')))
      ) {
        const target = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i];
        hasCrossFlag = true;
        hasWorkspaceSelector = true;
        filters.push({ target: target ?? '', isFilter: true });
        continue;
      }
      if (
        word === '--dir' || word === '-C' || word === '--prefix' || word === '--cwd' ||
        word.startsWith('--dir=') || word.startsWith('-C=') || word.startsWith('--prefix=') || word.startsWith('--cwd=')
      ) {
        const target = word.includes('=') ? word.slice(word.indexOf('=') + 1) : words[++i];
        hasCrossFlag = true;
        runnerDirFilters.push({ target: target ?? '', isFilter: false });
        continue;
      }
      if (word.startsWith('-')) {
        if (PNPM_VALUE_OPTIONS.has(word) && i + 1 < words.length) i++;
        continue;
      }
      if (!seenRun && (word === 'run' || word === 'run-script')) {
        seenRun = true;
        continue;
      }
      if (runnerScriptWord === null) {
        runnerScriptWord = word;
        break;
      }
    }
    if (scriptMayInvokeLint(runnerScriptWord, scriptOpts)) hasLintScript = true;
    // `-w` / `--workspace-root` overrides `--dir` / `-C` / `--prefix` / `--cwd`
    // on the same pnpm invocation, but not on a separate wrapped invocation
    // (such as `pnpm -w exec npm --prefix apps/n4 run lint`).
    if (!runnerRootFlag && runnerDirFilters.length > 0) {
      hasWorkspaceSelector = true;
      filters.push(...runnerDirFilters);
    }
  }
  return { hasRunner, hasRootFlag, hasCrossFlag, hasWorkspaceSelector, hasLintScript, recursive, filters };
}

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

function effectiveChildEnv(words, runnerIdx, command, stepEnv) {
  if (!stepEnv) return null;
  if (splitShellCommands(command).length !== 1 || /`|\$\(/.test(command)) return null;
  const merged = { ...stepEnv };
  for (let i = 0; i < runnerIdx; i++) {
    const word = words[i];
    const assign = word.match(/^([A-Za-z_]\w*)(\+?=)(.*)$/);
    if (assign) {
      const [, name, op, val] = assign;
      if (/[$`*]/.test(val) || val.includes('${{')) return null;
      merged[name] = op === '+=' ? `${merged[name] ?? ''}${val}` : val;
      continue;
    }
    // Wrappers like `env`, `export`, `unset`, or non-plain assignments can alter env.
    if (word === 'env' || word === 'export' || word === 'unset' || word.includes('=')) return null;
  }
  return merged;
}

// Extract root package.json script names invoked via `pnpm`, allowing shell
// wrappers (`if`, `elif`, `while`, `until`, `timeout`, `bash -c`, `eval`,
// `$(...)`, backticks), `cd` back to the repository root, and pnpm flags
// (`--silent`, `--if-present`, `-w`, `--workspace-root`, `--dir <root>`,
// `--filter <root>`) in any order before or after `run`.
function extractPnpmRootScripts(command, { requireRootFlag = false, baseDir = '.', root = null, rootPackageName = null, rootScripts = null, stepEnv = null, depth = 0 } = {}) {
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
        scripts.push(...extractPnpmRootScripts(subst, { requireRootFlag: !mayRunAtRoot, baseDir: from, root, rootPackageName, rootScripts, stepEnv: null, depth: depth + 1 }));
      }
    }
    const words = tokenizeShellWords(token);
    if (words[0] === 'echo' || words[0] === 'printf') continue;
    for (let start = 0; start < words.length; start++) {
      if (words[start] === 'eval' && start + 1 < words.length) {
        const body = words.slice(start + 1).join(' ');
        for (const from of cwdDirs) {
          scripts.push(...extractPnpmRootScripts(body, { requireRootFlag: !mayRunAtRoot, baseDir: from, root, rootPackageName, rootScripts, stepEnv: null, depth: depth + 1 }));
        }
        break;
      }
      if (SHELL_BIN.test(words[start])) {
        for (let k = start + 1; k < words.length; k++) {
          if (words[k] === '--') break;
          if (/^-[a-zA-Z]*c$/.test(words[k]) && k + 1 < words.length) {
            for (const from of cwdDirs) {
              scripts.push(...extractPnpmRootScripts(words[k + 1], { requireRootFlag: !mayRunAtRoot, baseDir: from, root, rootPackageName, rootScripts, stepEnv: null, depth: depth + 1 }));
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
      const kind = PNPM_BIN.test(words[start]) ? 'pnpm' : NPM_BIN.test(words[start]) ? 'npm' : YARN_BIN.test(words[start]) ? 'yarn' : null;
      if (!kind) continue;
      const childEnv = effectiveChildEnv(words, start, command, stepEnv);
      let idx = start + 1;
      let hasRootFlag = false;
      let hasNonRootFilter = false;
      let hasNonRootDir = false;
      let seenRun = false;
      for (; idx < words.length; idx++) {
        const word = words[idx];
        if (word === '--') break;
        if (word === '--workspace-root' || (kind === 'pnpm' && word === '-w')) {
          hasRootFlag = true;
          continue;
        }
        if (
          word === '--workspace' || word.startsWith('--workspace=') ||
          (kind === 'npm' && (word === '-w' || word.startsWith('-w=')))
        ) {
          if (!word.includes('=')) idx++;
          hasNonRootFilter = true;
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
          word === '--dir' || word === '-C' || word === '--prefix' || word === '--cwd' ||
          word.startsWith('--dir=') || word.startsWith('-C=') || word.startsWith('--prefix=') || word.startsWith('--cwd=')
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
        if (hasRootFlag || (!hasNonRootFilter && !hasNonRootDir && mayRunAtRoot)) {
          if (/^[A-Za-z0-9_@][\w.:/@-]*$/.test(word)) {
            scripts.push({ script: word, env: childEnv });
          } else if (/[$`*]|\$\{\{/.test(word)) {
            const val = resolveSingleCommandEnvVar(word, command, stepEnv);
            if (val !== null && /^[A-Za-z0-9_@][\w.:/@-]*$/.test(val)) {
              scripts.push({ script: val, env: childEnv });
            } else {
              scripts.push({ script: ANY_ROOT_SCRIPT, env: null });
              if (rootScripts) {
                for (const key of Object.keys(rootScripts)) scripts.push({ script: key, env: null });
              }
            }
          }
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
  const pending = commands.map((entry) => (typeof entry === 'string' ? { cmd: entry, workingDir: null, env: null, shell: null } : entry));
  const visited = new Set();
  while (pending.length) {
    const current = pending.pop();
    entries.push(current);
    const nonRootWorkingDir = isStaticNonRootDir(current.workingDir, root);
    for (const { script, env } of extractPnpmRootScripts(current.cmd, { requireRootFlag: nonRootWorkingDir, baseDir: current.workingDir ?? '.', root, rootPackageName, rootScripts, stepEnv: current.env ?? null })) {
      const visitKey = `${script}\0${stableEnvKey(env)}`;
      if (!visited.has(visitKey)) {
        visited.add(visitKey);
        if (script !== ANY_ROOT_SCRIPT && rootScripts[script]) pending.push({ cmd: rootScripts[script], workingDir: null, env, shell: current.shell ?? null });
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
    for (const { script } of extractPnpmRootScripts(cmd, { requireRootFlag: true, baseDir, root, rootPackageName, rootScripts })) {
      if (!names.has(script)) {
        names.add(script);
        if (script !== ANY_ROOT_SCRIPT && rootScripts[script]) pending.push(rootScripts[script]);
      }
    }
  }
  while (pending.length) {
    const command = pending.pop();
    texts.push(command);
    for (const { script } of extractPnpmRootScripts(command, { root, rootPackageName, rootScripts })) {
      if (!names.has(script)) {
        names.add(script);
        if (script !== ANY_ROOT_SCRIPT && rootScripts[script]) pending.push(rootScripts[script]);
      }
    }
  }
  return { texts, names };
}

// Omit an uninvoked workspace package.json's `node ../../scripts/lint.mjs`
// command segment from `scripts.lint` (including when chained with `&& node --check ...`)
// before scanning text references, as long as neither CI nor any other script calls `lint`.
// Direct imports/references in code or build scripts remain untouched.
function manifestScanText(text, manifest, stripStandaloneLint) {
  if (!stripStandaloneLint) return text;
  const lintCmd = manifest?.scripts?.lint;
  if (typeof lintCmd !== 'string') return text;
  if (Object.entries(manifest.scripts).some(([name, cmd]) => {
    if (name === 'lint') return false;
    const str = String(cmd);
    if (/\blint\b/.test(str)) return true;
    return /[$`*]|\$\{\{/.test(str) && splitShellCommands(str).some((seg) => parseLintCommandFlags(seg).hasLintScript);
  })) return text;
  const segments = splitShellCommands(lintCmd);
  const kept = segments.filter((segment) => !INDEPENDENT_LINT_SCRIPT.test(segment.trim()));
  if (kept.length === segments.length) return text;
  const scripts = { ...manifest.scripts };
  if (kept.length === 0) delete scripts.lint;
  else scripts.lint = kept.join(' && ');
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
  let releaseTestScripts = null;
  try {
    const registryData = parse(await readFile(join(root, 'registry/apps.yml'), 'utf8'));
    if (Array.isArray(registryData?.apps)) {
      releaseTestScripts = new Set(['test', ...registryData.apps.map((app) => app?.ci?.release_test).filter((v) => typeof v === 'string')]);
    }
  } catch {
    releaseTestScripts = null;
  }
  const rootManifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const rootScripts = rootManifest.scripts ?? {};
  const rootPackageName = typeof rootManifest.name === 'string' ? rootManifest.name : null;
  const workflowWorkingDir = ci?.defaults?.run?.['working-directory'] ?? null;
  const workflowShell = ci?.defaults?.run?.shell ?? null;
  const workflowEnv = ci?.env && typeof ci.env === 'object' ? ci.env : {};
  const loadLocalCompositeSteps = async (usesSpec, parentEnv, parentWorkingDir, parentShell, visitedActions = new Set()) => {
    if (typeof usesSpec !== 'string' || !usesSpec.startsWith('./')) return [];
    const relDir = usesSpec.slice(2).replace(/\/+$/, '');
    if (!relDir || /[$`*?[{]|\$\{\{/.test(relDir)) {
      return [{ cmd: '', workingDir: parentWorkingDir, shell: parentShell, env: parentEnv, opaqueAction: true }];
    }
    const actionDir = resolve(root, relDir);
    const normalizedRel = relative(root, actionDir).split(sep).join('/');
    if (normalizedRel.startsWith('..') || visitedActions.has(normalizedRel)) {
      return [{ cmd: '', workingDir: parentWorkingDir, shell: parentShell, env: parentEnv, opaqueAction: true }];
    }
    let actionDoc = null;
    for (const filename of ['action.yml', 'action.yaml']) {
      const text = await readFile(join(actionDir, filename), 'utf8').catch(() => null);
      if (text !== null) {
        try {
          actionDoc = parse(text);
        } catch {
          actionDoc = null;
        }
        break;
      }
    }
    if (!actionDoc || actionDoc?.runs?.using !== 'composite' || !Array.isArray(actionDoc?.runs?.steps)) {
      return [{ cmd: '', workingDir: parentWorkingDir, shell: parentShell, env: parentEnv, opaqueAction: true }];
    }
    const nextVisited = new Set([...visitedActions, normalizedRel]);
    const expanded = [];
    for (const subStep of actionDoc.runs.steps) {
      const subEnv = subStep?.env && typeof subStep.env === 'object' ? { ...parentEnv, ...subStep.env } : parentEnv;
      const subWorkingDir = subStep?.['working-directory'] ?? parentWorkingDir ?? null;
      const subShell = subStep?.shell ?? parentShell ?? null;
      if (typeof subStep?.uses === 'string' && subStep.uses.startsWith('./')) {
        expanded.push(...await loadLocalCompositeSteps(subStep.uses, subEnv, subWorkingDir, subShell, nextVisited));
      } else {
        expanded.push({ cmd: String(subStep?.run ?? ''), workingDir: subWorkingDir, shell: subShell, env: subEnv });
      }
    }
    return expanded;
  };
  const expandJobSteps = async (job) => {
    const out = [];
    const jobWorkingDir = job?.defaults?.run?.['working-directory'] ?? workflowWorkingDir;
    const jobShell = job?.defaults?.run?.shell ?? workflowShell;
    const jobEnv = job?.env && typeof job.env === 'object' ? { ...workflowEnv, ...job.env } : workflowEnv;
    for (const step of Array.isArray(job?.steps) ? job.steps : []) {
      const stepEnv = step?.env && typeof step.env === 'object' ? { ...jobEnv, ...step.env } : jobEnv;
      const stepWorkingDir = step?.['working-directory'] ?? jobWorkingDir ?? null;
      const stepShell = step?.shell ?? jobShell ?? null;
      if (typeof step?.uses === 'string' && step.uses.startsWith('./')) {
        out.push(...await loadLocalCompositeSteps(step.uses, stepEnv, stepWorkingDir, stepShell));
      } else {
        out.push({ cmd: String(step?.run ?? ''), workingDir: stepWorkingDir, shell: stepShell, env: stepEnv });
      }
    }
    return out;
  };
  const rawRuns = async (names) => {
    const out = [];
    for (const name of names) {
      const job = ci?.jobs?.[name];
      const steps = job?.steps;
      if (!Array.isArray(steps) || steps.length === 0) {
        throw new WorkspaceGraphConfigurationError(`ci.yml job ${name} has no step list; update the workspace graph's CI entry points`);
      }
      out.push(...await expandJobSteps(job));
    }
    return out;
  };
  const rawEntries = [
    [SITE, await rawRuns(siteJobNames(ci))],
    [CATALOG, await rawRuns(CATALOG_JOBS)],
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
  const lintTargetContext = { root, rootPackageName, nodeByPackageName, nodeSet, manifests, releaseTestScripts };
  const lintInvokedNodes = new Set();
  for (const [, cmds] of expandedByEntry) {
    for (const target of lintTargetsInCommands(cmds, lintTargetContext)) lintInvokedNodes.add(target);
  }
  for (const [, cmds] of workspaceExpandedScripts) {
    for (const target of lintTargetsInCommands(cmds, lintTargetContext)) lintInvokedNodes.add(target);
  }

  const edges = new Map();
  const lazyWorkspaceEdges = new Map();
  const runtimeWorkspaceEdges = new Map();
  const externalImporterDeps = new Map();
  const analyzedRootFiles = new Map();
  const moduleImportEdges = new Map();
  const opaqueImporters = new Set();
  const rootFileImportModes = new Map();
  const recordImportMode = (target, namedImports, importerFile = null, localBindings = null) => {
    const entry = rootFileImportModes.get(target) ?? { allExports: false, names: new Set(), importers: [] };
    if (!namedImports) entry.allExports = true;
    else {
      for (const name of namedImports) entry.names.add(name);
      if (importerFile) entry.importers.push({ file: importerFile, bindings: localBindings ?? [] });
    }
    rootFileImportModes.set(target, entry);
  };
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
    const analysis = analyzeScriptFile(text, file);
    const literals = analysis?.literals ?? null;
    const workspaceRefs = [];
    const recordWorkspaceRef = (wsTarget, range) => workspaceRefs.push({ target: wsTarget, range });
    for (const match of text.matchAll(SCRIPT_REFERENCE)) {
      const [, top, name, inner] = match;
      if (!nodeSet.has(`${top}/${name}`)) continue;
      const matchStart = match.index;
      const matchEnd = match.index + match[0].length;
      const range = [matchStart, matchEnd];
      const literalMatch = inner ? matchScriptLiteral(text, match, literals) : { complete: false, derivedJson: true };
      const target = literalMatch.complete && `${top}/${name}${inner}`;
      if (target && await isRegularUnlinkedFile(root, target)) {
        uses.add(target);
        recordWorkspaceRef(target, range);
        if (literalMatch.derivedJson && target.endsWith('.json')) derivedJsonFiles.add(target);
        pendingRootFiles.push(target);
      } else {
        uses.add(`${top}/${name}`);
        recordWorkspaceRef(`${top}/${name}`, range);
        const exactJson = inner?.endsWith('.json') && `${top}/${name}${inner}`;
        if (exactJson && await isRegularUnlinkedFile(root, exactJson)) {
          uses.add(exactJson);
          recordWorkspaceRef(exactJson, range);
          derivedJsonFiles.add(exactJson);
          pendingRootFiles.push(exactJson);
        }
      }
    }
    const fileOwner = file.match(/^(?:packages|exes)\/[^/]+(?=\/)/)?.[0] ?? null;
    for (const match of text.matchAll(BARE_IMPORT)) {
      const name = match[1];
      if (nodeByPackageName.has(name)) {
        const wsNode = nodeByPackageName.get(name);
        uses.add(wsNode);
        recordWorkspaceRef(wsNode, [match.index, match.index + match[0].length]);
      } else if (fileOwner && !name.startsWith('.') && !isBuiltin(name)) {
        externalImporterDeps.set(file, fileOwner);
      }
    }
    const runtimeTargets = new Set();
    const importedFiles = new Set();
    if (analysis) {
      for (const spec of analysis.specifiers) {
        if (spec.value === null) {
          opaqueImporters.add(file);
          if (fileOwner) externalImporterDeps.set(file, fileOwner);
          continue;
        }
        if (spec.value.startsWith('.') || spec.value.startsWith('/')) {
          const resolvedTarget = relative(root, resolve(root, dirname(file), spec.value)).split(sep).join('/');
          if (resolvedTarget !== file) {
            importedFiles.add(resolvedTarget);
            if (ROOT_DIRS.some((dir) => resolvedTarget.startsWith(dir)) || ROOT_CONFIG.test(resolvedTarget)) {
              recordImportMode(resolvedTarget, spec.namedImports, file, spec.localBindings);
            }
          }
          continue;
        }
        if (isBuiltin(spec.value)) continue;
        opaqueImporters.add(file);
        const pkgName = spec.value.startsWith('@') ? spec.value.split('/').slice(0, 2).join('/') : spec.value.split('/')[0];
        if (nodeByPackageName.has(pkgName)) {
          const wsNode = nodeByPackageName.get(pkgName);
          if (spec.kind === 'dynamic' || spec.kind === 'require') uses.add(wsNode);
          else runtimeTargets.add(wsNode);
          recordWorkspaceRef(wsNode, spec.range);
        } else if (fileOwner) {
          externalImporterDeps.set(file, fileOwner);
        }
      }
      analyzedRootFiles.set(file, { ast: analysis.ast, workspaceRefs });
    } else if (fileOwner) {
      for (const [, name] of text.matchAll(/(?:\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)['"]((?:@[\w.-]+\/)?[A-Za-z0-9_][\w.-]*)/g)) {
        if (!isBuiltin(name) && !nodeByPackageName.has(name)) externalImporterDeps.set(file, fileOwner);
      }
    }
    if (importedFiles.size > 0) moduleImportEdges.set(file, importedFiles);
    if (runtimeTargets.size > 0) runtimeWorkspaceEdges.set(file, runtimeTargets);
    const imports = [...text.matchAll(ROOT_IMPORT)].map(([, path]) => relative(root, resolve(root, dirname(file), path)).split(sep).join('/'));
    const named = [...text.matchAll(ROOT_NAMED)].map(([, path, dir, name]) => path ?? `${dir}/${name}`);
    for (const [, directory] of text.matchAll(ROOT_GLOB)) {
      if (!await exists(join(root, directory))) continue;
      for await (const path of textFiles(join(root, directory))) named.push(relative(root, path).split(sep).join('/'));
    }
    for (const target of named) {
      if ((ROOT_DIRS.some((dir) => target.startsWith(dir)) || ROOT_CONFIG.test(target)) && target !== file) {
        recordImportMode(target, null);
      }
    }
    for (const target of [...imports, ...named]) {
      if ((ROOT_DIRS.some((dir) => target.startsWith(dir)) || ROOT_CONFIG.test(target)) && target !== file) {
        uses.add(target);
        pendingRootFiles.push(target);
      }
    }
  }
  const catalogDirect = edges.get(CATALOG) ?? new Set();
  const extraPeerCache = new Map();
  const loadPeerModule = async (peer) => {
    if (analyzedRootFiles.has(peer)) {
      return {
        kind: 'js',
        ast: analyzedRootFiles.get(peer).ast,
        imports: moduleImportEdges.get(peer) ?? new Set(),
        opaque: opaqueImporters.has(peer),
      };
    }
    if (extraPeerCache.has(peer)) return extraPeerCache.get(peer);
    if (peer.endsWith('.json') && await isRegularUnlinkedFile(root, peer)) {
      const info = { kind: 'json' };
      extraPeerCache.set(peer, info);
      return info;
    }
    if (!SOURCE_FILE.test(peer) || !await isRegularUnlinkedFile(root, peer)) {
      const info = { kind: 'opaque' };
      extraPeerCache.set(peer, info);
      return info;
    }
    const source = await readFile(join(root, peer), 'utf8').catch(() => null);
    if (source === null) {
      const info = { kind: 'opaque' };
      extraPeerCache.set(peer, info);
      return info;
    }
    const analysis = analyzeScriptFile(withoutLineComments(source, peer), peer);
    if (!analysis) {
      const info = { kind: 'opaque' };
      extraPeerCache.set(peer, info);
      return info;
    }
    const imports = new Set();
    let opaque = false;
    for (const spec of analysis.specifiers) {
      if (spec.value === null) {
        opaque = true;
        continue;
      }
      if (spec.value.startsWith('.') || spec.value.startsWith('/')) {
        const resolvedTarget = relative(root, resolve(root, dirname(peer), spec.value)).split(sep).join('/');
        if (resolvedTarget !== peer) imports.add(resolvedTarget);
        continue;
      }
      if (!isBuiltin(spec.value)) opaque = true;
    }
    const info = { kind: 'js', ast: analysis.ast, imports, opaque };
    extraPeerCache.set(peer, info);
    return info;
  };
  const coLoadedModules = async (start) => {
    const seen = new Set([start]);
    const stack = [start];
    let hasOpaque = false;
    while (stack.length) {
      const current = stack.pop();
      const info = await loadPeerModule(current);
      if (info.kind === 'opaque') {
        hasOpaque = true;
        continue;
      }
      if (info.kind === 'json') continue;
      if (info.opaque) hasOpaque = true;
      for (const next of info.imports) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return { seen, hasOpaque };
  };
  const entryReaches = new Map();
  for (const entry of catalogDirect) {
    if (!SOURCE_FILE.test(entry)) continue;
    entryReaches.set(entry, await coLoadedModules(entry));
  }
  const coLoadedMutatesArgv = async (targetFile) => {
    for (const [entry, { seen, hasOpaque }] of entryReaches) {
      if (!seen.has(targetFile)) continue;
      if (hasOpaque) return true;
      for (const peer of seen) {
        const info = await loadPeerModule(peer);
        if (info.kind === 'json') continue;
        if (info.kind !== 'js') return true;
        if (astMayMutateProcessArgv(info.ast, peer !== entry)) return true;
      }
    }
    return false;
  };
  const provisionerAppEdges = new Map();
  let e2eProvisionersNarrowable = false;
  const rangeContains = (outer, inner) => outer[0] <= inner[0] && inner[1] <= outer[1];
  for (const [file, { ast, workspaceRefs }] of analyzedRootFiles) {
    if (file === 'scripts/lib/e2e-test-data.mjs') {
      const mode = rootFileImportModes.get(file);
      let callersPreserveIdentity = Boolean(mode);
      if (callersPreserveIdentity) {
        for (const { file: importerFile, bindings: impBindings } of mode.importers) {
          const dispatchBindings = impBindings.filter((b) => b.imported === 'provisionTestData');
          if (dispatchBindings.length === 0) continue;
          if (!catalogDirect.has(importerFile) || await coLoadedMutatesArgv(importerFile)) {
            callersPreserveIdentity = false;
            break;
          }
          if ([...entryReaches].some(([entry, { seen }]) => entry !== importerFile && seen.has(importerFile))) {
            callersPreserveIdentity = false;
            break;
          }
          const callerAst = analyzedRootFiles.get(importerFile)?.ast;
          if (
            !ciCommandsPreserveMatrixApp(expandedByEntry.get(CATALOG), importerFile, root)
            || !dispatchBindings.every((b) => callerPreservesAppIdentity(callerAst, b.local))
          ) {
            callersPreserveIdentity = false;
            break;
          }
        }
      }
      const callerSafe = !catalogDirect.has(file) && Boolean(mode) && !mode.allExports && !mode.names.has('provisioners') && callersPreserveIdentity;
      const prov = callerSafe ? computeProvisionerOnlyRanges(ast) : { ok: false, entries: [] };
      e2eProvisionersNarrowable = prov.ok;
      if (!prov.ok || workspaceRefs.length === 0) continue;
      const allTargets = new Set();
      const eagerTargets = new Set();
      const targetOwners = new Map();
      for (const { target, range } of workspaceRefs) {
        allTargets.add(target);
        const matching = prov.entries.filter((entry) => rangeContains(entry.range, range));
        if (matching.length === 0 || matching.some((entry) => entry.apps.size === 0)) {
          eagerTargets.add(target);
        } else {
          const owners = targetOwners.get(target) ?? new Set();
          for (const entry of matching) for (const appId of entry.apps) owners.add(appId);
          targetOwners.set(target, owners);
        }
      }
      const lazyTargets = new Set([...allTargets].filter((target) => !eagerTargets.has(target)));
      if (lazyTargets.size > 0) {
        lazyWorkspaceEdges.set(file, lazyTargets);
        for (const target of lazyTargets) {
          for (const appId of targetOwners.get(target) ?? []) {
            const set = provisionerAppEdges.get(appId) ?? new Set();
            set.add(target);
            provisionerAppEdges.set(appId, set);
          }
        }
      }
      continue;
    }
    if (workspaceRefs.length === 0) continue;
    let skipRanges = [];
    if (!catalogDirect.has(file) && /^(?:scripts|test-utils|registry|test)\//.test(file)) {
      const mode = rootFileImportModes.get(file);
      if (mode && !mode.allExports && mode.names.size > 0) {
        skipRanges = computeUnreachableExportRanges(ast, mode.names, await coLoadedMutatesArgv(file));
      }
    }
    if (skipRanges.length === 0) continue;
    const allTargets = new Set();
    const eagerTargets = new Set();
    for (const { target, range } of workspaceRefs) {
      allTargets.add(target);
      if (!skipRanges.some((outer) => rangeContains(outer, range))) eagerTargets.add(target);
    }
    const lazyTargets = new Set([...allTargets].filter((target) => !eagerTargets.has(target)));
    if (lazyTargets.size > 0) lazyWorkspaceEdges.set(file, lazyTargets);
  }
  // `moduleUsers(path)`: the nodes that load one module of the shared component
  // package, or null for a file the planner ties to the whole package.
  // `appReaders(path)`: the app ids whose code names `path`, or a directory
  // holding it, in another app's directory. `appsNaming(identifier)`: the app
  // ids whose code names `identifier`, read on first use.
  let moduleUsers;
  // The root package.json scripts each ci.yml job runs, directly or through
  // local composite actions or other scripts (`pnpm <script>`; a package's own scripts are not root ones).
  const jobScripts = new Map();
  for (const [id, job] of Object.entries(ci?.jobs ?? {})) {
    jobScripts.set(id, namedByCommands(await expandJobSteps(job), rootScripts, root, rootPackageName).expanded);
  }
  const naming = new Map();
  const graph = {
    nodes: Object.freeze(nodes),
    edges,
    lazyWorkspaceEdges,
    provisionerAppEdges,
    e2eProvisionersNarrowable,
    runtimeWorkspaceEdges,
    externalImporterDeps,
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
