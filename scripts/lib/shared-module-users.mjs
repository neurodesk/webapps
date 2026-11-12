import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { moduleClosure } from './module-closure.mjs';
import { SHELL_COMPONENTS } from './standalone.mjs';

// Which modules of a shared package each of its users loads, so that a change
// to one module selects the apps that load it instead of every app that
// depends on the package.
//
// A user is a workspace directory or a root file that the workspace graph ties
// to the package. Its entry points are the places its text names the package:
// an import specifier resolved through `exports`, or a path into the package.
// The modules it loads are the import closure of those entry points. A
// directory stands for every file in it. A reference that resolves to neither
// (a computed specifier, the package root, a path that does not exist) makes
// the user load the whole package, which is what the planner assumed for every
// user before.

export const SHARED_MODULE_PACKAGE = 'packages/components';

// Root scripts that name the package's source directory and read a fixed list
// of modules from it. `expression` is the reference as the script writes it;
// when the script no longer contains it, the script loads the whole package.
// test/shared-module-users.test.mjs holds each list to its script.
export const LISTED_READS = Object.freeze([
  { file: 'scripts/lib/standalone.mjs', expression: "join(repoRoot, 'packages/components/src', name)", modules: SHELL_COMPONENTS },
  { file: 'scripts/dev-server.mjs', expression: '`packages/components/src/${name}`', modules: SHELL_COMPONENTS },
  { file: 'scripts/lib/vite-app-config.mjs', expression: "join(repoRoot, 'packages/components/src')", modules: SHELL_COMPONENTS },
  { file: 'scripts/lib/operation-parameters-runtime.mjs', expression: "join(repoRoot, 'packages', 'components', 'src', module)", modules: ['automation/parameters.js', 'automation/nv-mcp.js'] },
]);

const WHOLE = Symbol('whole package');
const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'dist-sites', 'target', '.turbo', '.vite', 'coverage', 'test-results', 'playwright-report']);
const TEXT_FILE = /\.(?:[cm]?[jt]sx?|json|html|css|vue|svelte|sh|ya?ml|toml|py|rs)$|^Makefile$/;
const MAX_TEXT_BYTES = 1024 * 1024;
const MODULE = /\.[cm]?js$/;
const escape = (text) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const isFile = (path) => existsSync(path) && statSync(path).isFile();
const isDir = (path) => existsSync(path) && statSync(path).isDirectory();
const posix = (path) => path.split(sep).join('/');

function* textFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIPPED_DIRS.has(entry.name)) yield* textFiles(join(dir, entry.name));
    } else if (TEXT_FILE.test(entry.name)) {
      yield join(dir, entry.name);
    }
  }
}

function* allFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) yield* allFiles(join(dir, entry.name));
    else yield join(dir, entry.name);
  }
}

const exportTarget = (value) => (typeof value === 'string' ? value : value?.import ?? value?.default);

// The file an export subpath (`./ui`, `.`) names, or null.
function exportedFile(exports, subpath) {
  let target = exportTarget(exports[subpath]);
  for (const [key, value] of Object.entries(exports)) {
    if (!target && key.endsWith('*') && subpath.startsWith(key.slice(0, -1))) {
      target = exportTarget(value)?.replace('*', subpath.slice(key.length - 1));
    }
  }
  return target ? posix(join('.', target)) : null;
}

