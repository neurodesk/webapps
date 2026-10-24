// The modules Stryker mutates. Each one is a separate Stryker run against only
// the Node suite that specifies it: the command runner cannot map tests to
// files, so a shared run would execute every suite for every mutant.
export const modules = [
  {
    id: 'disconnectome',
    file: 'packages/nii2tvx/src/disconnectome.js',
    mutate: 'packages/nii2tvx/src/disconnectome.js',
    files: ['packages/nii2tvx/package.json', 'packages/nii2tvx/test/disconnectome.test.js'],
    command: 'node --test packages/nii2tvx/test/disconnectome.test.js',
  },
  {
    id: 'basis-select',
    file: 'packages/lcmodel/src/basis-select.js',
    mutate: 'packages/lcmodel/src/basis-select.js',
    files: ['packages/lcmodel/package.json', 'packages/lcmodel/test/basis-select.test.js'],
    command: 'node --test packages/lcmodel/test/basis-select.test.js',
  },
  {
    // formatG only: the rest of index.js drives the WebAssembly module.
    id: 'format-g',
    file: 'packages/nii2tvx/src/index.js',
    mutate: 'packages/nii2tvx/src/index.js:24-35',
    files: ['packages/nii2tvx/package.json', 'packages/nii2tvx/wasm/nii2tvx.mjs', 'packages/nii2tvx/test/parity.test.js'],
    command: 'node --test --test-name-pattern=printf packages/nii2tvx/test/parity.test.js',
  },
  {
    // The date arithmetic only: the rest of app-versions.mjs drives Changesets on a workspace.
    id: 'date-versions',
    file: 'scripts/lib/app-versions.mjs',
    mutate: 'scripts/lib/app-versions.mjs:50-79',
    files: ['scripts/lib/apps-registry.mjs', 'test/date-versions.test.mjs'],
    command: 'node --test test/date-versions.test.mjs',
  },
  {
    id: 'lockfile-impact',
    file: 'scripts/lib/lockfile-impact.mjs',
    mutate: 'scripts/lib/lockfile-impact.mjs',
    files: ['test/lockfile-impact.test.mjs'],
    command: 'node --test test/lockfile-impact.test.mjs',
  },
  {
    id: 'carotid-series',
    file: 'packages/carotid-flow/src/series.js',
    mutate: 'packages/carotid-flow/src/series.js',
    files: ['packages/carotid-flow/package.json', 'packages/carotid-flow/src/carotid.js', 'packages/carotid-flow/src/outputs.js', 'packages/carotid-flow/test/series-outputs.test.js'],
    command: 'node --test packages/carotid-flow/test/series-outputs.test.js',
  },
  {
    id: 'carotid-outputs',
    file: 'packages/carotid-flow/src/outputs.js',
    mutate: 'packages/carotid-flow/src/outputs.js',
    files: ['packages/carotid-flow/package.json', 'packages/carotid-flow/src/carotid.js', 'packages/carotid-flow/src/series.js', 'packages/carotid-flow/test/series-outputs.test.js'],
    command: 'node --test packages/carotid-flow/test/series-outputs.test.js',
  },
  {
    id: 'workspace-graph',
    file: 'scripts/lib/workspace-graph.mjs',
    mutate: 'scripts/lib/workspace-graph.mjs',
    files: ['test/workspace-graph.test.mjs'],
    command: 'node --test test/workspace-graph.test.mjs',
  },
  {
    id: 'lcmodel-tissue',
    file: 'packages/lcmodel/src/tissue.js',
    mutate: 'packages/lcmodel/src/tissue.js',
    files: ['packages/lcmodel/package.json', 'packages/lcmodel/test/tissue.test.js'],
    command: 'node --test packages/lcmodel/test/tissue.test.js',
  },
  {
    // Everything but fillGaps, the last function: instrumenting its Fourier
    // sums makes every run of the suite take seconds instead of 0.2 s.
    id: 'lcmodel-io',
    file: 'packages/lcmodel/src/lcmodel-io.js',
    mutate: 'packages/lcmodel/src/lcmodel-io.js:1-321',
    files: [
      'packages/lcmodel/package.json',
      'packages/lcmodel/src/inputs.js',
      'packages/lcmodel/src/spectrum-plot.js',
      'packages/lcmodel/test/lcmodel-io.test.js',
      'packages/lcmodel/test/data/siemens-megapress.coord.gz',
      'packages/lcmodel/test/data/siemens-megapress.raw.gz',
      'exes/lcmodel/tests/data/test_lcm/native.coord',
      'exes/lcmodel/tests/data/test_lcm/native.table',
    ],
    command: 'node --test packages/lcmodel/test/lcmodel-io.test.js',
  },
  {
    // Without the oblique-volume tests (64^3 and 40^3 grids) and the grid-orientation test, which dominate an instrumented run.
    id: 'lcmodel-voxel',
    file: 'packages/lcmodel/src/voxel.js',
    mutate: 'packages/lcmodel/src/voxel.js',
    files: ['packages/lcmodel/package.json', 'packages/lcmodel/test/voxel.test.js'],
    command: 'node --test --test-skip-pattern=oblique --test-skip-pattern=oriented packages/lcmodel/test/voxel.test.js',
  },
];

// The PR canary: tableName, a small naming function in the first module.
export const smoke = { module: 'disconnectome', mutate: 'packages/nii2tvx/src/disconnectome.js:10-12' };

export const output = 'quality-artifacts/mutations';

export function moduleById(id) {
  const module = modules.find((candidate) => candidate.id === id);
  if (!module) throw new Error(`Set MUTATION_MODULE to one of ${modules.map((candidate) => candidate.id).join(', ')}; pnpm quality:mutations runs each in turn`);
  return module;
}

export function strykerConfig(module) {
  return {
    mutate: [module.mutate],
    ignorePatterns: ['**', '!package.json', ...[module.file, ...module.files].map((path) => `!${path}`)],
    testRunner: 'command',
    allowConsoleColors: false,
    clearTextReporter: { allowColor: false },
    commandRunner: { command: module.command },
    coverageAnalysis: 'off',
    concurrency: 2,
    timeoutMS: 5000,
    timeoutFactor: 2,
    reporters: ['clear-text', 'json', 'html'],
    jsonReporter: { fileName: `${output}/${module.id}/mutation.json` },
    htmlReporter: { fileName: `${output}/${module.id}/index.html` },
    thresholds: { high: 80, low: 60, break: null },
    tempDirName: '.stryker-tmp',
    cleanTempDir: 'always',
  };
}
