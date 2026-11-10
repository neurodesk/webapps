import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The files a workspace package's command line and Node entry points load,
// outside the package itself: static and literal dynamic imports, followed
// through relative paths and workspace packages' `exports`. Native and CLI
// workflows filter on these so that a change to a dependency runs them.
// It is a lower bound: computed specifiers and non-import reads are not seen.

// Imports, plus files loaded through `new URL('file', import.meta.url)`:
// workers, WebAssembly and data next to the module.
const IMPORT = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|import\s+['"]([^'"]+)['"]|new\s+URL\(\s*['"]((?![a-z][\w+.-]*:|\/)[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g;
// Entry points a command line or its Node API starts from, besides `bin`.
const NODE_ENTRIES = ['./node', '.'];
const SOURCE_ENTRIES = ['src/node.js', 'src/index.js'];

function workspacePackages(root) {
  const packages = new Map();
  for (const top of ['packages', 'exes']) {
    for (const name of readdirSync(join(root, top))) {
      const manifest = join(root, top, name, 'package.json');
      if (existsSync(manifest)) packages.set(JSON.parse(readFileSync(manifest, 'utf8')).name, join(root, top, name));
    }
  }
  return packages;
}

const exportTarget = (value) => (typeof value === 'string' ? value : value?.import ?? value?.node ?? value?.default);

function exportsOf(manifest) {
  if (typeof manifest.exports === 'string') return { '.': manifest.exports };
  return manifest.exports ?? { '.': manifest.main ?? './index.js' };
}

const isFile = (path) => existsSync(path) && statSync(path).isFile();

function resolveSpecifier(packages, specifier, from) {
  if (specifier.startsWith('.')) {
    const base = resolve(dirname(from), specifier);
    const file = [base, `${base}.js`, `${base}.mjs`, `${base}.ts`, join(base, 'index.js')].find(isFile);
    return file ? [file] : [];
  }
  const name = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
  const dir = packages.get(name);
  if (!dir) return [];
  const manifest = join(dir, 'package.json');
  const exports = exportsOf(JSON.parse(readFileSync(manifest, 'utf8')));
  const subpath = `.${specifier.slice(name.length)}`;
  let target = exportTarget(exports[subpath]);
  for (const [key, value] of Object.entries(exports)) {
    if (!target && key.endsWith('*') && subpath.startsWith(key.slice(0, -1))) {
      target = exportTarget(value)?.replace('*', subpath.slice(key.length - 1));
    }
  }
  return target && isFile(join(dir, target)) ? [manifest, join(dir, target)] : [manifest];
}

// Every file the seed files load, seeds included, as repository paths.
export function moduleClosure(root, seeds) {
  const packages = workspacePackages(root);
  const pending = seeds.map((file) => resolve(root, file)).filter(isFile);
  const seen = new Set();
  while (pending.length) {
    const file = pending.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    if (!/\.[cm]?[jt]s$/.test(file)) continue;
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      // A URL string is always relative to the module, with or without ./.
      const specifier = match[4] ? (match[4].startsWith('.') ? match[4] : `./${match[4]}`) : match[1] ?? match[2] ?? match[3];
      for (const next of resolveSpecifier(packages, specifier, file)) {
        if (!seen.has(next)) pending.push(next);
      }
    }
  }
  return [...seen].map((file) => relative(root, file).split('\\').join('/')).sort();
}

const SKIPPED_DIRS = new Set(['node_modules', 'dist', 'target', '.turbo', '.vite', 'coverage', 'test-results', 'playwright-report']);

// Every script in a package: its command line, tests, validation harnesses and
// browser pages' modules. What a workflow runs from a package starts at one.
export function packageSources(root, packageDir) {
  const sources = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name)) walk(join(directory, entry.name));
      } else if (/\.[cm]?[jt]s$/.test(entry.name)) {
        sources.push(relative(root, join(directory, entry.name)).split('\\').join('/'));
      }
    }
  };
  walk(join(root, packageDir));
  return sources.sort();
}

export function commandLineClosure(root, packageDir) {
  const directory = join(root, packageDir);
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const bins = typeof manifest.bin === 'string' ? [manifest.bin] : Object.values(manifest.bin ?? {});
  const exports = exportsOf(manifest);
  const seeds = [...bins, ...NODE_ENTRIES.map((key) => exportTarget(exports[key])), ...SOURCE_ENTRIES]
    .filter(Boolean)
    .map((file) => join(directory, file));
  return moduleClosure(root, seeds).filter((file) => !file.startsWith(`${packageDir}/`));
}
