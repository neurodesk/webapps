/**
 * Jest Configuration for QSM-WASM
 */
export default {
  testEnvironment: 'node',
  roots: ['<rootDir>/js'],
  testMatch: ['**/*.test.js'],
  moduleFileExtensions: ['js'],
  transform: {},
  setupFilesAfterEnv: ['<rootDir>/js/test/setup.js'],
  collectCoverageFrom: [
    'js/**/*.js',
    '!js/test/**',
    '!js/**/index.js',
    '!js/qsm-worker-pure.js',
    '!js/qsm-app-romeo.js'
  ],
  coverageDirectory: 'coverage',
  verbose: true
};
