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
const ROOT_NAMED = new RegExp(String.raw`(?:^|[\s'"\`(=])((?:scripts|test-utils|registry|test)\/${ROOT_FILE})\b|['"](registry|test-utils)['"],\s*['"](${ROOT_FILE})['"]`, 'gm');
const ROOT_GLOB = /['"`]((?:scripts|test-utils|test)\/[\w/-]+)\/[^'"`]*\*[^'"`]*['"`]/g;
const ROOT_DIRS = ['scripts/', 'test-utils/', 'registry/', 'test/', 'packages/', 'exes/'];
const ROOT_CONFIG = /^[\w.-]+\.(?:[cm]?[jt]s|json)$/;
const SOURCE_FILE = /\.[cm]?[jt]s$/;
// A whole line that is a `//` comment. Triple-slash lines stay: TypeScript's
// `/// <reference path>` directives are compiler inputs.
const LINE_COMMENT = /^[ \t]*\/\/(?!\/).*$/gm;
const ROOT_SCRIPT_CALL = /\bpnpm (?:-w |--workspace-root )?(?:run )?([\w:-]+)/g;
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
const STATEMENT_BOUNDARY = new Set(['ExpressionStatement', 'VariableDeclaration', 'ReturnStatement', 'BlockStatement', 'Program']);
const FILE_READER_CALLS = new Set(['readFile', 'readFileSync', 'require']);
const PATH_JOIN_CALLS = new Set(['join', 'resolve']);
const INDEPENDENT_LINT_SCRIPT = /^node\s+(?:\.\.\/)+scripts\/lint\.mjs(?:\s+--workspace)?$/;
const FILTER_ARG = /(?:--filter|-F)(?:=|\s+)['"]?([^\s'"]+)['"]?/g;
const CROSS_WORKSPACE_FLAG = /(?:--filter|-F|-r|--recursive|--workspace|-w|--workspaces)(?:=|\s|$)/;

function calleeNameOf(callNode) {
  const callee = callNode?.callee;
  if (callee?.type === 'Identifier') return callee.name;
  if (callee?.type === 'MemberExpression' && !callee.computed && callee.property?.type === 'Identifier') return callee.property.name;
  return null;
}

// Whether a string literal sits in a whitelisted standalone path context:
// (1) static/dynamic import/export source, (2) direct CallExpression argument,
// (3) element of an ArrayExpression passed directly to a CallExpression, or
// (4) direct VariableDeclarator initializer whose binding is never referenced
// elsewhere in the script. A CallExpression stored in a referenced variable is
// accepted only if a file-reading call (`readFile`/`readFileSync`/`require`)
// already consumed the path before the assignment (preventing `const base =
// resolve('ref.json'); readFileSync(base + '.gz')` from narrowing to `ref.json`).
function isStandalonePathLiteral(node, ancestors, referencedIdentifiers) {
  if (node.type !== 'Literal' || typeof node.value !== 'string') return false;
  const parent = ancestors[ancestors.length - 1];
  if (!parent) return false;
  if (DIRECT_MODULE_PARENTS.has(parent.type) && parent.source === node) return true;
  if (parent.type === 'VariableDeclarator' && parent.init === node && parent.id?.type === 'Identifier') {
    const grandParent = ancestors[ancestors.length - 2];
    return grandParent?.type === 'VariableDeclaration' && !referencedIdentifiers.has(parent.id.name);
  }
  let callIndex = -1;
  if (parent.type === 'CallExpression' && Array.isArray(parent.arguments) && parent.arguments.includes(node)) {
    const name = calleeNameOf(parent);
    if (PATH_JOIN_CALLS.has(name) && parent.arguments[parent.arguments.length - 1] !== node) return false;
    callIndex = ancestors.length - 1;
  } else if (parent.type === 'ArrayExpression') {
    const grandParent = ancestors[ancestors.length - 2];
    if (grandParent?.type === 'CallExpression' && Array.isArray(grandParent.arguments) && grandParent.arguments.includes(parent)) {
      callIndex = ancestors.length - 2;
    }
  }
  if (callIndex < 0) return false;
  let consumedByReader = FILE_READER_CALLS.has(calleeNameOf(ancestors[callIndex]));
  for (let i = callIndex - 1; i >= 0; i--) {
    const ancestor = ancestors[i];
    const child = ancestors[i + 1];
    if (STATEMENT_BOUNDARY.has(ancestor.type)) return true;
    if (ancestor.type === 'AwaitExpression' && ancestor.argument === child) continue;
    if (ancestor.type === 'VariableDeclarator' && ancestor.init === child) {
      if (consumedByReader) continue;
      if (ancestor.id?.type === 'Identifier' && !referencedIdentifiers.has(ancestor.id.name)) continue;
      return false;
    }
    if (ancestor.type === 'CallExpression' && Array.isArray(ancestor.arguments) && ancestor.arguments.includes(child)) {
      if (FILE_READER_CALLS.has(calleeNameOf(ancestor))) consumedByReader = true;
      continue;
    }
    return false;
  }
  return true;
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
      if (!isDeclId) referencedIdentifiers.add(node.name);
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
  return candidates.map(({ node, ancestors: chain }) => {
    const isStringLiteral = node.type === 'Literal' && typeof node.value === 'string';
    const isTemplate = node.type === 'TemplateLiteral';
    const commentLine =
      (isStringLiteral || (isTemplate && node.expressions.length === 0)) &&
      chain[chain.length - 1]?.type === 'VariableDeclarator' &&
      /(?:^|\n)[ \t]*\/\//.test(text.slice(node.range[0] + 1, node.range[1] - 1));
    const standalone = isStandalonePathLiteral(node, chain, referencedIdentifiers) || commentLine;
    return { start: node.range[0], end: node.range[1], standalone };
  });
}

