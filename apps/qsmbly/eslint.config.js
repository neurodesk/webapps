// ESLint flat config. Run with `npm run lint`; CI runs the same command.
import js from '@eslint/js';
import globals from 'globals';

export default [
  {
    // Vendored third-party code and build outputs are not ours to lint.
    ignores: [
      'nifti-js/**',
      'dcm2niix/**',
      'coi-serviceworker.js',
      'wasm/**',
      'rust-wasm/**',
      'coverage/**',
      'deploy/**',
    ],
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
    rules: {
      'no-undef': 'error',
      // Warn rather than error while dead-code cleanups are still landing; tighten once clean.
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }],
      // Style-level findings in files other branches are editing; warn so they surface without
      // failing CI, and promote to errors once the existing hits are gone.
      'no-useless-escape': 'warn',
      'no-case-declarations': 'warn',
    },
  },
  {
    // The app and everything it imports runs in the page, and parts of it in the module worker.
    files: ['js/**/*.js'],
    ignores: ['js/qsm-worker-pure.js'],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.worker,
        // Loaded from a <script> tag in index.html.
        Tagify: 'readonly',
      },
    },
  },
  {
    files: ['js/qsm-worker-pure.js', 'scripts/bench-dl-threading/worker.js'],
    languageOptions: {
      globals: { ...globals.worker },
    },
  },
  {
    files: ['js/**/*.test.js', 'js/test/**/*.js'],
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
    },
  },
  {
    files: ['*.js', 'scripts/**/*.mjs'],
    languageOptions: {
      globals: { ...globals.node },
    },
  },
];
