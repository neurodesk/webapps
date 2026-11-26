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
// Narrowing optimizations (omitting standalone workspace lint runners, or
// scoping scripts/lib/e2e-test-data.mjs provisioners per app) are gated by
// strict fail-closed allowlists matching the repository's canonical CI and
// script structure; anything outside those allowlists falls back to the
// conservative graph.

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
// sometimes a single file in one.
const SCRIPT_REFERENCE = /\b(packages|exes)(?:\/|['"],\s*['"])([\w.-]+)((?:\/[\w.-]+)*\/[\w.-]+\.(?:json|[cm]?[jt]s|md)(?![\w.-]))?/g;
// Documentation counts only where code reads that exact file.
const DOCUMENT_REFERENCE = /\b((?:packages|exes)\/[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+\.md)\b/g;
// A package's own tests change no app unless an app reads from them.
const PACKAGE_TESTS = /(?:\.\.\/)+(packages\/[\w.-]+\/tests?)\//g;
const BARE_IMPORT = /\bfrom\s+['"]((?:@[\w.-]+\/)?[\w.-]+)/g;
const ROOT_FILE = String.raw`[\w./-]+\.(?:[cm]?[jt]s|json|ya?ml)`;
const ROOT_PATH = new RegExp(String.raw`(?:\.\.\/)+((?:scripts|test-utils|registry|test)\/${ROOT_FILE})\b`, 'g');
// Root files name each other relative to themselves or from the repository root.
const ROOT_IMPORT = new RegExp(String.raw`['"\`](\.\.?\/${ROOT_FILE})['"\`]`, 'g');
const ROOT_NAMED = new RegExp(String.raw`(?:^|[\s'"\`(=])((?:scripts|test-utils|registry|test)\/${ROOT_FILE})\b|['"](registry|test-utils)['"],\s*['"](${ROOT_FILE})['"]`, 'gm');
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
// Standalone workspace lint script segment (matches `node ../../scripts/lint.mjs ...`
// without writing a quoted literal that triggers the ESLint isolation guard).
const STANDALONE_LINT_SEGMENT = /^\s*node\s+(?:\.\.\/)+scripts\/lint\.m?js(?:\s+--[\w=-]+)*\s*$/;
// Lint and mutation-testing configs: their own workflows read them, composite-site never does.
export const INDEPENDENT_CONFIG = /^(?:eslint|knip|stryker)\.config\.m?js$/;
export const CATALOG = '(catalog)';
export const SITE = '(site)';
// Wildcard sentinel recorded in `jobScripts` / `workspaceRootScripts` when a
// command runs outside the strict pnpm allowlist (npm, yarn, dynamic scripts,
// unknown flags, lifecycle hooks, or opaque local actions).
export const ANY_ROOT_SCRIPT = '*';
// The ci.yml jobs that run once per selected app.
export const CATALOG_JOBS = ['app-tests', 'browser-e2e', 'browser-e2e-gpu'];
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'];
const AST_SKIP = new Set(['loc', 'range', 'start', 'end', 'tokens', 'comments']);

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

// ---------------------------------------------------------------------------
// AST parsing & strict e2e-test-data.mjs provisioner isolation helpers
// ---------------------------------------------------------------------------

function moduleExportName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  return null;
}

function isFunctionNode(node) {
  return Boolean(
    node
    && (node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'),
  );
}

function analyzeScriptFile(source, file) {
  let ast;
  try {
    ast = sourceParser.parse(source, { filePath: file, sourceType: 'module' });
  } catch {
    return null;
  }
  const literals = [];
  const specifiers = [];
  const recordSpecifier = (node, kind, namedImports = null, localBindings = null) => {
    if (!node) return;
    if (node.type === 'Literal' && typeof node.value === 'string') {
      specifiers.push({ value: node.value, kind, range: node.range, namedImports, localBindings });
    } else if (node.type === 'TemplateLiteral' && node.expressions.length === 0 && node.quasis.length === 1) {
      specifiers.push({ value: node.quasis[0].value.cooked ?? node.quasis[0].value.raw, kind, range: node.range, namedImports, localBindings });
    } else {
      specifiers.push({ value: null, kind, range: node.range, namedImports: null, localBindings: null });
    }
  };
  // Collect authentic named `readFile`/`readFileSync` and `join`/`resolve`
  // bindings imported from Node built-in `fs`/`path` modules. Reject any file
  // that imports mutable default/namespace `fs`/`path` objects or
  // `syncBuiltinESMExports`, or shadows/reassigns those local binding names.
  const fsModules = new Set(['node:fs', 'fs', 'node:fs/promises', 'fs/promises']);
  const pathModules = new Set(['node:path', 'path', 'node:path/posix', 'path/posix']);
  const moduleBuiltins = new Set(['node:module', 'module']);
  const readFileIds = new Set();
  const pathJoinIds = new Set();
  let hasMutableBuiltinImport = /\bsyncBuiltinESMExports\b/.test(source);
  for (const stmt of ast.body ?? []) {
    if (stmt.type !== 'ImportDeclaration' || stmt.source?.type !== 'Literal') continue;
    const mod = stmt.source.value;
    if (moduleBuiltins.has(mod)) {
      hasMutableBuiltinImport = true;
    } else if (fsModules.has(mod)) {
      for (const spec of stmt.specifiers ?? []) {
        if (spec.type === 'ImportSpecifier' && (moduleExportName(spec.imported) === 'readFile' || moduleExportName(spec.imported) === 'readFileSync') && spec.local?.name) {
          readFileIds.add(spec.local.name);
        } else if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
          hasMutableBuiltinImport = true;
        }
      }
    } else if (pathModules.has(mod)) {
      for (const spec of stmt.specifiers ?? []) {
        if (spec.type === 'ImportSpecifier' && (moduleExportName(spec.imported) === 'join' || moduleExportName(spec.imported) === 'resolve') && spec.local?.name) {
          pathJoinIds.add(spec.local.name);
        } else if (spec.type === 'ImportDefaultSpecifier' || spec.type === 'ImportNamespaceSpecifier') {
          hasMutableBuiltinImport = true;
        }
      }
    }
  }
  const trackedBindings = new Set([...readFileIds, ...pathJoinIds]);
  const taintedBindings = new Set();
  if (!hasMutableBuiltinImport && trackedBindings.size > 0) {
    const taint = (name) => {
      if (trackedBindings.has(name)) taintedBindings.add(name);
    };
    const scanTaint = (node, anc = []) => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) scanTaint(item, anc);
        return;
      }
      if (node.type === 'ImportDeclaration') return;
      if (node.type === 'VariableDeclarator' && node.id) collectPatternNames(node.id, taint);
      if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id?.name) taint(node.id.name);
      if (isFunctionNode(node) && Array.isArray(node.params)) {
        for (const param of node.params) collectPatternNames(param, taint);
      }
      if (node.type === 'CatchClause' && node.param) collectPatternNames(node.param, taint);
      if (node.type === 'Identifier' && trackedBindings.has(node.name) && isWriteTarget(node, anc)) {
        taint(node.name);
      }
      anc.push(node);
      for (const key of Object.keys(node)) {
        if (!AST_SKIP.has(key)) scanTaint(node[key], anc);
      }
      anc.pop();
    };
    scanTaint(ast);
  }

  const ancestors = [];
  const isPathJoinCall = (call) => {
    if (call?.type !== 'CallExpression') return false;
    const callee = call.callee;
    const name = callee?.type === 'Identifier' ? callee.name
      : (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier' ? callee.property.name : null);
    return name === 'join' || name === 'resolve' || name === 'concat';
  };
  const isAuthenticPathJoinCall = (call) => Boolean(
    !hasMutableBuiltinImport
    && call?.type === 'CallExpression'
    && call.callee?.type === 'Identifier'
    && pathJoinIds.has(call.callee.name)
    && !taintedBindings.has(call.callee.name),
  );
  const isAuthenticReadFileCall = (call) => Boolean(
    !hasMutableBuiltinImport
    && call?.type === 'CallExpression'
    && call.callee?.type === 'Identifier'
    && readFileIds.has(call.callee.name)
    && !taintedBindings.has(call.callee.name),
  );
  const isDirectJsonRead = (node) => {
    const parent = ancestors[ancestors.length - 1];
    if (!parent) return false;
    if (parent.type === 'ImportDeclaration' && parent.source === node) return true;
    if (isAuthenticReadFileCall(parent) && parent.arguments?.[0] === node) return true;
    if (
      isAuthenticPathJoinCall(parent)
      && parent.arguments.indexOf(node) === parent.arguments.length - 1
    ) {
      const grand = ancestors[ancestors.length - 2];
      if (isAuthenticReadFileCall(grand) && grand.arguments?.[0] === parent) return true;
    }
    return false;
  };
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if ((node.type === 'Literal' && typeof node.value === 'string' && Array.isArray(node.range)) || (node.type === 'TemplateLiteral' && Array.isArray(node.range))) {
      const parent = ancestors[ancestors.length - 1];
      const hasExpr = node.type === 'TemplateLiteral' && node.expressions.length > 0;
      const inBinaryPlus = parent?.type === 'BinaryExpression' && parent.operator === '+';
      const nonLastPathArg = isPathJoinCall(parent) && parent.arguments.indexOf(node) < parent.arguments.length - 1;
      const inDirname = ancestors.some((a) => a?.type === 'CallExpression' && (
        (a.callee?.type === 'Identifier' && a.callee.name === 'dirname')
        || (a.callee?.type === 'MemberExpression' && !a.callee.computed && a.callee.property?.name === 'dirname')
      ));
      literals.push({
        start: node.range[0],
        end: node.range[1],
        standalone: !hasExpr && !inBinaryPlus && !nonLastPathArg,
        directJsonRead: !hasExpr && isDirectJsonRead(node),
        derivedJson: inDirname,
      });
    } else if (node.type === 'ImportDeclaration') {
      const specs = node.specifiers ?? [];
      const onlyNamed = specs.length > 0 && specs.every((s) => s.type === 'ImportSpecifier');
      const namedImports = onlyNamed ? specs.map((s) => moduleExportName(s.imported)).filter(Boolean) : null;
      const localBindings = onlyNamed
        ? specs.map((s) => ({ imported: moduleExportName(s.imported), local: s.local?.name })).filter((b) => b.imported && b.local)
        : null;
      recordSpecifier(node.source, 'import', namedImports, localBindings);
    } else if (node.type === 'ExportNamedDeclaration' && node.source) {
      const specs = node.specifiers ?? [];
      const onlyNamed = specs.length > 0 && specs.every((s) => s.type === 'ExportSpecifier');
      recordSpecifier(node.source, 'reexport', onlyNamed ? specs.map((s) => moduleExportName(s.local)).filter(Boolean) : null);
    } else if (node.type === 'ExportAllDeclaration' && node.source) {
      recordSpecifier(node.source, 'reexport', null);
    } else if (node.type === 'ImportExpression') {
      recordSpecifier(node.source, 'dynamic', null);
    } else if (
      node.type === 'CallExpression'
      && node.arguments?.length > 0
      && (
        (node.callee?.type === 'Identifier' && node.callee.name === 'require')
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
      recordSpecifier(node.arguments[0], 'require', null);
    }
    ancestors.push(node);
    for (const key of Object.keys(node)) {
      if (!AST_SKIP.has(key)) visit(node[key]);
    }
    ancestors.pop();
  };
  visit(ast);
  return { ast, literals, specifiers, builtinMutator: hasMutableBuiltinImport };
}