// What one text names in the package: repository paths of files, or WHOLE.
// `file` is the text's absolute path.
function referencesIn(text, file, { root, dir, name, exports }) {
  const found = new Set();
  const packageRoot = join(root, dir);
  // A directory below the package root stands for every file in it.
  const add = (absolute) => {
    if (isFile(absolute)) found.add(posix(relative(root, absolute)));
    else if (isDir(absolute) && absolute !== packageRoot) for (const inner of allFiles(absolute)) found.add(posix(relative(root, inner)));
    else found.add(WHOLE);
  };
  // A sentence can end on a path: `see packages/components/src/ui/x.js.`
  const trimmed = (inner) => inner.replace(/\.+$/, '');

  // `@scope/name/sub`. A dependency declaration names no module; a specifier
  // that runs into anything but its closing quote is computed.
  const specifier = new RegExp(`${escape(name)}((?:/[\\w.@-]+)*)(["'\`]\\s*:|.?)`, 'g');
  for (const [, inner, next] of text.matchAll(specifier)) {
    const sub = trimmed(inner);
    if (!sub && next.endsWith(':') && file.endsWith('package.json')) continue;
    if (!/^(?:["'`?\s),;]|["'`]\s*:)?$/.test(next) && sub === inner) {
      found.add(WHOLE);
      continue;
    }
    const exported = exportedFile(exports, `.${sub}`);
    // Not an export: a path below the installed package (node_modules/<name>/src/x.js).
    add(join(packageRoot, exported ?? `.${sub}`));
  }

  // `packages/name/inner`, and `../name/inner` from a sibling directory.
  const path = new RegExp(`((?:\\.\\./)+)?(${escape(dir)}|${escape(dir.split('/').pop())})((?:/[\\w.@-]+)*)(.?)`, 'g');
  for (const [, ups, named, inner, next] of text.matchAll(path)) {
    const rest = trimmed(inner);
    const absolute = named === dir ? join(root, dir, `.${rest}`) : ups ? resolve(dirname(file), `${ups}${named}${rest}`) : null;
    if (!absolute || (absolute !== packageRoot && !absolute.startsWith(`${packageRoot}${sep}`))) continue;
    add(absolute);
  }

  // join(root, 'packages', 'name', ...)
  const [top, leaf] = dir.split('/');
  if (new RegExp(`['"]${escape(top)}['"],\\s*['"]${escape(leaf)}['"]`).test(text)) found.add(WHOLE);
  return found;
}

function referencesOf(user, context, listed) {
  const absolute = join(context.root, user);
  const files = isDir(absolute) ? [...textFiles(absolute)] : isFile(absolute) && TEXT_FILE.test(absolute) ? [absolute] : [];
  const found = new Set();
  for (const file of files) {
    if (statSync(file).size > MAX_TEXT_BYTES) continue;
    let text = readFileSync(file, 'utf8');
    for (const { expression, modules } of listed.filter((entry) => join(context.root, entry.file) === file)) {
      if (!text.includes(expression)) continue;
      text = text.replace(expression, '');
      for (const module of modules) found.add(`${context.dir}/src/${module}`);
    }
    for (const reference of referencesIn(text, file, context)) found.add(reference);
  }
  return found;
}

// Returns `usersOf(path)`: the graph nodes that load the file at `path` in the
// package at `dir`, or null when the analysis does not follow that file (the
// caller then treats it as the whole package). It follows JavaScript modules
// and JSON under `src/`, and a declaration file through the module it types.
export function sharedModuleUsers(root, graph, dir = SHARED_MODULE_PACKAGE, listed = LISTED_READS) {
  if (!isFile(join(root, dir, 'package.json'))) return () => null;
  const manifest = JSON.parse(readFileSync(join(root, dir, 'package.json'), 'utf8'));
  const exports = typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports ?? { '.': manifest.main ?? './index.js' };
  const context = { root, dir, name: manifest.name, exports };
  const within = (node) => node === dir || node.startsWith(`${dir}/`);
  const users = [...graph.edges].filter(([node, uses]) => !within(node) && [...uses].some(within)).map(([node]) => node);
  const loads = new Map();
  for (const user of users) {
    const references = referencesOf(user, context, listed);
    // A file of the package that the graph found in a root script is an entry point too.
    for (const used of graph.edges.get(user)) {
      if (within(used) && used !== dir) references.add(isFile(join(root, used)) ? used : WHOLE);
    }
    // A module that was deleted is still loaded by the module that imports it.
    loads.set(user, references.has(WHOLE) ? WHOLE : new Set(moduleClosure(root, [...references], { missing: true }).filter(within)));
  }
  const typed = new Map();
  for (const value of Object.values(exports)) {
    if (value?.types && exportTarget(value)) typed.set(posix(join(dir, value.types)), posix(join(dir, exportTarget(value))));
  }
  const followed = (path) => {
    if (!path.startsWith(`${dir}/src/`)) return null;
    if (MODULE.test(path) || path.endsWith('.json')) return path;
    if (!path.endsWith('.d.ts')) return null;
    return typed.get(path) ?? path.replace(/\.d\.ts$/, '.js');
  };
  return (path) => {
    const module = followed(path);
    return module && users.filter((user) => loads.get(user) === WHOLE || loads.get(user).has(module));
  };
}
