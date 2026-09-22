export default [
  { ignores: ['dist/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, // 'latest' parses import attributes
    rules: {},
  },
];
