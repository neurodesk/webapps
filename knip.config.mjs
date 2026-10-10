import { getPackages } from '@manypkg/get-packages';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const { packages } = await getPackages(root);
const source = '**/*.{js,mjs,cjs,jsx,ts,tsx}';
const excluded = ['!**/node_modules/**', '!**/dist/**', '!**/vendor/**', '!**/public/**', '!**/wasm/pkg/**', '!**/validation/results/**', '!**/*.generated.{js,ts}'];
const commandEntries = ['scripts/**/*.{js,mjs,cjs}', '!scripts/lib/**', 'tools/**/*.{js,mjs,cjs}', 'bin/**/*.{js,mjs,cjs}', 'validation/**/*.{js,mjs,cjs}', '!validation/results/**'];
const testEntries = ['test/**/*.{js,mjs,cjs,ts,tsx}', 'tests/**/*.{js,mjs,cjs,ts,tsx}', 'e2e/**/*.{js,mjs,cjs,ts,tsx}', '**/*.{test,spec}.{js,mjs,cjs,ts,tsx}'];

// Static HTML apps do not all have a Vite plugin. Their local script tags are roots.
function htmlEntries(directory) {
  const entries = [];
  for (const name of ['index.html', 'web/index.html']) {
    const html = resolve(directory, name);
    if (!existsSync(html)) continue;
    for (const match of readFileSync(html, 'utf8').matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/gi)) {
      const src = match[1];
      if (/^(?:https?:)?\/\//.test(src)) continue;
      const target = src.startsWith('/') ? resolve(directory, `.${src}`) : resolve(dirname(html), src);
      if (existsSync(target)) entries.push(relative(directory, target));
    }
  }
  return entries;
}

const workspaces = {
  '.': {
    entry: [...commandEntries, ...testEntries, '.github/actions/**/*.{js,mjs,cjs}', 'site/landing.js', 'site/theme.js', 'site/app-shell.js', 'knip.config.mjs'],
    project: ['scripts/**/*.{js,mjs,cjs}', 'test/**/*.{js,mjs,cjs,ts,tsx}', 'test-utils/**/*.{js,mjs,cjs,ts,tsx}', 'site/*.{js,mjs}', 'site/shell-adapters/**/*.js', '.github/actions/**/*.{js,mjs,cjs}', 'knip.config.mjs'],
  },
};
for (const pkg of packages) {
  const directory = relative(root, pkg.dir).replaceAll('\\', '/');
  workspaces[directory] = {
    entry: [...htmlEntries(pkg.dir), ...commandEntries, ...testEntries, '*.config.{js,mjs,cjs,ts,mts}'],
    project: [source, ...excluded],
  };
}

// These modules are requested by filename at runtime, outside the import graph.
workspaces['packages/runtime-support'].entry.push('src/niimath/worker.js', 'src/freebrowse-viewer/static.js');
workspaces['packages/components'].entry.push('web/js/showcase.js', 'templates/*/main.js');
workspaces['packages/desktop'].entry.push('src/main.js', 'neuroflow/runtime/neurodesk.mjs');
workspaces['apps/dicompare'].entry.push('electron/main.ts');
workspaces['site/easter-eggs/vessel-surfer-leaderboard'].entry.push('worker.js');

for (const app of ['seedseg', 'musclemap', 'vesselboost', 'spinalcordtoolbox']) {
  workspaces[`apps/${app}`].entry.push('web/js/inference-worker.js');
}
workspaces['apps/qsmbly'].entry.push('js/qsm-worker-pure.js');
workspaces['apps/qsmbly'].project.push('!niivue/**');
workspaces['packages/vesselboost'].project.push('!preprocessing/**');
workspaces['packages/easy-mp2rage'].project.push('!wasm/**');
workspaces['packages/nesvor'].entry.push('src/**/verify*.mjs', 'src/**/compare*.mjs', 'src/deformation/fixture.mjs');
workspaces['apps/surfannotate'].entry.push('icon/render.mjs');

// Published dist entries are built from matching src modules by esbuild.
function exportPaths(value) {
  if (typeof value === 'string') return [value];
  if (value && typeof value === 'object') return Object.values(value).flatMap(exportPaths);
  return [];
}
for (const pkg of packages) {
  const workspace = workspaces[relative(root, pkg.dir).replaceAll('\\', '/')];
  for (const target of exportPaths(pkg.packageJson.exports)) {
    if (!target.startsWith('./dist/')) continue;
    const source = target.replace('./dist/', 'src/');
    if (existsSync(resolve(pkg.dir, source))) workspace.entry.push(source);
  }
}

// These shared files are copied to the runtime store and fetched without imports.
const runtimeManifest = JSON.parse(readFileSync(resolve(root, 'runtime-assets/manifest.json'), 'utf8'));
for (const family of runtimeManifest.families) {
  for (const file of family.files) {
    if (!file.source_package || !/\.(?:js|mjs)$/.test(file.source)) continue;
    const directory = `packages/${file.source_package}`;
    if (!workspaces[directory]) throw new Error(`Unknown runtime source workspace: ${directory}`);
    workspaces[directory].entry.push(file.source);
  }
}

export default {
  workspaces,
  include: ['files', 'exports', 'types', 'duplicates', 'dependencies', 'devDependencies'],
  ignoreExportsUsedInFile: true,
  ignoreIssues: { '**/*.d.ts': ['files'] },
};
