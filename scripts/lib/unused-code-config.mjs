import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, matchesGlob, relative, resolve } from 'node:path';
import { JSDOM } from 'jsdom';

const isFile = (path) => existsSync(path) && statSync(path).isFile();

export function htmlEntries(directory, generated = []) {
  const entries = [];
  for (const name of ['index.html', 'web/index.html']) {
    const html = resolve(directory, name);
    if (!existsSync(html)) continue;
    const dom = new JSDOM(readFileSync(html, 'utf8'));
    for (const element of dom.window.document.querySelectorAll('script[src]')) {
      const src = element.getAttribute('src');
      if (/^(?:https?:)?\/\//.test(src)) continue;
      const path = src.split(/[?#]/)[0];
      if (generated.includes(path.replace(/^(?:\.\/|\/)/, ''))) continue;
      const candidates = path.startsWith('/')
        ? [resolve(dirname(html), `.${path}`), resolve(directory, `.${path}`)]
        : [resolve(dirname(html), path)];
      const target = candidates.find(isFile);
      if (target) entries.push(relative(directory, target).replaceAll('\\', '/'));
      else throw new Error(`Missing local HTML script in ${html}: ${src}`);
    }
    dom.window.close();
  }
  return entries;
}

function exportPaths(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportPaths);
  return [];
}

export function publishedSourceEntries(directory, exports) {
  const entries = [];
  for (const target of exportPaths(exports)) {
    if (!target.startsWith('./dist/') || !/\.(?:[cm]?js|jsx)$/.test(target)) continue;
    const source = target.replace('./dist/', 'src/');
    const base = source.replace(/\.(?:[cm]?js|jsx)$/, '');
    const candidates = [source, ...['ts', 'mts', 'tsx', 'mjs', 'cts', 'cjs', 'js', 'jsx'].map((extension) => `${base}.${extension}`)];
    const entry = candidates.find((candidate) => isFile(resolve(directory, candidate)));
    if (!entry) throw new Error(`Missing source mapping for published export ${directory}: ${target}`);
    entries.push(entry);
  }
  return [...new Set(entries)];
}

export function validateLiteralEntries(root, workspaces) {
  for (const [workspace, config] of Object.entries(workspaces)) {
    for (const entry of config.entry) {
      if (entry.startsWith('!') || /[*?[\]{}]/.test(entry)) continue;
      if (!isFile(resolve(root, workspace, entry))) throw new Error(`Missing explicit entry: ${workspace}/${entry}`);
    }
  }
}

// Only these generated/vendor exclusions are part of the coverage contract.
export const projectExclusions = ['!**/node_modules/**', '!**/dist/**', '!**/vendor/**', '!**/public/**', '!**/wasm/pkg/**', '!**/validation/results/**', '!**/*.generated.{js,ts}'];
const workspaceExclusions = {
  'apps/qsmbly': ['!niivue/**'],
  'packages/vesselboost': ['!preprocessing/**'],
  'packages/easy-mp2rage': ['!wasm/**'],
};

export function validateProjectExclusions(workspaces) {
  for (const [workspace, config] of Object.entries(workspaces)) {
    const allowed = [...projectExclusions, ...(workspaceExclusions[workspace] ?? [])];
    for (const pattern of config.project) {
      if (pattern.startsWith('!') && !allowed.includes(pattern)) throw new Error(`Undocumented source exclusion: ${workspace}/${pattern}`);
    }
  }
}

// Templates contain scaffold placeholders; docs examples are historical source snapshots.
export const excludedRootSources = ['templates/app-template/**', 'docs/architecture/examples/**'];

export function sourceCoverage(file, workspaces) {
  for (const [workspace, config] of Object.entries(workspaces).sort(([a], [b]) => b.length - a.length)) {
    if (workspace !== '.' && !file.startsWith(`${workspace}/`)) continue;
    const local = workspace === '.' ? file : file.slice(workspace.length + 1);
    const included = config.project.some((pattern) => !pattern.startsWith('!') && matchesGlob(local, pattern));
    if (!included) continue;
    const excluded = config.project.some((pattern) => pattern.startsWith('!') && matchesGlob(local, pattern.slice(1)));
    return excluded ? 'excluded workspace generated/vendor source' : 'covered';
  }
  if (excludedRootSources.some((pattern) => matchesGlob(file, pattern))) return 'excluded template/archive source';
  return undefined;
}
