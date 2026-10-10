import js from '@eslint/js';
import tsParser from '@neurodesk/code-quality';
import globals from 'globals';

// Correctness only. Existing findings are reviewed in scripts/quality/lint-baseline.json.
// The inventory runner checks every tracked source, including files hidden by an ignore.
export default [
  {
    files: ['**/*.{js,mjs,cjs,jsx,ts,tsx,mts,cts}'],
    linterOptions: { noInlineConfig: true },
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser, ...globals.node },
    },
    rules: {
      ...js.configs.recommended.rules,
      // Unused bindings are maintenance work, not a correctness gate.
      'no-unused-vars': 'off',
    },
  },
  {
    // QSMbly's Jest config enables globals for js/**/*.test.js.
    files: ['apps/qsmbly/js/**/*.test.js'],
    languageOptions: { globals: globals.jest },
  },
  {
    // Shared automation is installed on window before page.evaluate callbacks.
    files: ['apps/*/e2e/**', 'packages/*/validation/browser-reference.mjs'],
    languageOptions: { globals: { neurodeskAutomation: 'readonly', app: 'readonly' } },
  },
  {
    // The app test injects this stage recorder with globalThis.
    files: ['apps/calmar/e2e/automation.spec.js'],
    languageOptions: { globals: { __calmarCandidateStages: 'writable' } },
  },
  {
    // Classic script tags load NiiVue's UMD distribution before these entry points.
    files: ['apps/{calmar,musclemap,seedseg,vesselboost}/web/js/*-app.js'],
    languageOptions: { globals: { niivue: 'readonly' } },
  },
  {
    files: ['apps/qsmbly/js/controllers/QsmInputSet.js'],
    // Tagify is loaded by the QSMbly page's script tag.
    languageOptions: { globals: { Tagify: 'readonly' } },
  },
  {
    // importScripts loads Pyodide before this worker uses its factory.
    files: ['apps/dicompare/public/embed/dicompare-worker.js'],
    languageOptions: { globals: { loadPyodide: 'readonly' } },
  },
  {
    // This browser validation loads ORT through a script tag.
    files: ['apps/musclemap/scripts/validate_browser_model.mjs'],
    languageOptions: { globals: { ort: 'readonly' } },
  },
  {
    // scripts/package-plugin.mjs substitutes this Vite constant at build time.
    files: ['apps/synthsr/src/main.js'],
    languageOptions: { globals: { __SYNTHSR_NATIVE_VERSION__: 'readonly' } },
  },
  {
    // gpu-kernel.spec.js prepends conv3d.js to its serialized test function.
    files: ['apps/synthsr/e2e/gpu-kernel.spec.js'],
    languageOptions: { globals: { packConvWeights: 'readonly', conv3dShader: 'readonly', conv3dDispatch: 'readonly' } },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: { parser: tsParser },
    // TypeScript resolves imported types and ambient declarations.
    rules: { 'no-undef': 'off' },
  },
  {
    files: ['**/*.{cjs,cts}'],
    languageOptions: { sourceType: 'commonjs' },
  },
  {
    files: ['**/*worker*.{js,mjs,ts}', '**/*Worker*.{js,mjs,ts}'],
    ignores: ['**/{test,e2e,validation}/**', '**/*.test.*', '**/*worker-client*', 'packages/runtime-support/src/coi-serviceworker.js'],
    languageOptions: { globals: { window: 'off', document: 'off', ...globals.worker } },
    rules: {
      'no-restricted-globals': ['error', 'window', 'document'],
    },
  },
];
