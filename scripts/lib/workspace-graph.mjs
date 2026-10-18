import { readdir, readFile, stat } from 'node:fs/promises';
import { parse } from 'yaml';
import { dirname, join, relative, resolve, sep } from 'node:path';
import sourceParser from '@neurodesk/code-quality';

// Which apps/, packages/ and exes/ directories each workspace directory uses.
// Declared workspace dependencies are not enough: apps also reach shared code
// through relative paths in build scripts, Vite configs and Rust `#[path]`
// includes, so text references count as edges too. Root files an app reaches
// (`../../scripts/theme-app-dist.mjs`, `../../test-utils/dice.mjs`, and the
// registry files those read) are nodes of their own, followed through their
// imports to the packages they copy or bundle. SITE is a node for what ci.yml's
// composite-site job runs, CATALOG for what its per-app jobs run.
// A false reference only widens the CI selection.

const TOP_LEVEL = ['apps', 'packages', 'exes'];
// Apps are leaves: a package that mentions an app does not use what that app uses.
const TRAVERSABLE_WORKSPACE_GROUPS = new Set(['packages', 'exes']);
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'target', '.turbo', '.vite', 'coverage', 'test-results', 'playwright-report']);
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
// Lint and mutation-testing configs: their own workflows read them, composite-site never does.
export const INDEPENDENT_CONFIG = /^(?:eslint|knip|stryker)\.config\.m?js$/;
export const CATALOG = '(catalog)';
export const SITE = '(site)';
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
  const pendingRootFiles = [];
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
    for await (const file of textFiles(join(root, node))) {
      if ((await stat(file)).size > MAX_TEXT_BYTES) continue;
      const text = await readFile(file, 'utf8');
      for (const [, top, name] of text.matchAll(REFERENCE)) {
        if (nodeSet.has(`${top}/${name}`)) uses.add(`${top}/${name}`);
      }
      for (const [, tests] of text.matchAll(PACKAGE_TESTS)) uses.add(tests);
      for (const [, document] of text.matchAll(DOCUMENT_REFERENCE)) uses.add(document);
      for (const [, rootFile] of text.matchAll(ROOT_PATH)) {
        uses.add(rootFile);
        pendingRootFiles.push(rootFile);
      }
    }
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
  const entries = [
    [SITE, runs(['composite-site'])],
    [CATALOG, runs(CATALOG_JOBS)],
  ];
  // Root tool configs (e2e.config.ts, tsconfig.agentic.json) are read implicitly
  // by the commands composite-site runs, so the site build follows them too.
  const rootConfigs = (await readdir(root)).filter((name) => /^(?:[\w-]+\.config\.[cm]?[jt]s|tsconfig[\w.-]*\.json)$/.test(name) && !INDEPENDENT_CONFIG.test(name));
  const rootScriptsRun = new Map();
  for (const [node, commands] of entries) {
    const { named, expanded } = namedByCommands(commands, rootScripts);
    if (node === SITE) for (const config of rootConfigs) named.add(config);
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
  return Object.freeze({ nodes: Object.freeze(nodes), edges, rootScriptsRun });
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
