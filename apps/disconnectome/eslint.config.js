export default [
  { ignores: ['dist/**', 'public/template/**'] },
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module' }, // 'latest' parses import attributes
    rules: {},
  },
];
