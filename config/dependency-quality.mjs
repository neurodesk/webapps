// Generated runtimes contain conditional Node branches and bundled dependencies.
// Their staging and offline checks own validation; keep exclusions at exact paths.
export const generatedSources = {
  'apps/dicom2vid/web/js/vendor/': 'Pinned third-party viewer and muxer bundles.',
  'apps/dwi2trx/vendor/niimath/': 'Vendored Emscripten dtifit build.',
  'packages/easy-mp2rage/wasm/mp2rage_wasm.js': 'Committed wasm-bindgen glue.',
  'packages/nii2tvx/wasm/nii2tvx.mjs': 'Committed Emscripten glue.',
  'packages/registration/wasm/syncro-registration.mjs': 'Committed Emscripten glue.',
  'packages/runtime-support/src/dcm2niix/dcm2niix.js': 'Committed Emscripten glue.',
  'packages/runtime-support/src/niimath/niimath.js': 'Committed Emscripten glue.',
  'packages/vesselboost/preprocessing/preprocessing.js': 'Committed wasm-bindgen glue.',
  'packages/runtime-support/src/nifti-js/index.js': 'Self-contained bundled NIfTI parser with embedded CommonJS modules.',
};

export function isGenerated(path) {
  return Object.keys(generatedSources).some((prefix) => prefix.endsWith('/') ? path.startsWith(prefix) : path === prefix);
}

export function isTooling(path) {
  return /(^|\/)(test|tests|e2e)\//.test(path)
    || /^(apps|packages)\/[^/]+\/(validation|scripts|tools|templates|icon)\//.test(path)
    || /\.(test|spec)\.[cm]?[jt]sx?$/.test(path)
    || /(^|\/)(verify[^/]*|setupTests)\.[cm]?[jt]sx?$/.test(path)
    || /^(apps|packages)\/[^/]+\/[^/]*\.config\.[cm]?[jt]s$/.test(path)
    || path === 'packages/desktop/neuroflow/generator.mjs';
}

export function isProduction(path) {
  return /^(apps|packages)\//.test(path) && !isTooling(path) && !isGenerated(path);
}

export const uiModules = /^packages\/components\/src\/(ui|elements|viewer|core)\//;
export const pureModules = /^packages\/components\/src\/(volume|pipeline|qsm)\//;
export const browserModules = /^packages\/runtime-support\/src\/|^packages\/[^/]+\/src\/browser(?:[.-][^/]*)?\.[cm]?[jt]s$/;
export const nodeModules = /^packages\/(node-drivers|desktop)\/(src|neuroflow\/runtime)\/|^packages\/[^/]+\/src\/node(?:[.-][^/]*)?\.[cm]?[jt]s$/;

// Browser exports intentionally use devDependencies so portable Node installs do
// not acquire the browser runtime. These are exact existing adapters, not a
// package-wide exemption for new imports.
export const devRuntimeContracts = [
  ['packages/synthsr/src/gpu-session.js', '@neurodesk/runtime-support'],
  ['packages/synthsr/src/gpu-conv3d.js', '@neurodesk/runtime-support'],
  ['packages/synthsr/src/wasm-session.js', '@neurodesk/runtime-support'],
  ['packages/synthstrip/src/browser.js', '@neurodesk/runtime-support'],
  ['packages/synthseg/src/browser.js', '@neurodesk/runtime-support'],
  ['packages/desktop/src/main.js', 'electron'],
  ['apps/dicompare/electron/main.ts', 'electron'],
  ['apps/dicompare/electron/preload.ts', 'electron'],
  ['apps/dicompare/electron/main.ts', '@electron-toolkit/utils'],
];

export const sourceMirrors = {
  'apps/qsmbly/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/calmar/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/dicom2vid/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/easy-mp2rage/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/musclemap/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/seedseg/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/spinalcordtoolbox/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/vesselboost/web/vendor/webapp-components/src/': 'packages/components/src/',
  'apps/calmar/web/vendor/calmar/src/': 'packages/calmar/src/',
  'apps/easy-mp2rage/web/vendor/easy-mp2rage/': 'packages/easy-mp2rage/',
  'apps/musclemap/web/vendor/musclemap/src/': 'packages/musclemap/src/',
  'apps/seedseg/web/vendor/seedseg/src/': 'packages/seedseg/src/',
  'apps/vesselboost/web/vendor/vesselboost/src/': 'packages/vesselboost/src/',
};

export const cruiseOptions = {
  outputType: 'json',
  preserveSymlinks: false,
  parser: 'swc',
  tsPreCompilationDeps: 'specify',
  combinedDependencies: false,
  doNotFollow: { path: [
    '(^|/)node_modules/',
    ...Object.keys(generatedSources).map((path) => `^${path.replaceAll('.', '\\.')}${path.endsWith('/') ? '' : '$'}`),
    ...Object.keys(sourceMirrors).map((path) => `^${path}`),
  ] },
};

export const resolveOptions = {
  symlinks: true,
  extensions: ['.js', '.mjs', '.cjs', '.json', '.ts', '.tsx', '.mts', '.cts'],
  conditionNames: ['import', 'require', 'node', 'default'],
  exportsFields: ['exports'],
};