function matchScriptLiteral(text, match, literals) {
  const start = match.index;
  const end = match.index + match[0].length;
  const isJson = Boolean(match[3]?.endsWith('.json'));
  const after = text[end];
  if (after && !/[\s'"`),;:\]}]/.test(after)) return { complete: false, derivedJson: true };
  if (literals !== null) {
    const litAtEnd = literals.find((lit) => lit.start < end && end <= lit.end);
    if (litAtEnd) {
      if (isJson ? !litAtEnd.directJsonRead : !litAtEnd.standalone) return { complete: false, derivedJson: true };
      const tail = text.slice(end, litAtEnd.end - 1);
      if (tail.length > 0 && !(tail === '\n' && text.slice(litAtEnd.start + 1, start).includes('//'))) return { complete: false, derivedJson: true };
      return { complete: true, derivedJson: isJson ? true : litAtEnd.derivedJson };
    }
    return { complete: !isJson, derivedJson: isJson };
  }
  return { complete: !isJson, derivedJson: true };
}

function walkAstIdentifiers(node, onId, ancestors = []) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const item of node) walkAstIdentifiers(item, onId, ancestors);
    return;
  }
  if (node.type === 'ImportDeclaration') return;
  if (node.type === 'Identifier') {
    const parent = ancestors[ancestors.length - 1];
    const isNonComputedProp =
      (parent?.type === 'MemberExpression' && !parent.computed && parent.property === node)
      || (parent?.type === 'Property' && !parent.computed && parent.key === node)
      || (parent?.type === 'MethodDefinition' && !parent.computed && parent.key === node)
      || (parent?.type === 'PropertyDefinition' && !parent.computed && parent.key === node)
      || parent?.type === 'LabeledStatement'
      || parent?.type === 'BreakStatement'
      || parent?.type === 'ContinueStatement';
    if (!isNonComputedProp) onId(node, ancestors);
    return;
  }
  ancestors.push(node);
  for (const key of Object.keys(node)) {
    if (!AST_SKIP.has(key)) walkAstIdentifiers(node[key], onId, ancestors);
  }
  ancestors.pop();
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

const SAFE_PROCESS_READ_PROPS = new Set(['pid', 'version', 'versions', 'platform', 'arch', 'env', 'execPath', 'stdout', 'stderr', 'exit']);
const UNSAFE_PROCESS_MODULES = new Set([
  'process', 'node:process',
  'module', 'node:module',
  'vm', 'node:vm',
  'inspector', 'node:inspector',
  'inspector/promises', 'node:inspector/promises',
  'v8', 'node:v8',
]);
const UNSAFE_GLOBAL_PROPS = new Set(['process', 'globalThis', 'global', 'Reflect', 'eval', 'Function']);

