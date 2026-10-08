// Flat ESLint config so `pnpm lint` works out of the box in a scaffolded app.
export default [
  {
    files: ["**/*.js"],
    languageOptions: { ecmaVersion: 2022, sourceType: "module" },
    rules: {},
  },
];
