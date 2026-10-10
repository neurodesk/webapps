const target = 'packages/nii2tvx/src/disconnectome.js';
const tests = 'packages/nii2tvx/test/disconnectome.test.js';

export default {
  mutate: [target],
  ignorePatterns: ['**', '!package.json', '!packages/nii2tvx/package.json', `!${target}`, `!${tests}`],
  testRunner: 'command',
  allowConsoleColors: false,
  clearTextReporter: { allowColor: false },
  commandRunner: { command: `node --test ${tests}` },
  coverageAnalysis: 'off',
  concurrency: 2,
  timeoutMS: 5000,
  timeoutFactor: 2,
  reporters: ['clear-text', 'json', 'html'],
  jsonReporter: { fileName: 'quality-artifacts/mutations/mutation.json' },
  htmlReporter: { fileName: 'quality-artifacts/mutations/index.html' },
  thresholds: { high: 80, low: 60, break: null },
  tempDirName: '.stryker-tmp',
  cleanTempDir: 'always',
};