function isSafeProcessUse(idNode, ancestors) {
  const parent = ancestors[ancestors.length - 1];
  const grandparent = ancestors[ancestors.length - 2];
  if (parent?.type !== 'MemberExpression' || parent.object !== idNode || parent.computed) return false;
  const prop = parent.property?.type === 'Identifier' ? parent.property.name : null;
  if (!prop || isWriteTarget(parent, ancestors.slice(0, -1))) return false;
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

function isProcessArgv1Node(node) {
  return Boolean(
    node?.type === 'MemberExpression'
    && node.computed
    && node.property?.type === 'Literal'
    && node.property.value === 1
    && node.object?.type === 'MemberExpression'
    && !node.object.computed
    && node.object.object?.type === 'Identifier'
    && node.object.object.name === 'process'
    && node.object.property?.type === 'Identifier'
    && node.object.property.name === 'argv',
  );
}

function esmGuardBindingAuth(ast) {
  let pathToFileUrlImported = false;
  let resolveImported = false;
  let shadowedPathToFileUrl = false;
  let shadowedResolve = false;
  let processShadowed = false;
  const checkDeclName = (name) => {
    if (name === 'pathToFileURL') shadowedPathToFileUrl = true;
    else if (name === 'resolve') shadowedResolve = true;
    else if (name === 'process') processShadowed = true;
  };
  for (const stmt of ast?.body ?? []) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const src = stmt.source?.type === 'Literal' ? stmt.source.value : null;
    for (const spec of stmt.specifiers ?? []) {
      const local = spec.local?.name;
      if (!local) continue;
      if (local === 'pathToFileURL') {
        if (spec.type === 'ImportSpecifier' && moduleExportName(spec.imported) === 'pathToFileURL' && (src === 'node:url' || src === 'url')) {
          pathToFileUrlImported = true;
        } else {
          shadowedPathToFileUrl = true;
        }
      } else if (local === 'resolve') {
        if (spec.type === 'ImportSpecifier' && moduleExportName(spec.imported) === 'resolve' && (src === 'node:path' || src === 'path')) {
          resolveImported = true;
        } else {
          shadowedResolve = true;
        }
      } else if (local === 'process') {
        processShadowed = true;
      }
    }
  }
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

function isStrictEsmMainGuard(stmt, bindingAuth) {
  if (stmt?.type !== 'IfStatement' || !bindingAuth || bindingAuth.processShadowed) return false;
  if (!bindingAuth.hasAuthenticPathToFileUrl) return false;
  let test = stmt.test;
  if (test?.type === 'LogicalExpression' && test.operator === '&&' && isProcessArgv1Node(test.left)) {
    test = test.right;
  }
  if (test?.type !== 'BinaryExpression' || test.operator !== '===') return false;
  const isMetaUrl = (n) => n?.type === 'MemberExpression' && !n.computed && n.object?.type === 'MetaProperty' && n.property?.name === 'url';
  const other = isMetaUrl(test.left) ? test.right : isMetaUrl(test.right) ? test.left : null;
  if (!other || other.type !== 'MemberExpression' || other.computed || other.property?.name !== 'href') return false;
  const call = other.object;
  if (call?.type !== 'CallExpression' || call.callee?.type !== 'Identifier' || call.callee.name !== 'pathToFileURL' || call.arguments?.length !== 1) return false;
  const arg = call.arguments[0];
  if (isProcessArgv1Node(arg)) return true;
  return Boolean(
    bindingAuth.hasAuthenticResolve
    && arg?.type === 'CallExpression'
    && arg.callee?.type === 'Identifier'
    && arg.callee.name === 'resolve'
    && arg.arguments?.length === 1
    && isProcessArgv1Node(arg.arguments[0]),
  );
}

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

function collectTopLevelBindings(ast) {
  const bindings = new Map();
  const exportedNames = new Set();
  for (const stmt of ast?.body ?? []) {
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
        const exported = moduleExportName(spec.exported);
        if (exported) exportedNames.add(exported);
        if (spec.local?.name) exportedNames.add(spec.local.name);
      }
    } else if (stmt.type === 'ExportDefaultDeclaration') {
      if (stmt.declaration?.id?.name) {
        bindings.set(stmt.declaration.id.name, stmt.declaration);
        exportedNames.add(stmt.declaration.id.name);
      }
    } else if (stmt.type === 'FunctionDeclaration' && stmt.id?.name) {
      bindings.set(stmt.id.name, stmt.id ? stmt : null);
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

const SAFE_E2E_CLI_BUILTINS = new Set([
  'node:path', 'path',
  'node:fs', 'fs',
  'node:fs/promises', 'fs/promises',
  'node:url', 'url',
  'node:crypto', 'crypto',
  'node:os', 'os',
  'node:zlib', 'zlib',
  'node:child_process', 'child_process',
  'node:assert/strict', 'assert/strict',
]);

// Strict fail-closed caller allowlist for `scripts/e2e-test-data.mjs`:
// - imports ONLY safe node:* builtins and `{ provisionTestData }` from `./lib/e2e-test-data.mjs`
// - reads `app` from `process.argv[2]` or `process.argv.slice(2)[.filter((a) => a !== '-...')]`
// - never shadows/reassigns `app` or mutates `process`/`process.argv`
// - calls `provisionTestData(app, ...)` only at module top level.
function callerPreservesAppIdentity(ast, localFnName) {
  if (!ast || !localFnName || astMayMutateProcessArgv(ast, false)) return false;
  for (const stmt of ast.body ?? []) {
    if (stmt.type !== 'ImportDeclaration') continue;
    const src = stmt.source?.type === 'Literal' ? stmt.source.value : null;
    if (!src) return false;
    if (SAFE_E2E_CLI_BUILTINS.has(src)) continue;
    if (src === './lib/e2e-test-data.mjs') {
      const specs = stmt.specifiers ?? [];
      if (specs.length === 0 || !specs.every((s) => s.type === 'ImportSpecifier' && moduleExportName(s.imported) === 'provisionTestData')) {
        return false;
      }
      continue;
    }
    return false;
  }
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
  const shadowed = new Set();
  const checkShadow = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) checkShadow(item);
      return;
    }
    if (node.type === 'ImportExpression') {
      shadowed.add('*');
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
  if (shadowed.has('*')) return false;
  let valid = true;
  let sawCall = false;
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
    if (okCall) sawCall = true;
    else valid = false;
  });
  return valid && sawCall;
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
  let provisionersDecls = 0;
  let dispatchDecls = 0;
  for (const stmt of ast.body ?? []) {
    const inner = stmt.type === 'ExportNamedDeclaration' ? stmt.declaration : stmt;
    if (inner?.type === 'FunctionDeclaration' && inner.id?.name) {
      if (inner.id.name === 'provisioners') provisionersDecls++;
      if (inner.id.name === 'provisionTestData') dispatchDecls++;
    } else if (inner?.type === 'VariableDeclaration') {
      for (const decl of inner.declarations ?? []) {
        collectPatternNames(decl.id, (name) => {
          if (name === 'provisioners') provisionersDecls++;
          if (name === 'provisionTestData') dispatchDecls++;
        });
      }
    }
    if (stmt.type === 'ExportNamedDeclaration') {
      for (const spec of stmt.specifiers ?? []) {
        const exported = moduleExportName(spec.exported);
        if (spec.local?.name === 'provisioners' && exported !== 'provisioners') return { ok: false, entries: [] };
        if (exported === 'provisionTestData' && spec.local?.name !== 'provisionTestData') return { ok: false, entries: [] };
      }
    } else if (stmt.type === 'ExportDefaultDeclaration' && stmt.declaration?.type === 'Identifier' && stmt.declaration.name === 'provisioners') {
      return { ok: false, entries: [] };
    }
  }
  if (provisionersDecls !== 1 || dispatchDecls !== 1) return { ok: false, entries: [] };
  const provisionFnApps = new Map();
  const provisionIdentApps = new Map();
  const recordProvisionProp = (obj, appId) => {
    if (obj?.type !== 'ObjectExpression') return;
    for (const prop of obj.properties ?? []) {
      if (prop.type !== 'Property' || prop.computed) continue;
      const key = prop.key?.type === 'Identifier' ? prop.key.name : prop.key?.type === 'Literal' ? String(prop.key.value) : null;
      if (key === 'provision') {
        if (isFunctionNode(prop.value) && Array.isArray(prop.value.range)) {
          const apps = provisionFnApps.get(prop.value) ?? new Set();
          apps.add(appId);
          provisionFnApps.set(prop.value, apps);
        } else if (prop.value?.type === 'Identifier') {
          const apps = provisionIdentApps.get(prop.value.name) ?? new Set();
          apps.add(appId);
          provisionIdentApps.set(prop.value.name, apps);
        }
      } else if (key === 'cpu' && prop.value?.type === 'ObjectExpression') {
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
  const dispatchNode = bindings.get('provisionTestData');
  const dispatchParam = isFunctionNode(dispatchNode) && dispatchNode.params?.[0]?.type === 'Identifier'
    ? dispatchNode.params[0].name
    : null;
  if (!dispatchNode || !dispatchParam) return { ok: false, entries: [] };
  let dispatchParamReassigned = false;
  const checkDispatchParam = (node, anc = []) => {
    if (dispatchParamReassigned || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) checkDispatchParam(item, anc);
      return;
    }
    const markIfMatch = (name) => {
      if (name === dispatchParam) dispatchParamReassigned = true;
    };
    if (node.type === 'VariableDeclarator' && node.id) collectPatternNames(node.id, markIfMatch);
    if ((node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ClassDeclaration' || node.type === 'ClassExpression') && node.id?.name) {
      markIfMatch(node.id.name);
    }
    if (isFunctionNode(node) && Array.isArray(node.params)) {
      for (const param of node.params) collectPatternNames(param, markIfMatch);
    }
    if (node.type === 'CatchClause' && node.param) collectPatternNames(node.param, markIfMatch);
    if (node.type === 'Identifier' && (node.name === dispatchParam || node.name === 'arguments' || node.name === 'eval')) {
      if (node.name !== dispatchParam || isWriteTarget(node, anc)) dispatchParamReassigned = true;
    }
    anc.push(node);
    for (const key of Object.keys(node)) {
      if (!AST_SKIP.has(key)) checkDispatchParam(node[key], anc);
    }
    anc.pop();
  };
  for (const param of (dispatchNode.params ?? []).slice(1)) {
    checkDispatchParam(param);
  }
  checkDispatchParam(dispatchNode.body);
  if (dispatchParamReassigned) return { ok: false, entries: [] };
  const provisionFns = new Set(provisionFnApps.keys());
  let provisionersUsedSafely = true;
  walkAstIdentifiers(ast, (idNode, ancestors) => {
    if (!provisionersUsedSafely) return;
    if (idNode.name === 'eval') {
      provisionersUsedSafely = false;
      return;
    }
    if (idNode.name === 'provisionTestData') {
      if (isWriteTarget(idNode, ancestors)) provisionersUsedSafely = false;
      return;
    }
    if (idNode.name !== 'provisioners') return;
    const parent = ancestors[ancestors.length - 1];
    if (parent?.type === 'VariableDeclarator' && parent.id === idNode) return;
    if (parent?.type === 'ExportSpecifier' && (parent.local === idNode || parent.exported === idNode)) return;
    const insideDispatch = ancestors.includes(dispatchNode);
    const isIdentityLookup =
      insideDispatch
      && parent?.type === 'MemberExpression'
      && parent.object === idNode
      && parent.computed
      && parent.property?.type === 'Identifier'
      && parent.property.name === dispatchParam;
    if (!isIdentityLookup) provisionersUsedSafely = false;
  });
  if (!provisionersUsedSafely) return { ok: false, entries: [] };

  const privateFns = new Map();
  for (const [name, node] of bindings) {
    if (!exportedNames.has(name) && isFunctionNode(node) && Array.isArray(node.range)) {
      privateFns.set(name, node);
    }
  }
  const outsideRefs = new Set();
  const fnCallers = new Map([...privateFns.keys()].map((name) => [name, new Set()]));
  const fnDirectApps = new Map([...privateFns.keys()].map((name) => [name, new Set(provisionIdentApps.get(name) ?? [])]));
  const enclosingPrivate = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      for (const [name, fnNode] of privateFns) {
        if (ancestors[i] === fnNode) return name;
      }
    }
    return null;
  };
  const enclosingProvisionApps = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      if (provisionFns.has(ancestors[i])) return provisionFnApps.get(ancestors[i]);
    }
    return null;
  };
  walkAstIdentifiers(ast, (idNode, ancestors) => {
    const name = idNode.name;
    if (!privateFns.has(name)) return;
    const fnNode = privateFns.get(name);
    const parent = ancestors[ancestors.length - 1];
    if (parent === fnNode && fnNode.id === idNode) return;
    if (parent?.type === 'VariableDeclarator' && parent.id === idNode && parent.init === fnNode) return;
    if (parent?.type === 'Property' && parent.value === idNode && !parent.computed && parent.key?.name === 'provision' && ancestors.includes(provisionersObj)) return;
    const provApps = enclosingProvisionApps(ancestors);
    if (provApps) {
      for (const appId of provApps) fnDirectApps.get(name).add(appId);
      return;
    }
    const caller = enclosingPrivate(ancestors);
    if (caller) {
      if (caller !== name) fnCallers.get(name).add(caller);
      return;
    }
    outsideRefs.add(name);
  });
  const reachableFromOutside = new Set(outsideRefs);
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, callers] of fnCallers) {
      if (reachableFromOutside.has(name)) continue;
      if ([...callers].some((caller) => reachableFromOutside.has(caller))) {
        reachableFromOutside.add(name);
        changed = true;
      }
    }
  }
  const fnOwners = new Map([...privateFns.keys()].map((name) => [name, new Set(fnDirectApps.get(name))]));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, callers] of fnCallers) {
      if (reachableFromOutside.has(name)) continue;
      const owners = fnOwners.get(name);
      for (const caller of callers) {
        for (const appId of fnOwners.get(caller) ?? []) {
          if (!owners.has(appId)) {
            owners.add(appId);
            changed = true;
          }
        }
      }
    }
  }
  const entries = [...provisionFnApps].map(([fn, apps]) => ({ range: fn.range, apps }));
  for (const [name, fnNode] of privateFns) {
    if (!reachableFromOutside.has(name) && fnOwners.get(name).size > 0) {
      entries.push({ range: fnNode.range, apps: fnOwners.get(name) });
    }
  }
  return { ok: true, entries };
}

