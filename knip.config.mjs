import { getPackages } from '@manypkg/get-packages';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { htmlEntries, projectExclusions, publishedSourceEntries, validateLiteralEntries, validateProjectExclusions } from './scripts/lib/unused-code-config.mjs';

const root = dirname(fileURLToPath(import.meta.url));
const { packages } = await getPackages(root);
const source = '**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}';
const commandEntries = ['scripts/**/*.{js,mjs,cjs,mts,cts}', '!scripts/lib/**', 'tools/**/*.{js,mjs,cjs,mts,cts}', 'bin/**/*.{js,mjs,cjs,mts,cts}', 'validation/**/*.{js,mjs,cjs,mts,cts}', '!validation/results/**'];
const testEntries = ['test/**/*.{js,mjs,cjs,ts,tsx,mts,cts}', 'tests/**/*.{js,mjs,cjs,ts,tsx,mts,cts}', 'e2e/**/*.{js,mjs,cjs,ts,tsx,mts,cts}', '**/*.{test,spec}.{js,mjs,cjs,ts,tsx,mts,cts}'];

// Build staging supplies these exact local HTML scripts before dev/build.
const generatedHtmlScripts = {
  'apps/calmar': ['wasm/ort.min.js', 'nifti-js/index.js', 'coi-serviceworker.js'],
  'apps/musclemap': ['coi-serviceworker.js', 'nifti-js/index.js'],
  'apps/qsmbly': ['coi-serviceworker.js'],
  'apps/seedseg': ['coi-serviceworker.js'],
  'apps/spinalcordtoolbox': ['coi-serviceworker.js', 'nifti-js/index.js'],
  'apps/vesselboost': ['coi-serviceworker.js', 'runtime/niivue.umd.js'],
};

const workspaces = {
  '.': {
    entry: [...commandEntries, ...testEntries, '.github/actions/**/*.{js,mjs,cjs,mts,cts}', 'site/landing.js', 'site/theme.js', 'site/app-shell.js', '*.config.{js,mjs,cjs,ts,mts,cts}', 'exes/nii2tvx/wasm_demo.mjs'],
    project: ['config/**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}', 'scripts/**/*.{js,mjs,cjs,mts,cts}', 'test/**/*.{js,mjs,cjs,ts,tsx,mts,cts}', 'test-utils/**/*.{js,mjs,cjs,ts,tsx,mts,cts}', 'site/*.{js,mjs}', 'site/shell-adapters/**/*.js', '.github/actions/**/*.{js,mjs,cjs,mts,cts}', '*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}', 'exes/**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
  },
};
for (const pkg of packages) {
  const directory = relative(root, pkg.dir).replaceAll('\\', '/');
  workspaces[directory] = {
    entry: [...htmlEntries(pkg.dir, generatedHtmlScripts[directory]), ...commandEntries, ...testEntries, '*.config.{js,mjs,cjs,ts,mts,cts}'],
    project: [source, ...projectExclusions],
  };
}

// These modules are requested by filename at runtime, outside the import graph.
workspaces['packages/runtime-support'].entry.push('src/niimath/worker.js', 'src/freebrowse-viewer/static.js');
workspaces['packages/components'].entry.push('web/js/showcase.js', 'templates/*/main.js');
workspaces['packages/desktop'].entry.push('src/main.js', 'neuroflow/runtime/neurodesk.mjs');
workspaces['apps/dicompare'].entry.push('electron/main.ts');
workspaces['site/easter-eggs/vessel-surfer-leaderboard'].entry.push('src/worker.js');

for (const app of ['seedseg', 'musclemap', 'vesselboost', 'spinalcordtoolbox']) {
  workspaces[`apps/${app}`].entry.push('web/js/inference-worker.js');
}
workspaces['apps/qsmbly'].entry.push('js/qsm-worker-pure.js');
workspaces['apps/qsmbly'].project.push('!niivue/**');
workspaces['packages/vesselboost'].project.push('!preprocessing/**');
workspaces['packages/easy-mp2rage'].project.push('!wasm/**');
workspaces['packages/nesvor'].entry.push('src/**/verify*.mjs', 'src/**/compare*.mjs', 'src/deformation/fixture.mjs');
workspaces['apps/surfannotate'].entry.push('icon/render.mjs');
// Release synchronization reads and updates these version records by filename.
for (const app of ['topofit', 'zarro']) {
  workspaces[`apps/${app}`].entry.push('src/config.js');
}

// Public dist APIs may be compiled from JavaScript or TypeScript source.
for (const pkg of packages) {
  const workspace = workspaces[relative(root, pkg.dir).replaceAll('\\', '/')];
  workspace.entry.push(...publishedSourceEntries(pkg.dir, pkg.packageJson.exports));
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

validateLiteralEntries(root, workspaces);
validateProjectExclusions(workspaces);

export default {
  workspaces,
  include: ['files', 'exports', 'types', 'duplicates', 'dependencies', 'devDependencies'],
  ignoreExportsUsedInFile: true,
  ignoreIssues: { '**/*.d.ts': ['files'] },
};