// Whether a SCRIPT_REFERENCE file match ends at a real path boundary and, when
// inside a JS string/template literal, spans a complete whitelisted literal.
function isCompleteScriptFile(text, match, literals) {
  const start = match.index;
  const end = match.index + match[0].length;
  const after = text[end];
  if (after && !/[\s'"`),;:\]}]/.test(after)) return false;
  if (literals !== null) {
    const litAtEnd = literals.find((lit) => lit.start < end && end <= lit.end);
    if (litAtEnd) {
      if (!litAtEnd.standalone) return false;
      const tail = text.slice(end, litAtEnd.end - 1);
      if (tail.length > 0 && !(tail === '\n' && text.slice(litAtEnd.start + 1, start).includes('//'))) return false;
      const litAtStart = literals.find((lit) => lit.start <= start && start < lit.end);
      if (litAtStart && litAtStart !== litAtEnd && !litAtStart.standalone) return false;
      return true;
    }
    return true;
  }
  const sepStart = start + match[1].length;
  if (text[sepStart] !== '/') {
    const secondQuote = match[0].slice(match[1].length + 1).match(/['"`]/)?.[0];
    return Boolean(secondQuote && after === secondQuote);
  }
  let i = start - 1;
  while (i >= 0 && /[\w./-]/.test(text[i])) i--;
  if (i >= 0 && (text[i] === "'" || text[i] === '"' || text[i] === '`') && (i === 0 || text[i - 1] !== '\\')) {
    return after === text[i];
  }
  return true;
}

// Workspace nodes whose `lint` script may be executed by any cross-workspace
// lint invocation (`pnpm --filter <pkg> lint`, `--filter=<pkg>`, `-r lint`).
function lintTargetsInCommands(commands, { nodeByPackageName, nodeSet, manifests }) {
  const targets = new Set();
  const allLintNodes = () => [...manifests.entries()].filter(([, manifest]) => typeof manifest?.scripts?.lint === 'string').map(([node]) => node);
  for (const cmd of commands) {
    if (INDEPENDENT_LINT_SCRIPT.test(cmd.trim())) continue;
    if (!/\b(?:pnpm|npm|yarn)\b/.test(cmd) || !/\blint\b/.test(cmd) || !CROSS_WORKSPACE_FLAG.test(cmd)) continue;
    // `pnpm -w run lint` / `pnpm --workspace-root run lint` runs the root lint
    // script (handled by ROOT_SCRIPT_CALL), not every workspace member.
    if (/(?:^|\s)(?:-w|--workspace-root)(?:\s|$)/.test(cmd) && !/(?:--filter|-F|-r|--recursive|--workspace(?:=|\s)|--workspaces)/.test(cmd)) continue;
    const recursive = /(?:^|\s)(?:-r|--recursive)(?:\s|$)/.test(cmd);
    const filters = [...cmd.matchAll(FILTER_ARG)].map(([, target]) => target);
    if (!recursive && filters.length > 0) {
      let allResolved = true;
      for (const filter of filters) {
        const workspaceNode = nodeByPackageName.get(filter) ?? (nodeSet.has(filter) ? filter : null);
        if (workspaceNode) targets.add(workspaceNode);
        else allResolved = false;
      }
      if (!allResolved) for (const node of allLintNodes()) targets.add(node);
    } else {
      for (const node of allLintNodes()) targets.add(node);
    }
  }
  return targets;
}

// Expand CI commands through root package.json scripts without stripping
// `pnpm --filter`, so workspace script invocations (such as `--filter @nd/n4 lint`)
// remain visible before deciding whether standalone lint scripts can be omitted.
function expandedCommandTexts(commands, rootScripts) {
  const texts = [];
  const pending = [...commands];
  const expanded = new Set();
  while (pending.length) {
    const command = pending.pop();
    texts.push(command);
    for (const [, script] of command.matchAll(ROOT_SCRIPT_CALL)) {
      if (!expanded.has(script)) {
        expanded.add(script);
        if (rootScripts[script]) pending.push(rootScripts[script]);
      }
    }
  }
  return texts;
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
  const rawRuns = (names) => names.flatMap((name) => {
    const steps = ci?.jobs?.[name]?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new WorkspaceGraphConfigurationError(`ci.yml job ${name} has no step list; update the workspace graph's CI entry points`);
    }
    return steps.map((step) => step.run ?? '');
  });
  const rawEntries = [
    [SITE, rawRuns(siteJobNames(ci))],
    [CATALOG, rawRuns(CATALOG_JOBS)],
  ];
  const expandedByEntry = new Map(rawEntries.map(([node, raw]) => [node, expandedCommandTexts(raw, rootScripts)]));
  const ciInvokesLint = [...expandedByEntry.values()].flat().some((cmd) => /\blint\b/.test(cmd));
  const workspaceCrossInvokesLint = [...manifests.values()].some((manifest) =>
    Object.values(manifest?.scripts ?? {}).some((cmd) => {
      const value = String(cmd);
      return !INDEPENDENT_LINT_SCRIPT.test(value.trim()) && /\b(?:pnpm|npm|yarn)\b/.test(value) && /\blint\b/.test(value) && CROSS_WORKSPACE_FLAG.test(value);
    }),
  );
  const stripStandaloneLint = !ciInvokesLint && !workspaceCrossInvokesLint;

  const edges = new Map();
  const pendingRootFiles = [];
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
    const allScripts = Object.values(manifest?.scripts ?? {}).map(String);
    for (const lintTarget of lintTargetsInCommands(allScripts, { nodeByPackageName, nodeSet, manifests })) {
      uses.add(lintTarget);
    }
    const manifestPath = join(root, node, 'package.json');
    for await (const file of textFiles(join(root, node))) {
      if ((await stat(file)).size > MAX_TEXT_BYTES) continue;
      const rawText = await readFile(file, 'utf8');
      const text = file === manifestPath ? manifestScanText(rawText, manifest, stripStandaloneLint) : rawText;
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

  const entries = rawEntries.map(([node, raw]) => [node, raw.map((run) => run.replace(/pnpm --filter \S+ (?:run )?\S+/g, ''))]);
  // Root tool configs (e2e.config.ts, tsconfig.agentic.json) are read implicitly
  // by the site jobs' commands, so the site build follows them too.
  const rootConfigs = (await readdir(root)).filter((name) => /^(?:[\w-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json)$/.test(name) && !INDEPENDENT_CONFIG.test(name));
  const rootScriptsRun = new Map();
  for (const [node, commands] of entries) {
    const { named, expanded } = namedByCommands(commands, rootScripts);
    if (node === SITE) for (const config of rootConfigs) named.add(config);
    for (const lintTarget of lintTargetsInCommands(expandedByEntry.get(node) ?? [], { nodeByPackageName, nodeSet, manifests })) {
      named.add(lintTarget);
    }
    edges.set(node, named);
    rootScriptsRun.set(node, expanded);
    pendingRootFiles.push(...named);
  }

  while (pendingRootFiles.length) {
    const file = pendingRootFiles.pop();
    if (edges.has(file)) continue;
    const uses = new Set();
    edges.set(file, uses);
    if (!SOURCE_FILE.test(file)) continue;
    const source = await readFile(join(root, file), 'utf8').catch(() => null);
    if (source === null) continue;
    const text = withoutLineComments(source, file);
    const literals = collectScriptStringLiterals(text, file);
    for (const match of text.matchAll(SCRIPT_REFERENCE)) {
      const [, top, name, inner] = match;
      if (!nodeSet.has(`${top}/${name}`)) continue;
      const target = inner && isCompleteScriptFile(text, match, literals) && `${top}/${name}${inner}`;
      if (target && await isRegularUnlinkedFile(root, target)) {
        uses.add(target);
        pendingRootFiles.push(target);
      } else {
        uses.add(`${top}/${name}`);
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