// For a non-entry root library imported ONLY via named exports (such as
// `scripts/desktop/scientific-evidence.mjs`), return ranges of top-level
// functions and authenticated strict ESM main guards unreachable from those
// imported exports.
function computeUnreachableExportRanges(ast, importedNames, argvMutated = false) {
  if (!ast || !importedNames || importedNames.size === 0) return [];
  const { bindings } = collectTopLevelBindings(ast);
  const bindingAuth = esmGuardBindingAuth(ast);
  const safeMainGuard = !argvMutated && !astMayMutateProcessArgv(ast, true);
  const topFns = new Map();
  for (const [name, node] of bindings) {
    if (isFunctionNode(node) && Array.isArray(node.range)) topFns.set(name, node);
  }
  const guardStmts = new Set();
  const guardRanges = [];
  if (safeMainGuard) {
    for (const stmt of ast.body ?? []) {
      if (isStrictEsmMainGuard(stmt, bindingAuth) && Array.isArray(stmt.consequent?.range)) {
        guardStmts.add(stmt.consequent);
        guardRanges.push(stmt.consequent.range);
      }
    }
  }
  const reachable = new Set([...importedNames].filter((name) => topFns.has(name)));
  const fnCallees = new Map([...topFns.keys()].map((name) => [name, new Set()]));
  const enclosingTopFn = (ancestors) => {
    for (let i = ancestors.length - 1; i >= 0; i--) {
      for (const [name, fnNode] of topFns) {
        if (ancestors[i] === fnNode) return name;
      }
    }
    return null;
  };
  walkAstIdentifiers(ast, (idNode, ancestors) => {
    const name = idNode.name;
    if (!topFns.has(name)) return;
    const fnNode = topFns.get(name);
    const parent = ancestors[ancestors.length - 1];
    if (parent === fnNode && fnNode.id === idNode) return;
    if (parent?.type === 'VariableDeclarator' && parent.id === idNode && parent.init === fnNode) return;
    if (parent?.type === 'ExportSpecifier') return;
    if (ancestors.some((a) => guardStmts.has(a))) return;
    const caller = enclosingTopFn(ancestors);
    if (caller) {
      if (caller !== name) fnCallees.get(caller).add(name);
      return;
    }
    reachable.add(name);
  });
  for (let changed = true; changed;) {
    changed = false;
    for (const name of [...reachable]) {
      for (const callee of fnCallees.get(name) ?? []) {
        if (!reachable.has(callee)) {
          reachable.add(callee);
          changed = true;
        }
      }
    }
  }
  const ranges = [...guardRanges];
  for (const [name, fnNode] of topFns) {
    if (!reachable.has(name)) ranges.push(fnNode.range);
  }
  return ranges;
}

// ---------------------------------------------------------------------------
// Strict fail-closed CI command, root-script, lint, and e2e allowlists
// ---------------------------------------------------------------------------

const INSTALL_HOOK_NAMES = new Set(['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare', 'pnpm:devPreinstall']);
const PACK_HOOK_NAMES = new Set(['prepack', 'pack', 'postpack', 'preprepare', 'prepare', 'postprepare']);
const PUBLISH_HOOK_NAMES = new Set(['prepublishOnly', 'prepack', 'prepare', 'postpack', 'publish', 'postpublish', 'preprepare', 'postprepare', 'prepublish']);
const RESTART_HOOK_NAMES = new Set(['prestop', 'stop', 'poststop', 'prestart', 'start', 'poststart']);

function rootManifestHasAnyLifecycleHook(rootScripts) {
  if (!rootScripts) return false;
  return Object.keys(rootScripts).some((name) => (
    INSTALL_HOOK_NAMES.has(name)
    || name.startsWith('pre')
    || name.startsWith('post')
  ));
}

function rootManifestHasHookFor(rootScripts, scriptName) {
  if (!rootScripts || !scriptName) return false;
  if (Object.hasOwn(rootScripts, `pre${scriptName}`) || Object.hasOwn(rootScripts, `post${scriptName}`)) return true;
  if (scriptName === 'install' && [...INSTALL_HOOK_NAMES].some((h) => h !== 'install' && Object.hasOwn(rootScripts, h))) return true;
  if (scriptName === 'pack' && [...PACK_HOOK_NAMES].some((h) => h !== 'pack' && Object.hasOwn(rootScripts, h))) return true;
  if (scriptName === 'publish' && [...PUBLISH_HOOK_NAMES].some((h) => h !== 'publish' && Object.hasOwn(rootScripts, h))) return true;
  if (scriptName === 'restart' && [...RESTART_HOOK_NAMES].some((h) => Object.hasOwn(rootScripts, h))) return true;
  return false;
}

