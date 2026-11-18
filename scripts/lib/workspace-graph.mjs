import { readdir, readFile, stat } from 'node:fs/promises';
import { parse } from 'yaml';
import { sharedModuleUsers } from './shared-module-users.mjs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import sourceParser from '@neurodesk/code-quality';

// Which apps/, packages/ and exes/ directories each workspace directory uses.
// Declared workspace dependencies are not enough: apps also reach shared code
// through relative paths in build scripts, Vite configs and Rust `#[path]`
// includes, so text references count as edges too. Root files an app reaches
// (`../../scripts/theme-app-dist.mjs`, `../../test-utils/dice.mjs`, and the
// registry files those read) are nodes of their own, followed through their
// imports to the packages they copy or bundle. SITE is a node for what ci.yml's
// composite-site and dependent agent-interactions jobs run, CATALOG for what its per-app jobs run,
// EASTER_EGG for what its homepage-easter-egg job runs (its commands and the
// site/easter-eggs packages they test). `outside` lists, per directory or
// root file, the app, model and site files it names (`apps/x`, or `apps` for
// a path computed at run time) and every repository path a relative literal
// in it resolves to from the file that names it (`'../../components/test/x'`):
// package tests read their app's fixtures and each other's. A literal that
// resolves to nothing at head (computed, or deleted by the change) keeps its
// nearest existing directory, the repository root (`.`) at worst; `unresolved`
// lists them. A closed literal of `..` steps that names the repository root
// (`new URL('../../../', import.meta.url)`) is a computed repository root,
// not a read: what is joined onto it is followed through the root-relative
// names above, as for root files. A false reference only widens the CI
// selection.

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
const SCRIPT_REFERENCE = /\b(packages|exes)(?:\/|['"],\s*['"])([\w.-]+)((?:\/[\w.-]+)*\/[\w.-]+\.(?:[cm]?[jt]s|json|md))?/g;
// Documentation counts only where code reads that exact file.
const DOCUMENT_REFERENCE = /\b((?:packages|exes)\/[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+\.md)\b/g;
// A package's own tests change no app unless an app reads from them.
const PACKAGE_TESTS = /(?:\.\.\/)+(packages\/[\w.-]+\/tests?)\//g;
const PACKAGE_TEST_DIR = /^packages\/[^/]+\/tests?(?=\/)/;
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
const ROOT_SCRIPT_CALL = /\bpnpm (?:run )?([\w:-]+)/g;
// Repository directories outside the graph's nodes, named relative to a file,
// from the repository root, or as a joined segment (`join(root, 'apps', id)`,
// `root.join("models")`, `ROOT / 'apps'`): the first segment below them, or
// none when it is computed. A lone quoted name (`doc.get('apps')`,
// `"apps": {}`) is a key, not a path.
const OUTSIDE_DIRS = String.raw`(apps|models|site|runtime-assets|templates)`;
const OUTSIDE_NAME = new RegExp(OUTSIDE_DIRS);
const OUTSIDE_RELATIVE = new RegExp(String.raw`(?:\.\.\/)+${OUTSIDE_DIRS}(?:\/([\w.-]+)|(?![\w.-]))`, 'g');
const OUTSIDE_ROOTED = new RegExp(String.raw`['"\`]${OUTSIDE_DIRS}\/([\w.-]+)?`, 'g');
const OUTSIDE_JOINED = new RegExp(String.raw`((?:[,/]|\.join\()\s*)?['"\`]${OUTSIDE_DIRS}['"\`](\s*[,/]\s*(?:['"\`]([\w.-]+)['"\`])?)?`, 'g');
// A quoted relative path, up to its closing quote or a template expression: `'../x/y'`, `'./'`, `'..'`.
const RELATIVE_LITERAL = /['"`](\.\.?(?:\/[^'"`\s$]*)?)(?=(['"`]|\$\{))/g;
const PARENT_STEPS = /^\.\.(?:\/\.\.)*\/?$/;
// Lint and mutation-testing configs: their own workflows read them, composite-site never does.
export const INDEPENDENT_CONFIG = /^(?:eslint|knip|stryker)\.config\.m?js$/;
export const CATALOG = '(catalog)';
export const SITE = '(site)';
export const EASTER_EGG = '(homepage-easter-egg)';
const EASTER_EGG_JOB = 'homepage-easter-egg';
const EASTER_EGG_DIR = 'site/easter-eggs';
// The ci.yml jobs that run once per selected app.
export const CATALOG_JOBS = ['app-tests', 'browser-e2e', 'browser-e2e-gpu'];

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

// A JavaScript or TypeScript line that is a comment (`//`, `/*` or a JSDoc
// ` * ` line) names a path in prose; triple-slash directives stay inputs.
const COMMENT_LINE = /^[ \t]*(?:\/\/(?!\/)|\/\*|\*)/;

function outsideReferences(text, file) {
  if (!OUTSIDE_NAME.test(text)) return [];
  const named = (top, below) => (below ? `${top}/${below}` : top);
  const code = (match) => !SOURCE_FILE.test(file) || !COMMENT_LINE.test(text.slice(text.lastIndexOf('\n', match.index) + 1, match.index + 1));
  return [
    ...[...text.matchAll(OUTSIDE_RELATIVE), ...text.matchAll(OUTSIDE_ROOTED)].filter(code).map(([, top, below]) => named(top, below)),
    ...[...text.matchAll(OUTSIDE_JOINED)].filter((match) => (match[1] || match[3]) && code(match)).map(([, , top, , below]) => named(top, below)),
  ];
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

  const edges = new Map();
  const outside = new Map();
  const pendingRootFiles = [];
  // Packages, exes and root files a directory's text names, and what else it
  // reads: `reads(file)` is the set its outside references go to. `scripts`
  // keeps the package.json scripts a caller runs; a manifest it cannot parse is read whole.
  // The repository paths the relative literals of `file` resolve to, each
  // the nearest path that exists at head.
  const present = new Map();
  const unresolved = [];
  const relativeReferences = async (text, file) => {
    const found = new Set();
    for (const [, literal, end] of text.matchAll(RELATIVE_LITERAL)) {
      let path = relative(root, resolve(dirname(file), literal)).split(sep).join('/') || '.';
      if (path === '..' || path.startsWith('../') || isAbsolute(path)) continue;
      if (path === '.' && end !== '${' && PARENT_STEPS.test(literal)) continue;
      const named = path;
      while (path !== '.' && !(present.has(path) ? present.get(path) : present.set(path, await exists(join(root, path))).get(path))) path = dirname(path);
      if (path !== named) unresolved.push({ file: relative(root, file).split(sep).join('/'), literal, path });
      found.add(path);
    }
    return found;
  };
  // `ownDir(file)`: the directory whose own changes already reach the file's owner.
  const scan = async (dir, uses, reads, scripts = null, ownDir = () => relative(root, dir).split(sep).join('/')) => {
    for await (const file of textFiles(dir)) {
      if ((await stat(file)).size > MAX_TEXT_BYTES) continue;
      let text = await readFile(file, 'utf8');
      if (scripts && basename(file) === 'package.json') {
        try {
          const manifest = JSON.parse(text);
          text = JSON.stringify({ ...manifest, scripts: scripts(manifest) });
        } catch {
          // The whole text stays an input.
        }
      }
      for (const [, top, name] of text.matchAll(REFERENCE)) {
        if (nodeSet.has(`${top}/${name}`)) uses.add(`${top}/${name}`);
      }
      for (const [, tests] of text.matchAll(PACKAGE_TESTS)) uses.add(tests);
      for (const [, document] of text.matchAll(DOCUMENT_REFERENCE)) uses.add(document);
      for (const [, rootFile] of text.matchAll(ROOT_PATH)) {
        uses.add(rootFile);
        pendingRootFiles.push(rootFile);
      }
      for (const reference of outsideReferences(text, file)) reads(file).add(reference);
      for (const reference of await relativeReferences(text, file)) {
        const own = ownDir(file);
        if (reference !== own && !reference.startsWith(`${own}/`)) reads(file).add(reference);
      }
    }
  };
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
    // A package's tests are read only by its own suite and by those that read them.
    const reads = (file) => {
      const owner = relative(root, file).split(sep).join('/').match(PACKAGE_TEST_DIR)?.[0] ?? node;
      if (!outside.has(owner)) outside.set(owner, new Set());
      return outside.get(owner);
    };
    reads(join(root, node));
    await scan(join(root, node), uses, reads, null, (file) => relative(root, file).split(sep).join('/').match(PACKAGE_TEST_DIR)?.[0] ?? node);
    uses.delete(node);
    edges.set(node, uses);
  }

  const ci = parse(await readFile(join(root, '.github/workflows/ci.yml'), 'utf8'));
  const rootScripts = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).scripts;
  const runs = (names) => names.flatMap((name) => {
    const steps = ci?.jobs?.[name]?.steps;
    if (!Array.isArray(steps) || steps.length === 0) {
      throw new WorkspaceGraphConfigurationError(`ci.yml job ${name} has no step list; update the workspace graph's CI entry points`);
    }
    return steps.map((step) => step.run ?? '');
  }).map((run) => run.replace(/pnpm --filter \S+ (?:run )?\S+/g, ''));
  // Older workflow revisions ran interactions inside composite-site. Both layouts
  // consume the site, so moving the command must preserve its site-only selection.
  const siteJobs = ['composite-site'];
  if (Object.hasOwn(ci?.jobs ?? {}, 'agent-interactions')) siteJobs.push('agent-interactions');
  const entries = [
    [SITE, runs(siteJobs)],
    [CATALOG, runs(CATALOG_JOBS)],
  ];
  // Without the job the planner runs the easter egg's tests whenever it is asked.
  if (Object.hasOwn(ci?.jobs ?? {}, EASTER_EGG_JOB)) entries.push([EASTER_EGG, runs([EASTER_EGG_JOB])]);
  // Root tool configs (e2e.config.ts, tsconfig.agentic.json) are read implicitly
  // by the site jobs' commands, so the site build follows them too.
  const rootConfigs = (await readdir(root)).filter((name) => /^(?:[\w-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json)$/.test(name) && !INDEPENDENT_CONFIG.test(name));
  const rootScriptsRun = new Map();
  for (const [node, commands] of entries) {
    const { named, expanded } = namedByCommands(commands, rootScripts);
    if (node === SITE) for (const config of rootConfigs) named.add(config);
    // The job's filtered package scripts test the easter-egg packages, so it reads what they name.
    if (node === EASTER_EGG) {
      const reads = new Set();
      // It runs neither package's lint script: lint runs in workspace-contracts and code-quality.
      const withoutLint = ({ scripts: { lint, ...scripts } = {} }) => scripts;
      if (await exists(join(root, EASTER_EGG_DIR))) await scan(join(root, EASTER_EGG_DIR), named, () => reads, withoutLint, () => 'site');
      outside.set(node, reads);
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
    outside.set(file, new Set([...outsideReferences(text, file), ...[...await relativeReferences(text, join(root, file))].filter((path) => path !== file)]));
    for (const [, top, name, inner] of text.matchAll(SCRIPT_REFERENCE)) {
      if (!nodeSet.has(`${top}/${name}`)) continue;
      const target = inner && `${top}/${name}${inner}`;
      if (target && await exists(join(root, target))) {
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
  let moduleUsers;
  const graph = { nodes: Object.freeze(nodes), edges, outside, unresolved: Object.freeze(unresolved), rootScriptsRun, moduleUsers: (path) => (moduleUsers ??= sharedModuleUsers(root, graph))(path) };
  return Object.freeze(graph);
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