function isRepoRootWorkingDir(workingDir, root) {
  if (!workingDir) return true;
  const trimmed = typeof workingDir === 'string' ? workingDir.trim() : '';
  if (!trimmed) return true;
  if (/[$`*?[{]|\$\{\{/.test(trimmed)) return false;
  if (!root) return trimmed === '.' || trimmed === './';
  const rel = relative(root, resolve(root, trimmed)).split(sep).join('/').replace(/\/+$/, '');
  return rel === '' || rel === '.';
}

// Strict allowlist for non-root `pnpm --filter ...` workspace invocations so
// `namedByCommands` ignores workspace scripts cleanly and fails closed on
// anything else (root filters, `--filter-prod`, `-w`, `--dir`, `npm`, `yarn`,
// `recursive`, dynamic root scripts, or lifecycle hooks).
const ALLOWED_FILTER_TARGET = /^(?:@[\w.-]+\/[\w.-]+|'!(?:@[\w.-]+\/)?[\w.-]+'|'\.\/(?:packages|apps|exes)\/\*'|"\$APP"|\$\{\{\s*matrix\.app\s*\}\}|[A-Za-z0-9][\w.-]*)$/;
const ALLOWED_FILTERED_PNPM = /\bpnpm((?:\s+--filter\s+(?:'[^']+'|"[^"]+"|\$\{\{\s*matrix\.app\s*\}\}|\S+))+)\s+(?:(run)\s+)?(?:"(\$[A-Za-z_]\w*)"|([\w:.-]+))(?=\s|$|[;&|])/g;
const SIMPLE_ROOT_PNPM = /\bpnpm(?:\s+(?:run))?\s+([\w:-]+)(?=\s|$|[;&|])/g;
const PNPM_INSTALL_WORD = new Set(['install', 'i', 'ci', 'add', 'install-test', 'it', 'install-clean', 'ic', 'clean-install', 'rebuild', 'rb', 'up', 'update', 'remove', 'rm', 'uninstall', 'un', 'pack', 'publish']);
const PNPM_DISALLOWED_SUBCOMMAND = new Set(['run', 'exec', 'dlx', 'create', 'recursive', 'multi', 'm']);
const PINNED_LINT_FREE_ACTIONS = new Set([
  '.github/actions/composite-site',
  '.github/actions/setup-playwright',
  '.github/actions/setup-wasm-opt',
  '.github/actions/setup-wasm-pack',
]);

const CANONICAL_APP_TEST_CMD = /^pnpm --filter "\$APP" run "\$TEST_SCRIPT"$/;

function isNonRootFilterGroup(filterChunk, { rootPackageName, ownEnv = null, wholeCmd = '' }) {
  const matches = [...filterChunk.matchAll(/--filter\s+('[^']+'|"[^"]+"|\$\{\{\s*matrix\.app\s*\}\}|\S+)/g)];
  if (matches.length === 0) return false;
  const rootUnscoped = rootPackageName && rootPackageName.includes('/') ? rootPackageName.split('/').pop() : null;
  let hasPositive = false;
  const allSafe = matches.every(([, raw]) => {
    if (!ALLOWED_FILTER_TARGET.test(raw)) return false;
    if (raw === '"$APP"') {
      hasPositive = true;
      return Boolean(
        CANONICAL_APP_TEST_CMD.test(wholeCmd)
        && ownEnv
        && Object.hasOwn(ownEnv, 'APP')
        && String(ownEnv.APP).trim() === '${{ matrix.app }}',
      );
    }
    if (/^\$\{\{\s*matrix\.app\s*\}\}$/.test(raw)) {
      hasPositive = true;
      return true;
    }
    const unquoted = raw.replace(/^['"]|['"]$/g, '');
    if (unquoted.includes('..')) return false;
    if (unquoted.startsWith('!')) return true;
    if (/^\.\/(?:packages|apps|exes)\/\*$/.test(unquoted)) {
      hasPositive = true;
      return true;
    }
    if (unquoted === '.' || unquoted === './' || unquoted === rootPackageName || (rootUnscoped && unquoted === rootUnscoped)) {
      return false;
    }
    hasPositive = true;
    return true;
  });
  return allSafe && hasPositive;
}

function analyzeCommandRootScripts(step, { root, rootPackageName, nodeByPackageName, rootScripts, releaseTestScripts }) {
  const cmd = step.cmd ?? '';
  if (step.opaqueAction) return { scripts: [], failedClosed: true, mayInvokeLint: true };
  if (!(step.actionDir && PINNED_LINT_FREE_ACTIONS.has(step.actionDir)) && /\b(?:sh|bash|dash|zsh|eval|exec|source)\b/.test(cmd)) {
    return { scripts: [], failedClosed: true, mayInvokeLint: true };
  }
  let failedClosed = false;
  let mayInvokeLint = /\blint\b/i.test(cmd);
  const scripts = [];
  if (/\b(?:npm|yarn)\b/.test(cmd)) {
    return { scripts: [], failedClosed: true, mayInvokeLint: true };
  }
  const wholeCmd = cmd.trim();
  const stripped = cmd.replace(ALLOWED_FILTERED_PNPM, (full, filterChunk, _runKw, dynScript, litScript) => {
    if (!isNonRootFilterGroup(filterChunk, { rootPackageName, nodeByPackageName, ownEnv: step.ownEnv, wholeCmd })) return full;
    if (litScript && (PNPM_INSTALL_WORD.has(litScript) || PNPM_DISALLOWED_SUBCOMMAND.has(litScript))) return full;
    if (dynScript) {
      // Allow only `pnpm --filter "$APP" run "$TEST_SCRIPT"` as the entire step
      // command when ownEnv binds TEST_SCRIPT to `${{ matrix.release_test }}`
      // and releaseTestScripts is lint-free.
      const boundReleaseTest = Boolean(
        CANONICAL_APP_TEST_CMD.test(wholeCmd)
        && step.ownEnv
        && Object.hasOwn(step.ownEnv, 'TEST_SCRIPT')
        && String(step.ownEnv.TEST_SCRIPT).trim() === '${{ matrix.release_test }}',
      );
      if (dynScript !== '$TEST_SCRIPT' || !boundReleaseTest || !releaseTestScripts || releaseTestScripts.has('lint')) {
        mayInvokeLint = true;
      }
      return '';
    }
    if (litScript === 'lint') mayInvokeLint = true;
    return '';
  });
  const atRoot = isRepoRootWorkingDir(step.workingDir, root);
  if (/\bpnpm\b/.test(stripped)) {
    const remaining = stripped.replace(SIMPLE_ROOT_PNPM, (full, scriptName) => {
      if (!atRoot || scriptName.startsWith('-') || PNPM_DISALLOWED_SUBCOMMAND.has(scriptName)) {
        failedClosed = true;
        return full;
      }
      const canonical = (scriptName === 'i' || scriptName === 'ci') ? 'install' : scriptName;
      scripts.push(canonical);
      if (rootManifestHasHookFor(rootScripts, canonical)) failedClosed = true;
      return '';
    });
    if (/\bpnpm\b/.test(remaining)) failedClosed = true;
  }
  if (failedClosed) mayInvokeLint = true;
  return { scripts, failedClosed, mayInvokeLint };
}

function namedByCommands(steps, rootScripts, { root = null, rootPackageName = null, nodeByPackageName = null, releaseTestScripts = null } = {}) {
  const named = new Set();
  const expanded = new Set();
  const expandedCmds = [];
  const pending = [...steps];
  const visited = new Set();
  let failedClosed = false;
  let mayInvokeLint = false;
  while (pending.length) {
    const current = pending.pop();
    expandedCmds.push(current);
    for (const match of current.cmd.matchAll(ROOT_NAMED)) if (match[1]) named.add(match[1]);
    for (const [, rootFile] of current.cmd.matchAll(ROOT_PATH)) named.add(rootFile);
    const info = analyzeCommandRootScripts(current, { root, rootPackageName, nodeByPackageName, rootScripts, releaseTestScripts });
    if (info.mayInvokeLint) mayInvokeLint = true;
    if (info.failedClosed) {
      failedClosed = true;
      expanded.add(ANY_ROOT_SCRIPT);
      for (const key of Object.keys(rootScripts ?? {})) {
        if (!visited.has(key)) {
          visited.add(key);
          expanded.add(key);
          pending.push({ cmd: String(rootScripts[key]), workingDir: null, shell: null, env: current.env ?? null, ownEnv: null, actionDir: null });
        }
      }
      continue;
    }
    for (const script of info.scripts) {
      expanded.add(script);
      if (!visited.has(script)) {
        visited.add(script);
        if (rootScripts && Object.hasOwn(rootScripts, script)) {
          pending.push({ cmd: String(rootScripts[script]), workingDir: null, shell: null, env: current.env ?? null, ownEnv: null, actionDir: null });
        }
      }
    }
  }
  return { named, expanded, expandedCmds, failedClosed, mayInvokeLint };
}

// Strict fail-closed allowlist for `CATALOG_JOBS` to permit narrowing
// `scripts/lib/e2e-test-data.mjs` per app. Anything outside these exact shapes
// returns false, causing `e2eProvisionersNarrowable = false` (full catalog + heavy tests).
const ALLOWED_CATALOG_ENV_KEY = /^(?:APP|CPU_ONLY|TEST_SCRIPT|QSMBLY_REQUIRE_WASM|ONNXRUNTIME_NODE_INSTALL|PW_TEST_REPORTER|BROWSERS|WITH_DEPS|VERSION|PLATFORM|SHA256|NEURODESK_[A-Z0-9_]+)$/;
const FORBIDDEN_ENV_OR_CMD_REF = /GITHUB_ENV|GITHUB_PATH|\bgithub\s*(?:\.\s*(?:env|path)\b|\[\s*['"](?:env|path)['"]\s*\])|::(?:add-path|set-env)::/i;
const CANONICAL_E2E_PROVISION_CMD = /^node (?:\.\/)?scripts\/e2e-test-data\.mjs (?:"\$([A-Za-z_]\w*)"|\$\{\{\s*matrix\.app\s*\}\})(?: [~./\w${}-]+)*(?: \| tee -a "\$GITHUB_ENV")?$/;
const ALLOWED_CATALOG_NON_PROVISION_CMDS = [
  /^rustup toolchain install [A-Za-z0-9._/@ -]+$/,
  /^pnpm install --frozen-lockfile$/,
  /^pip install [A-Za-z0-9._/@${} -]+$/,
  /^pnpm --filter (?:[A-Za-z0-9._/@-]+|"\$[A-Za-z_]\w*"|\$\{\{\s*matrix\.app\s*\}\}) (?:run (?:"\$[A-Za-z_]\w*"|[A-Za-z0-9:._-]+)|[A-Za-z0-9:._-]+)(?: -- [A-Za-z0-9._/@-]+)?$/,
  /^node scripts\/probe-hardware-gpu\.mjs$/,
  /^node (?:--version|-v)$/,
  /^echo [A-Za-z0-9 ._:/'"-]+$/,
];
const ALLOWED_CATALOG_LOCAL_ACTIONS = new Set([
  '.github/actions/setup-wasm-pack',
  '.github/actions/setup-wasm-opt',
  '.github/actions/setup-playwright',
]);
const ALLOWED_CATALOG_USES = /^(?:actions\/(?:checkout|setup-node|setup-python|cache|upload-artifact)|pnpm\/action-setup|dtolnay\/rust-toolchain)@[\w.-]+$/;
const BINARYEN_PATH_LINE = 'echo "$HOME/.cache/binaryen/bin" >> "$GITHUB_PATH"';

function isAllowedCatalogCompositeStep(step) {
  if (!ALLOWED_CATALOG_LOCAL_ACTIONS.has(step.actionDir)) return false;
  const cmd = step.cmd.trim();
  if (!cmd) return true;
  if (/e2e-test-data/i.test(cmd) || /::(?:add-path|set-env)::/i.test(cmd)) return false;
  if (/GITHUB_ENV|\bgithub\s*(?:\.\s*(?:env|path)\b|\[\s*['"](?:env|path)['"]\s*\])/i.test(cmd)) return false;
  if (/GITHUB_PATH/i.test(cmd)) {
    if (step.actionDir !== '.github/actions/setup-wasm-opt' || /\bnode\b/.test(cmd)) return false;
    const pathLines = cmd.split('\n').map((l) => l.trim()).filter((l) => /GITHUB_PATH/i.test(l));
    if (pathLines.length !== 1 || pathLines[0] !== BINARYEN_PATH_LINE) return false;
  }
  // Only setup-playwright invokes `node`, and strictly on Playwright's own CLI.
  if (/\bnode\b/.test(cmd)) {
    if (step.actionDir !== '.github/actions/setup-playwright') return false;
    const nodeLines = cmd.split('\n').map((l) => l.trim()).filter((l) => /\bnode\b/.test(l));
    if (!nodeLines.every((l) => /^if node node_modules\/@playwright\/test\/cli\.js "\$\{args\[@\]\}"; then$/.test(l))) {
      return false;
    }
  }
  return true;
}

function catalogAllowsE2eNarrowing(catalogSteps, rootScripts, root) {
  if (rootManifestHasAnyLifecycleHook(rootScripts)) return false;
  let sawProvisionStep = false;
  for (const step of catalogSteps) {
    if (step.opaqueAction) return false;
    if (step.uses && !ALLOWED_CATALOG_USES.test(step.uses)) return false;
    if (step.shell && step.shell !== 'bash' && step.shell !== 'sh') return false;
    if (!isRepoRootWorkingDir(step.workingDir, root)) return false;
    for (const [key, val] of Object.entries(step.env ?? {})) {
      if (!ALLOWED_CATALOG_ENV_KEY.test(key)) return false;
      const str = String(val ?? '');
      if (FORBIDDEN_ENV_OR_CMD_REF.test(str) || /e2e-test-data/i.test(str)) return false;
    }
    const cmd = step.cmd.trim();
    if (!cmd) continue;
    if (step.actionDir) {
      if (!isAllowedCatalogCompositeStep(step)) return false;
      continue;
    }
    const provMatch = cmd.match(CANONICAL_E2E_PROVISION_CMD);
    if (provMatch) {
      const varName = provMatch[1];
      if (varName) {
        if (!step.ownEnv || !Object.hasOwn(step.ownEnv, varName) || String(step.ownEnv[varName]).trim() !== '${{ matrix.app }}') {
          return false;
        }
      }
      sawProvisionStep = true;
      continue;
    }
    if (FORBIDDEN_ENV_OR_CMD_REF.test(cmd) || /e2e-test-data/i.test(cmd) || /binaryen/i.test(cmd)) return false;
    if (!ALLOWED_CATALOG_NON_PROVISION_CMDS.some((pattern) => pattern.test(cmd))) return false;
  }
  return sawProvisionStep;
}

// Omit an uninvoked workspace package.json's standalone lint runner segment
// from `scripts.lint` (keeping chained segments such as `&& node --check ...`)
// only when the global fail-closed allowlist confirmed no CI job runs lint and
// no other script in this workspace mentions lint or dynamic script execution.
function manifestScanText(text, manifest, canStripStandaloneLint) {
  if (!canStripStandaloneLint) return text;
  const lintCmd = manifest?.scripts?.lint;
  if (typeof lintCmd !== 'string') return text;
  if (Object.entries(manifest.scripts).some(([name, cmd]) => {
    if (name === 'lint') return false;
    const str = String(cmd);
    return /\blint\b/i.test(str)
      || (/\b(?:pnpm|npm|yarn)\b/.test(str) && /[$`]|\$\{\{/.test(str))
      || /\b(?:eval|exec)\b|\b(?:sh|bash|dash|zsh)\s+-[a-z]*c\b/.test(str);
  })) return text;
  if (/[;|`]|\$\(/.test(lintCmd)) return text;
  const segments = lintCmd.split('&&');
  const kept = segments.filter((segment) => !STANDALONE_LINT_SEGMENT.test(segment));
  if (kept.length === segments.length) return text;
  const scripts = { ...manifest.scripts };
  if (kept.length === 0) delete scripts.lint;
  else scripts.lint = kept.map((s) => s.trim()).join(' && ');
  return JSON.stringify({ ...manifest, scripts }, null, 2);
}

// ---------------------------------------------------------------------------
// Filesystem helpers & conservative workspace graph loader
// ---------------------------------------------------------------------------

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

async function isRegularUnlinkedFile(root, relPath) {
  const full = join(root, relPath);
  try {
    const info = await lstat(full);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    const realRoot = await realpath(root);
    const realFull = await realpath(full);
    const rel = relative(realRoot, realFull).split(sep).join('/');
    return !rel.startsWith('..') && rel === relPath;
  } catch {
    return false;
  }
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

  const loadLocalCompositeSteps = async (usesSpec, parentEnv, visitedActions = new Set()) => {
    if (typeof usesSpec !== 'string' || !usesSpec.startsWith('./')) return [];
    const relDir = usesSpec.slice(2).replace(/\/+$/, '');
    if (!relDir || /[$`*?[{]|\$\{\{/.test(relDir)) {
      return [{ cmd: '', workingDir: null, shell: null, env: parentEnv, ownEnv: null, actionDir: null, opaqueAction: true }];
    }
    const actionDir = resolve(root, relDir);
    const normalizedRel = relative(root, actionDir).split(sep).join('/');
    if (normalizedRel.startsWith('..') || visitedActions.has(normalizedRel)) {
      return [{ cmd: '', workingDir: null, shell: null, env: parentEnv, ownEnv: null, actionDir: null, opaqueAction: true }];
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
      return [{ cmd: '', workingDir: null, shell: null, env: parentEnv, ownEnv: null, actionDir: null, opaqueAction: true }];
    }
    const nextVisited = new Set([...visitedActions, normalizedRel]);
    const expanded = [];
    for (const subStep of actionDoc.runs.steps) {
      const subOwnEnv = subStep?.env && typeof subStep.env === 'object' ? subStep.env : null;
      const subEnv = subOwnEnv ? { ...parentEnv, ...subOwnEnv } : parentEnv;
      // GitHub Actions composite run steps do not inherit workflow/job `defaults.run`.
      const subWorkingDir = subStep?.['working-directory'] ?? null;
      const subShell = subStep?.shell ?? null;
      if (typeof subStep?.uses === 'string' && subStep.uses.startsWith('./')) {
        expanded.push(...await loadLocalCompositeSteps(subStep.uses, subEnv, nextVisited));
      } else {
        expanded.push({
          cmd: String(subStep?.run ?? ''),
          uses: typeof subStep?.uses === 'string' ? subStep.uses : null,
          workingDir: subWorkingDir,
          shell: subShell,
          env: subEnv,
          ownEnv: subOwnEnv,
          actionDir: normalizedRel,
        });
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
      const stepOwnEnv = step?.env && typeof step.env === 'object' ? step.env : null;
      const stepEnv = stepOwnEnv ? { ...jobEnv, ...stepOwnEnv } : jobEnv;
      if (typeof step?.uses === 'string' && step.uses.startsWith('./')) {
        out.push(...await loadLocalCompositeSteps(step.uses, stepEnv));
      } else {
        out.push({
          cmd: String(step?.run ?? ''),
          uses: typeof step?.uses === 'string' ? step.uses : null,
          workingDir: step?.['working-directory'] ?? jobWorkingDir ?? null,
          shell: step?.shell ?? jobShell ?? null,
          env: stepEnv,
          ownEnv: stepOwnEnv,
          actionDir: null,
        });
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

  const siteSteps = await rawRuns(siteJobNames(ci));
  const catalogSteps = await rawRuns(CATALOG_JOBS);
  const cmdOpts = { root, rootPackageName, nodeByPackageName, rootScripts, releaseTestScripts };
  const siteInfo = namedByCommands(siteSteps, rootScripts, cmdOpts);
  const catalogInfo = namedByCommands(catalogSteps, rootScripts, cmdOpts);

  // Strict fail-closed lint omission gate: omit standalone workspace lint
  // runner segments ONLY when neither SITE nor CATALOG failed closed, has any
  // root lifecycle hooks, mentions `lint`, or invokes opaque shell launchers.
  const hasOpaqueShell = (steps) => steps.some((step) => {
    if (step.opaqueAction) return true;
    if (step.actionDir && PINNED_LINT_FREE_ACTIONS.has(step.actionDir)) return false;
    return /\b(?:sh|bash|dash|zsh|eval|exec|source)\b/.test(step.cmd) || /\bnode\s+(?:-[a-z]*[ep]\b|--eval\b|--print\b)/.test(step.cmd);
  });
  const CROSS_WORKSPACE_TARGET = /(?:--filter\b|-F\b|--dir\b|-C\b|--prefix\b|--cwd\b|-r\b|--recursive\b|\brecursive\b|-w\b|--workspace|\bcd\s+|\.\.)/;
  const anyCrossWorkspaceLint = nodes.some((node) =>
    Object.entries(manifests.get(node)?.scripts ?? {}).some(([k, v]) => {
      const str = String(v);
      const effective = k === 'lint'
        ? str.split('&&').filter((seg) => !STANDALONE_LINT_SEGMENT.test(seg)).join(' && ')
        : str;
      if (!CROSS_WORKSPACE_TARGET.test(effective)) return false;
      return /\blint\b/i.test(effective)
        || (/\b(?:pnpm|npm|yarn)\b/.test(effective) && /[$`]|\$\{\{/.test(effective))
        || /\b(?:eval|exec)\b|\b(?:sh|bash|dash|zsh)\s+-[a-z]*c\b/.test(effective);
    }),
  );
  const canStripStandaloneLint =
    !rootManifestHasAnyLifecycleHook(rootScripts)
    && !anyCrossWorkspaceLint
    && !siteInfo.failedClosed
    && !catalogInfo.failedClosed
    && !siteInfo.mayInvokeLint
    && !catalogInfo.mayInvokeLint
    && !hasOpaqueShell(siteInfo.expandedCmds)
    && !hasOpaqueShell(catalogInfo.expandedCmds);

  // Conservatively record any workspace package whose scripts can invoke root
  // scripts (e.g. `pnpm -w`, `pnpm --dir ../..`, `npm --prefix ../..`, root
  // filters, `cd ..` + package manager, or installs when root has hooks).
  const rootHasHooks = rootManifestHasAnyLifecycleHook(rootScripts);
  const workspaceRootScripts = new Map();
  for (const node of nodes) {
    const scripts = manifests.get(node)?.scripts ?? {};
    const names = new Set();
    for (const [scriptKey, rawCmd] of Object.entries(scripts)) {
      const cmd = String(rawCmd);
      if (scriptKey === 'lint' && canStripStandaloneLint && STANDALONE_LINT_SEGMENT.test(cmd)) continue;
      const stripped = cmd.replace(ALLOWED_FILTERED_PNPM, (full, filterChunk, _runKw, _dynScript, litScript) => {
        if (!isNonRootFilterGroup(filterChunk, { rootPackageName, nodeByPackageName })) return full;
        if (litScript && (PNPM_INSTALL_WORD.has(litScript) || PNPM_DISALLOWED_SUBCOMMAND.has(litScript))) return full;
        return '';
      });
      const targetsRoot =
        /\bpnpm\b.*(?:-w\b|--workspace-root\b|--dir\b|-C\b|--filter|-F\b|\b(?:recursive|multi)\b)/.test(stripped)
        || /\bnpm\b.*(?:--prefix\b|-w\b|--workspace\b|--workspaces\b)/.test(stripped)
        || /\byarn\b.*(?:--cwd\b|\bworkspace\b)/.test(stripped)
        || (/\bcd\s+[^\n;&|]*\.\./.test(stripped) && /\b(?:pnpm|npm|yarn)\b/.test(stripped))
        || (rootHasHooks && /\b(?:pnpm|npm|yarn)\s+(?:install|i|ci|add|install-clean|ic|clean-install|install-test|it)\b/.test(stripped));
      if (targetsRoot) names.add(ANY_ROOT_SCRIPT);
    }
    workspaceRootScripts.set(node, names);
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
    if (namedImports === null) entry.allExports = true;
    else for (const name of namedImports) entry.names.add(name);
    if (importerFile) entry.importers.push({ file: importerFile, bindings: localBindings ?? [] });
    rootFileImportModes.set(target, entry);
  };
  const pendingRootFiles = [];
  const derivedJsonFiles = new Set();
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
    const recordWorkspaceTarget = (wsNode) => {
      if (!wsNode || wsNode === node || !nodeSet.has(wsNode)) return;
      if (TRAVERSABLE_WORKSPACE_GROUPS.has(wsNode.split('/')[0])) {
        uses.add(wsNode);
      } else if (wsNode.startsWith('apps/')) {
        uses.add(wsNode);
        if (node.startsWith('apps/')) appReads.set(node, new Set([...(appReads.get(node) ?? []), wsNode]));
      }
    };
    const scanScriptTargets = (cmd, baseDir) => {
      for (const [, , target] of cmd.matchAll(/--filter(?:=|\s+)(['"]?)((?:@[\w.-]+\/)?[\w.-]+)\1/g)) {
        recordWorkspaceTarget(nodeByPackageName.get(target));
      }
      for (const [, , relDir] of cmd.matchAll(/(?:--dir|-C|--prefix|--cwd)(?:=|\s+)(['"]?)([^\s'"`;&|]+)\1/g)) {
        const resolved = relative(root, resolve(root, baseDir, relDir)).split(sep).join('/').replace(/\/+$/, '');
        const owner = resolved.match(/^(?:apps|packages|exes)\/[^/]+/)?.[0];
        if (owner) recordWorkspaceTarget(owner);
      }
    };
    for (const rawCmd of Object.values(manifest?.scripts ?? {})) {
      scanScriptTargets(String(rawCmd), node);
    }
    if ((workspaceRootScripts.get(node)?.size ?? 0) > 0) {
      for (const rawRootCmd of Object.values(rootScripts)) {
        const cmd = String(rawRootCmd);
        scanScriptTargets(cmd, '.');
        for (const [, path, dir, name] of cmd.matchAll(ROOT_NAMED)) {
          const target = path ?? `${dir}/${name}`;
          if (target) {
            uses.add(target);
            pendingRootFiles.push(target);
          }
        }
        for (const [, rootFile] of cmd.matchAll(ROOT_PATH)) {
          uses.add(rootFile);
          pendingRootFiles.push(rootFile);
        }
        for (const [, rootFile] of cmd.matchAll(/(?:^|[\s'"`(=])\.\/((?:scripts|test-utils|registry|test)\/[\w./-]+\.(?:[cm]?[jt]s|json|ya?ml))\b/g)) {
          uses.add(rootFile);
          pendingRootFiles.push(rootFile);
        }
        for (const [, tests] of cmd.matchAll(/(?:^|[\s'"`(=])(?:\.\/|(?:\.\.\/)+)?(packages\/[\w.-]+\/tests?)\//g)) {
          uses.add(tests);
        }
        for (const [, top, name] of cmd.matchAll(SCRIPT_REFERENCE)) {
          if (nodeSet.has(`${top}/${name}`)) uses.add(`${top}/${name}`);
        }
      }
    }
    for await (const file of textFiles(join(root, node))) {
      if ((await stat(file)).size > MAX_TEXT_BYTES) continue;
      const rawText = await readFile(file, 'utf8');
      const isNodeManifest = relative(root, file).split(sep).join('/') === `${node}/package.json`;
      const text = isNodeManifest ? manifestScanText(rawText, manifest, canStripStandaloneLint) : rawText;
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
  for (const config of rootConfigs) siteInfo.named.add(config);
  if (siteInfo.failedClosed || siteInfo.mayInvokeLint) {
    for (const node of nodes) siteInfo.named.add(node);
  }
  if (catalogInfo.failedClosed || catalogInfo.mayInvokeLint) {
    for (const node of nodes) catalogInfo.named.add(node);
  }
  edges.set(SITE, siteInfo.named);
  edges.set(CATALOG, catalogInfo.named);
  const rootScriptsRun = new Map([
    [SITE, siteInfo.expanded],
    [CATALOG, catalogInfo.expanded],
  ]);
  pendingRootFiles.push(...siteInfo.named, ...catalogInfo.named);

  while (pendingRootFiles.length) {
    const file = pendingRootFiles.pop();
    if (edges.has(file)) continue;
    const uses = new Set();
    edges.set(file, uses);
    if (file.endsWith('.json') && /^(?:packages|exes)\//.test(file)) {
      const jsonText = await readFile(join(root, file), 'utf8').catch(() => null);
      if (jsonText !== null) {
        const derived = derivedJsonFiles.has(file);
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
    const narrowedJsonRefs = [];
    const recordWorkspaceRef = (wsTarget, range) => workspaceRefs.push({ target: wsTarget, range });
    for (const match of text.matchAll(SCRIPT_REFERENCE)) {
      const [, top, name, inner] = match;
      if (!nodeSet.has(`${top}/${name}`)) continue;
      const range = [match.index, match.index + match[0].length];
      const literalMatch = inner ? matchScriptLiteral(text, match, literals) : { complete: false, derivedJson: true };
      const target = literalMatch.complete && `${top}/${name}${inner}`;
      if (target && await isRegularUnlinkedFile(root, target)) {
        uses.add(target);
        recordWorkspaceRef(target, range);
        if (target.endsWith('.json')) {
          narrowedJsonRefs.push({ wsDir: `${top}/${name}`, range });
          if (literalMatch.derivedJson) derivedJsonFiles.add(target);
        }
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
      analyzedRootFiles.set(file, { ast: analysis.ast, workspaceRefs, narrowedJsonRefs, builtinMutator: analysis.builtinMutator });
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

  // Co-loaded module closure check for `process.argv` mutation across relative peers.
  const catalogDirect = edges.get(CATALOG) ?? new Set();
  const extraPeerCache = new Map();
  const loadPeerModule = async (peer) => {
    if (analyzedRootFiles.has(peer)) {
      const entry = analyzedRootFiles.get(peer);
      return {
        kind: 'js',
        ast: entry.ast,
        imports: moduleImportEdges.get(peer) ?? new Set(),
        opaque: opaqueImporters.has(peer),
        builtinMutator: entry.builtinMutator,
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
    const info = { kind: 'js', ast: analysis.ast, imports, opaque, builtinMutator: analysis.builtinMutator };
    extraPeerCache.set(peer, info);
    return info;
  };
  const coLoadedModules = async (start) => {
    const seen = new Set([start]);
    const stack = [start];
    let hasOpaque = false;
    let hasBuiltinMutator = false;
    while (stack.length) {
      const current = stack.pop();
      const info = await loadPeerModule(current);
      if (info.kind === 'opaque') {
        hasOpaque = true;
        continue;
      }
      if (info.kind === 'json') continue;
      if (info.opaque) hasOpaque = true;
      if (info.builtinMutator) hasBuiltinMutator = true;
      for (const next of info.imports) {
        if (!seen.has(next)) {
          seen.add(next);
          stack.push(next);
        }
      }
    }
    return { seen, hasOpaque, hasBuiltinMutator };
  };
  const entryReaches = new Map();
  for (const entry of catalogDirect) {
    if (!SOURCE_FILE.test(entry)) continue;
    entryReaches.set(entry, await coLoadedModules(entry));
  }
  const allClosures = [...entryReaches.values()];
  for (const entry of edges.get(SITE) ?? []) {
    if (!SOURCE_FILE.test(entry) || entryReaches.has(entry)) continue;
    allClosures.push(await coLoadedModules(entry));
  }
  // If any co-loaded module can mutate built-in exports (e.g. via
  // `syncBuiltinESMExports()` or default/namespace `fs`/`path`), restore the
  // full workspace directory edge for every narrowed `.json` read in that file.
  for (const [file, info] of analyzedRootFiles) {
    if (info.narrowedJsonRefs.length === 0) continue;
    const ownClosure = entryReaches.get(file) ?? await coLoadedModules(file);
    const unsafe = ownClosure.hasOpaque || ownClosure.hasBuiltinMutator || allClosures.some(
      ({ seen, hasOpaque, hasBuiltinMutator }) => seen.has(file) && (hasOpaque || hasBuiltinMutator),
    );
    if (!unsafe) continue;
    const fileEdges = edges.get(file);
    for (const { wsDir, range } of info.narrowedJsonRefs) {
      fileEdges?.add(wsDir);
      info.workspaceRefs.push({ target: wsDir, range });
    }
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

  const catalogE2eAllowed = catalogAllowsE2eNarrowing(catalogSteps, rootScripts, root);
  const provisionerAppEdges = new Map();
  let e2eProvisionersNarrowable = false;
  const rangeContains = (outer, inner) => outer[0] <= inner[0] && inner[1] <= outer[1];

  for (const [file, { ast, workspaceRefs }] of analyzedRootFiles) {
    if (file === 'scripts/lib/e2e-test-data.mjs') {
      const mode = rootFileImportModes.get(file);
      let callersPreserveIdentity = catalogE2eAllowed && Boolean(mode) && mode.importers.length > 0;
      if (callersPreserveIdentity) {
        for (const { file: importerFile, bindings: impBindings } of mode.importers) {
          const dispatchBindings = impBindings.filter((b) => b.imported === 'provisionTestData');
          if (dispatchBindings.length === 0) continue;
          if (
            importerFile !== 'scripts/e2e-test-data.mjs'
            || !catalogDirect.has(importerFile)
            || await coLoadedMutatesArgv(importerFile)
            || [...entryReaches].some(([entry, { seen }]) => entry !== importerFile && seen.has(importerFile))
          ) {
            callersPreserveIdentity = false;
            break;
          }
          const callerAst = analyzedRootFiles.get(importerFile)?.ast;
          if (!dispatchBindings.every((b) => callerPreservesAppIdentity(callerAst, b.local))) {
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

  let moduleUsers;
  const jobScripts = new Map();
  for (const [id, job] of Object.entries(ci?.jobs ?? {})) {
    jobScripts.set(id, namedByCommands(await expandJobSteps(job), rootScripts, cmdOpts).expanded);
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
